import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 1_000;

function isLoopbackAddress(address) {
  if (address === "::1") return true;
  const ipv4 = address?.startsWith("::ffff:") ? address.slice(7) : address;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipv4 ?? "")) return false;
  const octets = ipv4.split(".").map(Number);
  return octets[0] === 127 && octets.every((octet) => octet <= 255);
}

function readBearerAuthorization(secretFile) {
  if (!secretFile || !isAbsolute(secretFile)) {
    throw new Error("A required absolute sidecar secret-file path was not provided");
  }

  let metadata;
  let raw;
  try {
    metadata = lstatSync(secretFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("invalid file");
    const effectiveUid = process.getuid?.();
    if (process.platform !== "win32" && (metadata.uid !== effectiveUid || (metadata.mode & 0o077) !== 0)) {
      throw new Error("insecure file");
    }
    if (metadata.size < 64 || metadata.size > 66) throw new Error("invalid size");
    raw = readFileSync(secretFile);
  } catch {
    throw new Error("Unable to read a root-only sidecar secret file");
  }

  let length = raw.length;
  if (length > 0 && raw[length - 1] === 0x0a) length -= 1;
  if (length > 0 && raw[length - 1] === 0x0d) length -= 1;
  const valid =
    length === 64 &&
    raw.subarray(0, length).every((byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66));
  if (!valid) {
    raw.fill(0);
    throw new Error("The sidecar secret file has an invalid format");
  }

  const authorization = Buffer.concat([Buffer.from("Bearer "), raw.subarray(0, length)]);
  raw.fill(0);
  return authorization;
}

function hasValidAuthorization(value, expected) {
  const supplied = Buffer.from(typeof value === "string" ? value : "");
  const candidate = Buffer.alloc(expected.length);
  supplied.copy(candidate, 0, 0, expected.length);
  const valid = timingSafeEqual(candidate, expected) && supplied.length === expected.length;
  supplied.fill(0);
  candidate.fill(0);
  return valid;
}

function sendJson(response, statusCode, message, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

function readJsonBody(request) {
  if (request.aborted || request.destroyed) return Promise.reject(new Error("Request aborted"));
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    request.resume();
    return Promise.resolve({ tooLarge: true });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        request.resume();
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ invalid: true });
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new Error("Request aborted"));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function authorityFor(host, port) {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Start an authenticated, loopback-only Streamable HTTP MCP endpoint. */
export async function startAuthenticatedStreamableHttp(
  mcpServer,
  { secretFile, host = "127.0.0.1", port = 3000, socketPath, publicHost } = {},
) {
  if (socketPath) {
    if (!isAbsolute(socketPath)) throw new Error("Streamable HTTP socket path must be absolute");
    if (!publicHost) throw new Error("Streamable HTTP public Host is required for a Unix socket");
  } else {
    if (!isLoopbackAddress(host)) throw new Error("Streamable HTTP host must be a loopback IP address");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Streamable HTTP port");
  }

  const expectedAuthorization = readBearerAuthorization(secretFile);
  let expectedHost;
  let closing = false;
  let closePromise;
  let activeTransport;
  let initializeQueue = Promise.resolve();

  const httpServer = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (request, response) => {
    if (closing) {
      sendJson(response, 503, "Server shutting down");
      return;
    }
    if (!socketPath && !isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, "Forbidden");
      return;
    }
    if (request.headers.host !== expectedHost) {
      sendJson(response, 400, "Invalid Host header");
      return;
    }
    if (Object.hasOwn(request.headers, "origin")) {
      sendJson(response, 403, "Origin header is not allowed");
      return;
    }
    if (request.url !== MCP_PATH) {
      sendJson(response, 404, "Not found");
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      sendJson(response, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    if (!hasValidAuthorization(request.headers.authorization, expectedAuthorization)) {
      request.resume();
      sendJson(response, 401, "Unauthorized", { "www-authenticate": "Bearer" });
      return;
    }

    try {
      const parsed = await readJsonBody(request);
      if (parsed.tooLarge) {
        sendJson(response, 413, "Request body too large");
        return;
      }
      if (parsed.invalid) {
        sendJson(response, 400, "Invalid JSON request body");
        return;
      }
      if (isInitializeRequest(parsed.body)) {
        const initialize = async () => {
          if (activeTransport) await activeTransport.close();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
          });
          transport.onclose = () => {
            if (activeTransport === transport) activeTransport = undefined;
          };
          await mcpServer.connect(transport);
          activeTransport = transport;
          await transport.handleRequest(request, response, parsed.body);
        };
        const currentInitialize = initializeQueue.then(initialize);
        initializeQueue = currentInitialize.catch(() => {});
        await currentInitialize;
        return;
      }

      if (!activeTransport) {
        sendJson(response, 400, "MCP session is not initialized");
        return;
      }
      await activeTransport.handleRequest(request, response, parsed.body);
    } catch {
      if (!response.headersSent) sendJson(response, 500, "Internal server error");
      else response.destroy();
    }
  });

  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = 5_000;
  httpServer.keepAliveTimeout = 5_000;

  try {
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      if (socketPath && existsSync(socketPath)) {
        const metadata = lstatSync(socketPath);
        if (!metadata.isSocket() || metadata.isSymbolicLink()) {
          reject(new Error("Refusing to replace a non-socket sidecar path"));
          return;
        }
        unlinkSync(socketPath);
      }
      const onListen = () => {
        httpServer.off("error", reject);
        if (socketPath) chmodSync(socketPath, 0o600);
        resolve();
      };
      if (socketPath) httpServer.listen(socketPath, onListen);
      else httpServer.listen(port, host, onListen);
    });
  } catch (error) {
    expectedAuthorization.fill(0);
    await mcpServer.close().catch(() => {});
    throw error;
  }

  const address = httpServer.address();
  expectedHost = socketPath ? publicHost : authorityFor(host, address.port);

  return {
    host,
    port: socketPath ? undefined : address.port,
    socketPath,
    path: MCP_PATH,
    async close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        try {
          const closed = new Promise((resolve, reject) => {
            httpServer.close((error) => (error ? reject(error) : resolve()));
            httpServer.closeIdleConnections?.();
          });
          await mcpServer.close();
          await Promise.race([
            closed,
            new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
          ]);
          httpServer.closeAllConnections?.();
          await initializeQueue.catch(() => {});
        } finally {
          expectedAuthorization.fill(0);
          if (socketPath) {
            try { unlinkSync(socketPath); } catch {}
          }
        }
      })();
      return closePromise;
    },
  };
}

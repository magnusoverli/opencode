import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createConnection } from "node:net";
import { once } from "node:events";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

export const LSP_SOCKET = "/run/opencode-v2/lsp.sock";
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
const WORKSPACE = "/homeassistant";

export function documentPath(input, root = WORKSPACE) {
  if (typeof input !== "string" || input.includes("\0") || input.includes("\\")) throw new Error("A YAML path is required");
  const path = posix.resolve(root, input);
  if (!path.startsWith(`${root}/`) || !/\.ya?ml$/.test(path)) throw new Error("LSP files must be YAML inside the Home Assistant workspace");
  const parts = path.slice(root.length + 1).split("/");
  if (parts.some((part) => [".storage", ".cloud", "ssl", "secrets.yaml", "secrets.yml"].includes(part))) {
    throw new Error("LSP access to sensitive files is denied");
  }
  return path;
}

export async function readDocument(input, text, root = WORKSPACE) {
  const path = documentPath(input, root);
  if (text !== undefined) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error("LSP document exceeds its size limit");
    return { path, text };
  }
  const handles = [];
  try {
    // Directory descriptors anchor every component, including during rename races.
    let parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    const parts = path.slice(root.length + 1).split("/");
    for (const part of parts.slice(0, -1)) {
      parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    const file = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw new Error("LSP requires a bounded regular YAML file");
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_DOCUMENT_BYTES) throw new Error("LSP document exceeds its size limit");
    return { path, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await Promise.all(handles.map((file) => file.close()));
  }
}

export async function requestLsp(method, document, position, signal, socketPath = LSP_SOCKET) {
  const deadline = AbortSignal.timeout(15000);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  cancellation.throwIfAborted();
  const socket = createConnection(socketPath);
  let connection;
  const abort = () => {
    // Closing the stream alone does not settle vscode-jsonrpc's pending calls.
    connection?.dispose();
    socket.destroy(new Error("LSP request cancelled"));
  };
  socket.on("error", () => {});
  cancellation.addEventListener("abort", abort, { once: true });
  try {
    await once(socket, "connect", { signal: cancellation });
    cancellation.throwIfAborted();
    connection = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    connection.onClose(() => connection.dispose());
    connection.onNotification("window/logMessage", () => {});
    connection.onNotification("textDocument/publishDiagnostics", () => {});
    connection.listen();
    await connection.sendRequest("initialize", { processId: null, rootUri: pathToFileURL(WORKSPACE).href, capabilities: {} });
    await connection.sendNotification("initialized", {});
    let result;
    if (method === "homeassistant/health") {
      result = await connection.sendRequest(method);
    } else {
      const uri = pathToFileURL(document.path).href;
      await connection.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "yaml", version: 1, text: document.text } });
      result = await connection.sendRequest(method, { textDocument: { uri }, ...(position ? { position } : {}) });
      await connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
    await connection.sendRequest("shutdown");
    await connection.sendNotification("exit");
    return result;
  } finally {
    cancellation.removeEventListener("abort", abort);
    connection?.dispose();
    socket.destroy();
  }
}

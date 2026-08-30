import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";

const requestSignals = new AsyncLocalStorage();

export function withRequestSignal(signal, operation) {
  return requestSignals.run(signal, operation);
}

export function getRequestSignal() {
  return requestSignals.getStore();
}

export function cancellationError(reason = "Operation cancelled") {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "Operation cancelled");
  error.name = "AbortError";
  return error;
}

export function throwIfRequestCancelled() {
  const signal = getRequestSignal();
  if (signal?.aborted) throw cancellationError(signal.reason);
}

export function createOperationSignal(timeoutMs, parentSignal = getRequestSignal()) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(cancellationError(parentSignal.reason));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    const error = new Error(`Operation timed out after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (fallbackError.code !== "ESRCH") throw fallbackError;
    }
  }
}

export function runCancellableExecFile(
  file,
  args,
  { timeoutMs, killGraceMs = 1_000, ...options },
  parentSignal = getRequestSignal(),
) {
  const operation = createOperationSignal(timeoutMs, parentSignal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer;
    const child = execFile(file, args, { ...options, detached: true }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      operation.cleanup();
      operation.signal.removeEventListener("abort", onAbort);
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });

    const onAbort = () => {
      if (settled) return;
      settled = true;
      operation.cleanup();
      signalProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        try {
          signalProcessGroup(child, "SIGKILL");
        } catch {
          // The process may have exited between the group check and signal.
        }
      }, killGraceMs);
      killTimer.unref?.();
      reject(cancellationError(operation.signal.reason));
    };

    operation.signal.addEventListener("abort", onAbort, { once: true });
    if (operation.signal.aborted) onAbort();
  });
}

// JSON-RPC 2.0 over newline-delimited JSON: one message on each line.
//
// The peer answers requests with the registered handlers and sends notifications. A handler
// gets the params and an AbortSignal. "$/cancel" with {id} aborts the signal of that request.

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const REQUEST_CANCELLED = -32800;

export class RpcPeer {
  /**
   * @param {NodeJS.ReadableStream} input - the stream of incoming lines.
   * @param {(line: string) => void} write - writes one outgoing line (without the newline).
   */
  constructor(input, write) {
    this.write = write;
    this.handlers = new Map();
    this.running = new Map(); // Request id -> AbortController.
    this.outgoing = new Map(); // Id of a request to the daemon -> { resolve, reject }.
    this.nextId = 1;
    this.closed = new Promise((resolve) => (this._resolveClosed = resolve));
    let buffer = "";
    input.setEncoding?.("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this._receive(line);
      }
    });
    const closed = () => {
      for (const waiting of this.outgoing.values()) waiting.reject(new RpcError(INTERNAL_ERROR, "The daemon closed the connection."));
      this.outgoing.clear();
      this._resolveClosed();
    };
    input.on("end", closed);
    input.on("close", closed);
  }

  /** Register a handler: async (params, signal) => result. */
  on(method, handler) {
    this.handlers.set(method, handler);
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  /** Send a request to the daemon, for example "approval.request". An abort sends "$/cancel". */
  request(method, params, signal) {
    const id = `host-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.outgoing.delete(id);
        this.notify("$/cancel", { id });
        reject(signal.reason ?? new RpcError(REQUEST_CANCELLED, "The request was cancelled."));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.outgoing.set(id, {
        resolve: (value) => (signal?.removeEventListener("abort", onAbort), resolve(value)),
        reject: (error) => (signal?.removeEventListener("abort", onAbort), reject(error)),
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  _send(message) {
    try {
      this.write(JSON.stringify(message));
    } catch (error) {
      process.stderr.write(`rpc: cannot send a message: ${error?.stack ?? error}\n`);
    }
  }

  _receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (message.method === "$/cancel") {
      this.running.get(message.params?.id)?.abort(new RpcError(REQUEST_CANCELLED, "The request was cancelled."));
      return;
    }
    if (typeof message.method !== "string") {
      // A response to a request of the host.
      const waiting = this.outgoing.get(message.id);
      if (!waiting) return;
      this.outgoing.delete(message.id);
      if (message.error) waiting.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else waiting.resolve(message.result);
      return;
    }
    const handler = this.handlers.get(message.method);
    const isRequest = message.id !== undefined && message.id !== null;
    if (!handler) {
      if (isRequest) this._send({ jsonrpc: "2.0", id: message.id, error: { code: METHOD_NOT_FOUND, message: `Unknown method: ${message.method}` } });
      return;
    }
    const controller = new AbortController();
    if (isRequest) this.running.set(message.id, controller);
    Promise.resolve()
      .then(() => handler(message.params ?? {}, controller.signal))
      .then(
        (result) => {
          if (isRequest) this._send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
        },
        (error) => {
          if (!isRequest) {
            process.stderr.write(`rpc: notification ${message.method} failed: ${error?.stack ?? error}\n`);
            return;
          }
          const code = error instanceof RpcError ? error.code : controller.signal.aborted ? REQUEST_CANCELLED : INTERNAL_ERROR;
          this._send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code, message: error?.message ?? String(error), ...(error?.data !== undefined ? { data: error.data } : {}) },
          });
        },
      )
      .finally(() => this.running.delete(message.id));
  }
}

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export class McpProcessClient extends EventEmitter {
  constructor({ command, args = [], env = {}, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env };
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.started = false;
    this.stderrTail = "";
  }

  async start() {
    if (this.started) return;
    if (!this.command) throw new Error("MCP command is required.");
    this.child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.started = true;
    this.child.stdout.on("data", chunk => this.#consume(chunk));
    this.child.stderr.on("data", chunk => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-2000);
      this.emit("stderr", chunk.toString());
    });
    this.child.on("error", error => this.#failAll(new Error(`MCP process error: ${error.message}`)));
    this.child.on("exit", (code, signal) => {
      if (this.started) {
        const tail = this.stderrTail.replace(/(token|secret|authorization|bearer)\\s*[=:]\\s*[^\\s]+/gi, "$1=<redacted>");
        this.#failAll(new Error(`MCP process exited (code=${code ?? "null"}, signal=${signal ?? "null"}).${tail ? ` stderr=${tail.trim()}` : ""}`));
      }
      this.emit("exit", { code, signal });
    });
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    await this.start();
    if (!this.child?.stdin?.writable) throw new Error("MCP process is not writable.");
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error("MCP process is not writable.");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close() {
    if (!this.child) return;
    this.started = false;
    this.#failAll(new Error("MCP client closed."));
    this.child.kill();
    this.child = null;
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.#failAll(new Error("MCP response exceeded the size limit."));
      this.buffer = Buffer.alloc(0);
      return;
    }
    while (this.buffer.length) {
      const framedEnd = this.buffer.indexOf(Buffer.from("\r\n\r\n"));
      const newline = this.buffer.indexOf(10);
      if (framedEnd >= 0 && (newline < 0 || framedEnd < newline)) {
        const header = this.buffer.subarray(0, framedEnd).toString("ascii");
        const match = header.match(/(?:^|\r\n)Content-Length\s*:\s*(\d+)/i);
        if (!match) return this.emit("protocolError", new Error("Invalid MCP Content-Length header."));
        const length = Number(match[1]);
        const start = framedEnd + 4;
        if (this.buffer.length < start + length) return;
        const body = this.buffer.subarray(start, start + length).toString("utf8");
        this.buffer = this.buffer.subarray(start + length);
        this.#handleBody(body);
        continue;
      }
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.#handleBody(line);
    }
  }

  #handleBody(body) {
    let message;
    try { message = JSON.parse(body); } catch { return this.emit("protocolError", new Error("Invalid MCP JSON response.")); }
    if (message.id === undefined || message.id === null) return this.emit("notification", message);
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  #failAll(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
}

export async function createMinitokClient({ tokenFile, scopes = "read,write,verify_exec", serverUrl, cwd = process.cwd(), command = process.execPath, entry, timeoutMs } = {}) {
  if (!tokenFile) throw new Error("MCP runtime token file is required. Run `minitok mcp token` first.");
  const resolvedEntry = entry || process.env.MINITOK_MCP_ENTRY;
  if (!resolvedEntry) throw new Error("MCP stdio entry is required.");
  const client = new McpProcessClient({
    command,
    args: [resolvedEntry],
    cwd,
    timeoutMs,
    env: { MINITOK_MCP_AUTH_TOKEN_FILE: tokenFile, MINITOK_MCP_SCOPES: scopes, ...(serverUrl ? { minitok_server_url: serverUrl } : {}) },
  });
  await client.start();
  const initialized = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "@flotic/minitok-agent", version: "1.0.0" },
  });
  client.notify("notifications/initialized");
  return { client, initialized };
}

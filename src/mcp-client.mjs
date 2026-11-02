/**
 * CloudClaw — MCP stdio client adapter
 *
 * Spawns a standard Model Context Protocol server over stdio, performs the
 * JSON-RPC handshake, exposes its tools in OpenAI function-calling format and
 * executes tool calls. Also provides `runToolLoop` — the cloud-routed agent
 * loop that binds inference to local tools.
 *
 * Hardened behaviours:
 *  - newline-delimited JSON-RPC (the stdio transport MCP servers speak)
 *  - per-request timeouts; pending requests rejected if the child dies
 *  - stderr captured into a bounded ring buffer instead of leaking to console
 *  - tool names sanitized/validated before being offered to the model
 *  - tool results truncated so one huge file cannot blow the context window
 *  - a tool error becomes a tool message (model can recover), never a crash
 */

import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_CHARS = 32_000;
const PROTOCOL_VERSION = "2024-11-05";

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export class StdioMCPClient {
  /**
   * @param {Object} opts {command, args, env, cwd, name, requestTimeoutMs, maxStderrBytes, log}
   */
  constructor(opts = {}) {
    const command = typeof opts === "string" ? opts : opts.command;
    if (!command) throw new TypeError("StdioMCPClient requires a command");

    this.command = command;
    this.args = opts.args ?? [];
    this.env = { ...process.env, ...(opts.env ?? {}) };
    this.cwd = opts.cwd;
    this.name = opts.name ?? command;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxStderrBytes = opts.maxStderrBytes ?? 8_192;
    this.log = opts.log ?? (() => {});

    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.tools = [];
    this.ready = false;
    this.closed = false;
  }

  async start() {
    if (this.child) return this;
    this.child = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("error", (err) => this.#failAll(err));

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parsed = safeJsonParse(trimmed);
      if (!parsed.ok) return this.log("mcp", `non-JSON stdout ignored: ${trimmed.slice(0, 120)}`);
      this.#dispatch(parsed.value);
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-this.maxStderrBytes);
    });

    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.ready = false;
      this.#failAll(new Error(`MCP server "${this.name}" exited (code=${code}, signal=${signal})`));
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cloudclaw", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.ready = true;
    return this;
  }

  #dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message ?? "MCP error");
        err.code = msg.error.code;
        err.data = msg.error.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    // Server-initiated notifications/requests: log, do not crash.
    if (msg.method) this.log("mcp", `notification: ${msg.method}`);
  }

  #failAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async listTools({ refresh = false } = {}) {
    if (this.tools.length > 0 && !refresh) return this.tools;
    const result = await this.request("tools/list", {});
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  /** MCP tools → OpenAI function-calling schema (names sanitized). */
  async getOpenAITools({ filter } = {}) {
    const tools = await this.listTools();
    return tools
      .filter((t) => (typeof filter === "function" ? filter(t) : true))
      .map((t) => ({
        type: "function",
        function: {
          name: sanitizeToolName(t.name),
          description: String(t.description ?? "").slice(0, 1024),
          parameters: t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema
            : { type: "object", properties: {} },
        },
      }));
  }

  /** Execute a tool and flatten its text content. */
  async callTool(name, args = {}, { timeoutMs, maxChars = DEFAULT_MAX_RESULT_CHARS } = {}) {
    const result = await this.request("tools/call", { name, arguments: args }, { timeoutMs });
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((c) => (typeof c?.text === "string" ? c.text : c?.type ? `[${c.type}]` : ""))
      .filter(Boolean)
      .join("\n");
    const out = text || JSON.stringify(result ?? {});
    return out.length > maxChars ? `${out.slice(0, maxChars)}\n…[truncated ${out.length - maxChars} chars]` : out;
  }

  async close({ timeoutMs = 3_000 } = {}) {
    if (!this.child || this.closed) return;
    const child = this.child;
    this.closed = true;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/** OpenAI requires ^[a-zA-Z0-9_-]{1,64}$ tool names. */
export function sanitizeToolName(name) {
  return String(name ?? "tool").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
}

/**
 * Cloud-routed tool loop: complete → execute tool calls over MCP → repeat.
 * @param {Object} args {router, messages, clients: StdioMCPClient[], maxIterations, systemPrompt, opts}
 * @returns {Promise<{message, messages, telemetry: Object[], iterations, limitHit}>}
 */
export async function runToolLoop({
  router,
  messages,
  clients = [],
  maxIterations = 8,
  maxToolResultChars = DEFAULT_MAX_RESULT_CHARS,
  opts = {},
}) {
  if (!router) throw new TypeError("runToolLoop requires a router");
  const convo = [...messages];
  const telemetry = [];

  // Build tool inventory and name → client map. Later clients win name clashes.
  const toolDefs = [];
  const toolOwners = new Map();
  for (const client of clients) {
    for (const def of await client.getOpenAITools()) {
      toolDefs.push(def);
      toolOwners.set(def.function.name, client);
    }
  }

  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    const result = await router.complete(convo, toolDefs, opts);
    telemetry.push(result.telemetry);

    const message = result.message ?? { role: "assistant", content: "" };
    convo.push(message);

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) {
      return { message, messages: convo, telemetry, iterations, limitHit: false };
    }

    for (const call of calls) {
      const name = call?.function?.name;
      const owner = toolOwners.get(name);
      const rawArgs = call?.function?.arguments ?? "{}";
      const parsed = safeJsonParse(rawArgs);

      let content;
      if (!owner) {
        content = `error: unknown tool "${name}"`;
      } else if (!parsed.ok) {
        content = `error: invalid JSON arguments for "${name}": ${parsed.error.message}`;
      } else {
        try {
          content = await owner.callTool(name, parsed.value, { maxChars: maxToolResultChars });
        } catch (err) {
          content = `error: tool "${name}" failed: ${err.message}`;
        }
      }

      convo.push({
        role: "tool",
        tool_call_id: call.id ?? `call_${iterations}_${name}`,
        name,
        content,
      });
    }
  }

  return {
    message: convo[convo.length - 1],
    messages: convo,
    telemetry,
    iterations,
    limitHit: true,
  };
}

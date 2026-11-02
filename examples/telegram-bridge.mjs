#!/usr/bin/env node
/**
 * CloudClaw — Zero-server Telegram bridge (long polling)
 *
 * Runs anywhere Node 18+ runs (Pi, laptop, free tier VM): no public IP, no
 * webhook, no TLS cert. Long-polls getUpdates and routes messages through the
 * circuit breaker router.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN        required
 *   TELEGRAM_ALLOWED_USER_ID  optional, comma-separated Telegram user ids.
 *                             Strongly recommended: without it anyone who finds
 *                             the bot can spend your quota.
 *   SYSTEM_PROMPT             optional persona/instructions
 *   HISTORY_TURNS             optional, default 12 (user+assistant exchanges kept)
 *   TELEGRAM_PARSE_MODE       "plain" (default) or "html"
 *   TELEGRAM_POLL_TIMEOUT     optional, seconds, default 30
 *   TELEGRAM_SHOW_TELEMETRY   "1" to append the telemetry footer (default on)
 *   GROQ_API_KEY / OPENROUTER_API_KEY / VENICE_API_KEY  provider keys
 *   MCP_COMMAND / MCP_ARGS    optional: "node" + "path/to/server.mjs" to bind tools
 */

import { CircuitBreakerRouter } from "../src/router.mjs";
import { formatTelemetryMarkdown } from "../src/telemetry.mjs";
import { StdioMCPClient, runToolLoop } from "../src/mcp-client.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = (process.env.TELEGRAM_ALLOWED_USER_ID ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_TIMEOUT = Number(process.env.TELEGRAM_POLL_TIMEOUT ?? 30);
const PARSE_MODE = (process.env.TELEGRAM_PARSE_MODE ?? "plain").toLowerCase();
const SHOW_TELEMETRY = process.env.TELEGRAM_SHOW_TELEMETRY !== "0";
const HISTORY_TURNS = Number(process.env.HISTORY_TURNS ?? 12);
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ??
  "You are CloudClaw, an autonomous cloud-routed AI assistant. Be concise and direct.";

const MAX_TELEGRAM_CHARS = 4_000; // Telegram hard limit is 4096

// NOTE: validation happens in main(), not at import time — this module is
// imported by the test suite for its pure helpers and must not exit on load.

/* ------------------------------------------------------------------ */
/* Telegram API                                                        */
/* ------------------------------------------------------------------ */

function apiBaseUrl() {
  if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN. Put it in .env or export it.");
  const base = process.env.TELEGRAM_API_BASE;
  return base ? `${base.replace(/\/$/, "")}/bot${TOKEN}` : `https://api.telegram.org/bot${TOKEN}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function telegram(method, payload = {}, { timeoutMs = (POLL_TIMEOUT + 15) * 1000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${apiBaseUrl()}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));

      if (res.ok && body.ok) return body;

      // Rate limited: honor retry_after, then retry.
      if (res.status === 429 && attempt < retries) {
        const wait = (body?.parameters?.retry_after ?? 3) * 1000;
        await sleep(wait);
        continue;
      }

      if (res.status === 401) {
        throw new Error("Telegram rejected the bot token (401). Check TELEGRAM_BOT_TOKEN.");
      }
      if (res.status === 409) {
        throw new Error(
          "Telegram 409: a webhook is set for this bot. Run deleteWebhook (done automatically at startup) or clear it in BotFather."
        );
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Telegram ${method} failed: ${res.status} ${body?.description ?? ""}`.trim());
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Text helpers (exported for tests)                                    */
/* ------------------------------------------------------------------ */

export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split text into Telegram-sized chunks, preferring newline boundaries. */
export function chunkText(text, max = MAX_TELEGRAM_CHARS) {
  const src = String(text ?? "");
  if (src.length <= max) return [src];
  const chunks = [];
  let rest = src;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Router + sessions                                                   */
/* ------------------------------------------------------------------ */

function buildProviders() {
  const providers = [];
  if (process.env.GROQ_API_KEY) {
    providers.push({
      id: "groq",
      name: "Groq",
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
      costPerMillionIn: 0,
      costPerMillionOut: 0,
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({
      id: "openrouter",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-70b-instruct:free",
      defaultHeaders: { "HTTP-Referer": "https://github.com/", "X-Title": "CloudClaw" },
      costPerMillionIn: 0,
      costPerMillionOut: 0,
    });
  }
  if (process.env.VENICE_API_KEY) {
    providers.push({
      id: "venice",
      name: "Venice",
      baseURL: "https://api.venice.ai/api/v1",
      apiKey: process.env.VENICE_API_KEY,
      model: process.env.VENICE_MODEL ?? "venice-uncensored",
    });
  }
  if (process.env.OLLAMA_BASE_URL) {
    providers.push({
      id: "ollama",
      name: "Ollama",
      baseURL: process.env.OLLAMA_BASE_URL,
      apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
      model: process.env.OLLAMA_MODEL ?? "llama3.2",
    });
  }
  return providers;
}

let _router = null;
function getRouter() {
  if (_router) return _router;
  const providers = buildProviders();
  if (providers.length === 0) {
    throw new Error("No providers configured. Set GROQ_API_KEY, OPENROUTER_API_KEY, VENICE_API_KEY or OLLAMA_BASE_URL.");
  }
  _router = new CircuitBreakerRouter(providers, {
    onEvent: (event) => {
      if (event.type === "breaker:trip") {
        console.warn(`[breaker] ${event.provider} OPEN for ${Math.round(event.cooldownMs / 1000)}s (trips=${event.trips})`);
      }
      if (event.type === "provider:retry") {
        console.log(`[retry] ${event.provider} attempt ${event.attempt} in ${event.delayMs}ms (${event.kind})`);
      }
    },
  });
  return _router;
}

const sessions = new Map(); // chatId -> messages[]
const queues = new Map(); // chatId -> Promise chain (serialize per chat)

function history(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return sessions.get(chatId);
}

function trimHistory(messages) {
  const head = messages[0]?.role === "system" ? [messages[0]] : [];
  const body = messages.slice(head.length);
  const keep = Math.max(2, HISTORY_TURNS * 2);
  return [...head, ...body.slice(-keep)];
}

function enqueue(chatId, task) {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => console.error("[queue]", err.message));
  queues.set(chatId, next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

let mcpClient = null;
if (process.env.MCP_COMMAND) {
  mcpClient = new StdioMCPClient({
    command: process.env.MCP_COMMAND,
    args: (process.env.MCP_ARGS ?? "").split(" ").filter(Boolean),
    name: "mcp",
    log: (tag, msg) => console.log(`[${tag}] ${msg}`),
  });
}

async function reply(chatId, text, { replyTo } = {}) {
  for (const chunk of chunkText(text)) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: PARSE_MODE === "html" ? escapeHtml(chunk) : chunk,
      ...(PARSE_MODE === "html" ? { parse_mode: "HTML" } : {}),
      ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
      disable_web_page_preview: true,
    });
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text ?? "";

  // Security gate
  if (ALLOWED.length > 0 && !ALLOWED.includes(String(msg.from?.id))) {
    console.warn(`[denied] user ${msg.from?.id} (@${msg.from?.username ?? "?"}) tried to use the bot`);
    await reply(chatId, `⛔ Access denied. Your Telegram user id (${msg.from?.id}) is not allowed.`);
    return;
  }

  if (text === "/start" || text === "/help") {
    await reply(chatId, [
      "CloudClaw online.",
      "",
      "/reset — clear this conversation",
      "/status — provider + breaker state",
      "",
      "Anything else is sent to the model.",
    ].join("\n"));
    return;
  }

  if (text === "/reset") {
    sessions.delete(chatId);
    await reply(chatId, "Context cleared.");
    return;
  }

  if (text === "/status") {
    const status = getRouter().getStatus();
    const lines = status.providers.map(
      (p) => `${p.name} ${p.state}${p.cooldownRemainingMs ? ` (${Math.ceil(p.cooldownRemainingMs / 1000)}s)` : ""} · fails ${p.consecutiveFailures}`
    );
    await reply(chatId, [
      `Requests: ${status.stats.requests} · ok ${status.stats.successes} · fail ${status.stats.failures}`,
      `Tokens: ${status.stats.totalTokens} · Cost: $${status.stats.totalCost.toFixed(4)}`,
      ...lines,
    ].join("\n"));
    return;
  }

  const messages = history(chatId);
  messages.push({ role: "user", content: text });
  const trimmed = trimHistory(messages);

  await telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    let answer;
    let telemetry = null;

    if (mcpClient?.ready) {
      const loop = await runToolLoop({ router: getRouter(), messages: trimmed, clients: [mcpClient] });
      answer = loop.message?.content ?? "(no content)";
      telemetry = loop.telemetry[loop.telemetry.length - 1] ?? null;
    } else {
      const result = await getRouter().complete(trimmed);
      answer = result.message?.content ?? "(no content)";
      telemetry = result.telemetry;
    }

    messages.length = 0;
    messages.push(...trimHistory(trimmed).concat([{ role: "assistant", content: answer }]));

    const footer = SHOW_TELEMETRY && telemetry ? `\n\n${formatTelemetryMarkdown(telemetry)}` : "";
    await reply(chatId, `${answer}${footer}`, { replyTo: msg.message_id });
  } catch (err) {
    console.error("[complete]", err.message);
    await reply(chatId, `⚠️ All providers are cooling down.\n${err.message}`, { replyTo: msg.message_id });
  }
}

let running = true;
let lastUpdateId = 0;

function shutdown(signal) {
  if (!running) return;
  running = false;
  console.log(`\n[shutdown] ${signal} received, closing.`);
  mcpClient?.close().catch(() => {});
  setTimeout(() => process.exit(0), 250);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export async function main() {
  if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN. Put it in .env or export it.");
  if (ALLOWED.length === 0) {
    console.warn("⚠ TELEGRAM_ALLOWED_USER_ID is unset — anyone who finds this bot can use it.");
  }
  getRouter(); // fail fast on missing provider keys

  // Long polling requires no webhook.
  await telegram("deleteWebhook", { drop_pending_updates: false }).catch((err) => {
    console.warn(`[warn] deleteWebhook failed: ${err.message}`);
  });

  if (mcpClient) {
    await mcpClient.start();
    const tools = await mcpClient.listTools();
    console.log(`[mcp] ${tools.length} tool(s) bound`);
  }

  console.log("🤖 CloudClaw Telegram bridge online (long polling, no webhook).");

  while (running) {
    try {
      const res = await telegram("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: POLL_TIMEOUT,
        allowed_updates: ["message"],
      });

      for (const update of res.result ?? []) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg) continue;
        if (msg.from?.is_bot) continue;
        if (typeof msg.text !== "string" || msg.text.length === 0) {
          await reply(msg.chat.id, "Text messages only for now.");
          continue;
        }
        enqueue(msg.chat.id, () => handleMessage(msg));
      }
    } catch (err) {
      console.error(`[poll] ${err.message} — retrying in 5s`);
      await sleep(5_000);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[fatal] ${err.message}`);
    process.exit(1);
  });
}

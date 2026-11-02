# CloudClaw

A zero-VRAM agent runtime: cloud-routed inference with circuit breakers, a
Telegram long-polling bridge you can run from a Raspberry Pi, and MCP stdio
tool binding so the model can act on local files and commands.

```
src/router.mjs            circuit-breaker router (failover, backoff, telemetry)
src/telemetry.mjs         one-line telemetry bar, zero deps, NO_COLOR aware
src/mcp-client.mjs        MCP stdio client + runToolLoop (cloud → local tools)
examples/telegram-bridge.mjs  long-polling Telegram bot (no webhook, no TLS)
docs/PROVIDERS.md         free-tier reality matrix + breaker behaviour
tests/                    31 tests — no network, no keys, no sleeps
```

## Quick start

```bash
# 1. install the optional SDK used by the real providers
npm i openai

# 2. configure
cp .env.example .env      # add TELEGRAM_BOT_TOKEN, GROQ_API_KEY, ...

# 3. run the bot (long polling — no public IP needed)
npm run start:telegram
```

No keys? Run the offline demo — scripted fake providers, real breaker logic:

```bash
npm run demo
```

## Router

```js
import { CircuitBreakerRouter } from "./src/router.mjs";

const router = new CircuitBreakerRouter([
  { id: "groq", name: "Groq", baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY, model: "llama-3.3-70b-versatile" },
  { id: "or", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "meta-llama/llama-3.3-70b-instruct:free" },
], { failureThreshold: 3, baseCooldownMs: 300_000 });

const { message, telemetry, statusBar } = await router.complete([
  { role: "user", content: "hello" },
]);
```

Error policy:

| Error | Behaviour |
|---|---|
| 429 / 402 / 5xx / timeout / network | retry with exponential backoff (honors `Retry-After`), then trip |
| 401 / 403 | trip immediately — no retries |
| 404 | trip immediately (wrong model id) |
| 400 / 422 | no retry, provider not tripped, fail over |

Cooldown is `base × 2^(trips-1)`, capped, with ±20% jitter. HALF-OPEN allows
exactly one probe; a failed probe re-opens with a longer cooldown.

## MCP tool binding

```js
import { StdioMCPClient, runToolLoop } from "./src/mcp-client.mjs";

const mcp = new StdioMCPClient({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()] });
await mcp.start();

const out = await runToolLoop({
  router,
  messages: [{ role: "user", content: "summarize README.md" }],
  clients: [mcp],
});
console.log(out.message.content);
await mcp.close();
```

`runToolLoop` sanitizes tool names, truncates oversized results, turns tool
errors into tool messages (the model can recover) and stops after
`maxIterations`.

## Tests

```bash
npm test    # 31 tests, offline, ~1s
```

Everything is injected: clock, sleep, randomness and the provider client, so
breaker behaviour is asserted deterministically — no real waiting, no network.

## License

Apache-2.0.

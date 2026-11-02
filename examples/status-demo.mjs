#!/usr/bin/env node
/**
 * Demo: run the router against scripted fake providers (no network, no keys)
 * and print the telemetry bar + breaker transitions.
 *
 *   node examples/status-demo.mjs
 */
import { CircuitBreakerRouter } from "../src/router.mjs";
import { TelemetryBar, formatTelemetryBar } from "../src/telemetry.mjs";

const ok = (content, pt = 120, ct = 60) => ({
  choices: [{ message: { role: "assistant", content } }],
  usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
});

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Scripted providers: Groq rate-limits, OpenRouter serves, Venice unused.
const groqScript = [httpError(429, "rate_limit_exceeded"), httpError(429, "rate_limit_exceeded"), httpError(429, "rate_limit_exceeded")];
let groqCall = 0;

const router = new CircuitBreakerRouter(
  [
    { id: "groq", name: "Groq", model: "llama-3.3-70b-versatile", baseURL: "http://fake", apiKey: "x" },
    { id: "openrouter", name: "OpenRouter", model: "llama-3.3-70b-instruct:free", baseURL: "http://fake", apiKey: "x" },
  ],
  {
    failureThreshold: 2,
    baseCooldownMs: 15_000,
    maxRetriesPerProvider: 1,
    retryBaseDelayMs: 10,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    clientFactory: async (cfg) => ({
      chat: { completions: { create: async () => {
        if (cfg.id === "groq") {
          const step = groqScript[Math.min(groqCall++, groqScript.length - 1)];
          if (step instanceof Error) throw step;
        }
        return ok(`answer from ${cfg.name}`);
      } } },
    }),
    onEvent: (e) => {
      if (e.type === "breaker:trip") console.log(`  ⚡ breaker trip: ${e.provider} → OPEN ${Math.round(e.cooldownMs / 1000)}s`);
      if (e.type === "breaker:half-open") console.log(`  ◐ breaker half-open: ${e.provider}`);
      if (e.type === "provider:retry") console.log(`  ↻ retry ${e.provider} #${e.attempt} in ${e.delayMs}ms (${e.kind})`);
    },
  }
);

const bar = new TelemetryBar({ color: false });

for (let i = 1; i <= 3; i += 1) {
  try {
    const res = await router.complete([{ role: "user", content: `request ${i}` }]);
    bar.record(res.telemetry);
    console.log(`#${i} → ${res.message.content}  |  ${formatTelemetryBar(res.telemetry, { color: false })}`);
  } catch (err) {
    bar.record({}, { error: true });
    console.log(`#${i} → ERROR ${err.message.slice(0, 100)}`);
  }
}

console.log("\nsession:", JSON.stringify(bar.snapshot(), null, 0));
console.log("\nbreaker status:");
for (const p of router.getStatus().providers) {
  console.log(`  ${p.name.padEnd(11)} ${p.state.padEnd(10)} trips=${p.trips} cooldown=${Math.ceil(p.cooldownRemainingMs / 1000)}s`);
}

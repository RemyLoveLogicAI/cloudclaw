import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreakerRouter, classifyError, parseRetryAfter, PROVIDER_STATE } from "../src/router.mjs";

/** Fake OpenAI client whose behaviour is scripted per call. */
function fakeClient(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    client: {
      chat: { completions: { create: async (payload) => {
        calls.push(payload);
        const step = script[Math.min(i++, script.length - 1)];
        if (step instanceof Error) throw step;
        return step;
      } } },
    },
  };
}

const okResponse = (prompt = 100, completion = 50) => ({
  choices: [{ message: { role: "assistant", content: "hello" } }],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
});

const httpError = (status, message = "err", headers) => {
  const e = new Error(message);
  e.status = status;
  if (headers) e.headers = headers;
  return e;
};

function makeRouter(fake, opts = {}) {
  return new CircuitBreakerRouter(
    [{ id: "p1", name: "P1", model: "m1", baseURL: "http://x", apiKey: "k" }],
    {
      clientFactory: async () => fake.client,
      sleep: async () => {},
      random: () => 0.5, // deterministic: no jitter
      ...opts,
    }
  );
}

test("successful completion returns telemetry and resets breaker", async () => {
  const fake = fakeClient([okResponse(200, 100)]);
  const router = makeRouter(fake);
  const res = await router.complete([{ role: "user", content: "hi" }]);
  assert.equal(res.message.content, "hello");
  assert.equal(res.telemetry.promptTokens, 200);
  assert.equal(res.telemetry.completionTokens, 100);
  assert.equal(res.telemetry.totalTokens, 300);
  assert.equal(res.telemetry.breakerState, "CLOSED");
  assert.equal(router.providers[0].state, PROVIDER_STATE.CLOSED);
  assert.equal(router.stats.successes, 1);
  assert.ok(res.statusBar.includes("P1"));
});

test("retryable 429 retries with backoff then succeeds", async () => {
  const delays = [];
  const fake = fakeClient([httpError(429, "rate limited"), okResponse()]);
  const router = makeRouter(fake, {
    sleep: async (ms) => { delays.push(ms); },
    retryBaseDelayMs: 500,
  });
  const res = await router.complete([{ role: "user", content: "hi" }]);
  assert.equal(res.attempts, 2);
  assert.equal(delays.length, 1);
  assert.equal(delays[0], 500); // deterministic: 500 * 2^0, no jitter
  assert.equal(router.providers[0].state, PROVIDER_STATE.CLOSED);
});

test("Retry-After header is honored and capped", async () => {
  const delays = [];
  const fake = fakeClient([httpError(429, "slow down", { "retry-after": "7" }), okResponse()]);
  const router = makeRouter(fake, {
    sleep: async (ms) => { delays.push(ms); },
    maxRetryDelayMs: 5000,
  });
  await router.complete([{ role: "user", content: "hi" }]);
  assert.equal(delays[0], 5000); // 7s capped to 5s
});

test("breaker trips after threshold and reports cooldown", async () => {
  let clock = 1000;
  const fake = fakeClient([httpError(500, "boom")]);
  const router = makeRouter(fake, {
    now: () => clock,
    failureThreshold: 3,
    baseCooldownMs: 60_000,
    maxRetriesPerProvider: 0,
  });
  await assert.rejects(() => router.complete([{ role: "user", content: "hi" }]), /exhausted/i);
  const p = router.providers[0];
  assert.equal(p.state, PROVIDER_STATE.OPEN);
  assert.equal(p.trips, 1);
  assert.equal(p.cooldownUntil, clock + 60_000);

  // still open: immediate error without calling the client again
  await assert.rejects(() => router.complete([{ role: "user", content: "hi" }]), /All circuit breakers are OPEN/);

  // after cooldown: HALF-OPEN probe succeeds and closes
  clock += 60_001;
  fake.calls.length = 0;
  const okFake = fakeClient([okResponse()]);
  router.providers[0].client = okFake.client;
  const res = await router.complete([{ role: "user", content: "hi" }]);
  assert.equal(router.providers[0].state, PROVIDER_STATE.CLOSED);
  assert.equal(res.attempts, 1);
});

test("auth 401 trips immediately without retries", async () => {
  const fake = fakeClient([httpError(401, "bad key")]);
  const router = makeRouter(fake, { maxRetriesPerProvider: 3 });
  await assert.rejects(() => router.complete([{ role: "user", content: "hi" }]), /exhausted/i);
  assert.equal(fake.calls.length, 1, "no retries for auth errors");
  assert.equal(router.providers[0].state, PROVIDER_STATE.OPEN);
});

test("misconfigured 400 does not trip the provider but does fail over", async () => {
  const bad = fakeClient([httpError(400, "bad request")]);
  const router = new CircuitBreakerRouter(
    [
      { id: "p1", name: "P1", model: "m1", baseURL: "http://x", apiKey: "k" },
      { id: "p2", name: "P2", model: "m2", baseURL: "http://y", apiKey: "k" },
    ],
    {
      clientFactory: async (cfg) => (cfg.id === "p1" ? bad.client : fakeClient([okResponse()]).client),
      sleep: async () => {},
      random: () => 0.5,
    }
  );
  const res = await router.complete([{ role: "user", content: "hi" }]);
  assert.equal(res.providerId, "p2");
  assert.equal(router.providers[0].state, PROVIDER_STATE.CLOSED, "400 must not trip");
});

test("failover to second provider when first trips", async () => {
  const p1 = fakeClient([httpError(503, "down")]);
  const good = fakeClient([okResponse()]);
  const router = new CircuitBreakerRouter(
    [
      { id: "p1", name: "P1", model: "m1", baseURL: "http://x", apiKey: "k" },
      { id: "p2", name: "P2", model: "m2", baseURL: "http://y", apiKey: "k" },
    ],
    {
      clientFactory: async (cfg) => (cfg.id === "p1" ? p1.client : good.client),
      sleep: async () => {},
      random: () => 0.5,
      maxRetriesPerProvider: 0,
    }
  );
  const res = await router.complete([{ role: "user", content: "hi" }]);
  assert.equal(res.providerId, "p2");
  assert.equal(router.providers[0].state, PROVIDER_STATE.OPEN);
  assert.equal(router.providers[1].state, PROVIDER_STATE.CLOSED);
});

test("tools are passed through when provided", async () => {
  const fake = fakeClient([okResponse()]);
  const router = makeRouter(fake);
  const tools = [{ type: "function", function: { name: "t", parameters: { type: "object" } } }];
  await router.complete([{ role: "user", content: "hi" }], tools);
  assert.deepEqual(fake.calls[0].tools, tools);
  assert.equal(fake.calls[0].tool_choice, "auto");
});

test("getStatus reports breaker state and remaining cooldown", async () => {
  let clock = 0;
  const fake = fakeClient([httpError(500)]);
  const router = makeRouter(fake, { now: () => clock, maxRetriesPerProvider: 0, baseCooldownMs: 30_000 });
  await assert.rejects(() => router.complete([{ role: "user", content: "hi" }]));
  clock = 10_000;
  const st = router.getStatus();
  assert.equal(st.providers[0].state, PROVIDER_STATE.OPEN);
  assert.equal(st.providers[0].cooldownRemainingMs, 20_000);
  router.resetBreakers();
  assert.equal(router.getStatus().providers[0].state, PROVIDER_STATE.CLOSED);
});

test("error classification buckets", () => {
  assert.equal(classifyError(httpError(429)).kind, "capacity");
  assert.equal(classifyError(httpError(402)).kind, "capacity");
  assert.equal(classifyError(httpError(401)).kind, "auth");
  assert.equal(classifyError(httpError(404)).kind, "config");
  assert.equal(classifyError(httpError(422)).kind, "request");
  assert.equal(classifyError(new Error("socket hang up")).kind, "capacity");
});

test("parseRetryAfter handles seconds and dates", () => {
  assert.equal(parseRetryAfter({ headers: { "retry-after": "3" } }), 3000);
  assert.equal(parseRetryAfter({ headers: new Map([["retry-after", "5"]]) && { get: () => "5" } }), 5000);
  assert.equal(parseRetryAfter({ headers: {} }), undefined);
});

test("constructor rejects empty provider list", () => {
  assert.throws(() => new CircuitBreakerRouter([]), /at least one provider/);
  assert.throws(() => new CircuitBreakerRouter([{ model: "m" }]), /baseURL/);
});

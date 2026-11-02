# 📊 CloudClaw — Free-Tier Reality Matrix & Quota Limits

CloudClaw manages failover across free tiers without requiring payment info or
local GPUs. This document is deliberately candid about what each tier actually
gives you, how the router behaves when a quota is hit, and which failures are
worth retrying.

> **Numbers move.** Quotas below are the values this project was built and
> tested against (Nov 1, 2026). Verify against each provider's console before
> relying on them in production. Where a number is known to drift, it is marked
> "verify".

---

## 1. How the router consumes limits

The router does not pre-emptively throttle per provider. Instead it reacts to
the signals the provider sends:

| Signal | Router behaviour |
|---|---|
| `HTTP 429` (rate limit) | Retry up to `maxRetriesPerProvider` honoring `Retry-After`, then trip the breaker |
| `HTTP 402` (payment/quota) | Treated as capacity: retry once, then trip (cooldown 5 min × 2^(trips-1)) |
| `HTTP 401/403` | **Auth-fatal**: trip immediately, no retries, no wasted tokens |
| `HTTP 404` (model not found) | **Config-fatal**: trip immediately (wrong model id) |
| `HTTP 400/422` (bad request) | Not retried, provider **not** tripped — fail over only |
| `HTTP 5xx` / `529` | Capacity: retry with exponential backoff, then trip |
| Timeout (`requestTimeoutMs`, default 60s) | Capacity: retry, then trip |
| Network error (`ECONNRESET`, `fetch failed`, …) | Capacity: retry, then trip |

Cooldown is exponential per provider: `base × 2^(trips-1)`, capped at
`maxCooldownMs` (default 1h), with ±20% jitter so multiple instances do not
synchronize their retries.

### Breaker lifecycle

```
  [CLOSED]  Normal operation
     │
     │  429 / 402 / 5xx / timeout / network
     ▼
  [OPEN]    Cooldown = 5m × 2^(trips-1), capped at 1h, ±20% jitter
     │
     │  cooldown elapses
     ▼
 [HALF-OPEN]   Exactly one probe request (probe stampedes are blocked)
   ├── probe fails ──> [OPEN]  (trips+1, longer cooldown)
   └── probe passes ─> [CLOSED] (failures and trips reset)
```

A single failing probe re-opens the breaker. A healthy provider that returns a
successful response resets `consecutiveFailures` and `trips` to zero, so a
provider that has been stable for hours gets a full 5-minute cooldown next
time it trips, not the maximum.

---

## 2. Provider matrix

### 1. Groq Cloud — primary fast tier

- Console: [console.groq.com](https://console.groq.com)
- Default model: `llama-3.3-70b-versatile`
- Cost: $0.00 on free tier
- Limits (verify):
  - Requests per minute: **30 RPM**
  - Requests per day: **14,400 RPD**
  - Tokens per minute: **6,000–20,000 TPM** (varies by model)
- Agent suitability: ⭐⭐⭐⭐⭐ — fastest LPU token delivery, native function
  calling, very low latency per turn.
- Breaker condition: `429 rate_limit_exceeded` → capacity trip, 5 min cool-off.
- Notes: TPM is the real ceiling for agent loops with large system prompts.
  Keep history trimmed (CloudClaw keeps the last `HISTORY_TURNS` exchanges) or
  you will hit TPM long before RPM.

### 2. OpenRouter `:free` catalog — secondary fallback

- Console: [openrouter.ai](https://openrouter.ai)
- Default model: `meta-llama/llama-3.3-70b-instruct:free`
- Cost: $0.00 on `:free` models
- Limits (verify):
  - Unfunded account: **20 requests/minute, 50 requests/day**
  - With $10 one-time credit: **1,000 requests/day** on free models
  - `:free` model availability rotates; a model can disappear without notice
- Agent suitability: ⭐⭐⭐ — broad model choice, occasional queue wait, free
  pool is more volatile than Groq.
- Breaker condition: `429` or `402` → capacity trip, 10 min cool-off when
  configured with `baseCooldownMs: 600_000`.
- Notes: send `HTTP-Referer` and `X-Title` headers (the bridge does) so
  requests are attributed. Free models can return 404 when delisted — the
  router treats 404 as config-fatal and fails over without retrying.

### 3. Venice AI — optional, uncensored / zero-retention

- Console: [venice.ai](https://venice.ai)
- Default models: `venice-uncensored`, `deepseek-r1-671b`
- Cost: paid API tokens (or VVV staking); not a free tier
- Suitability: ⭐⭐⭐⭐ — zero refusals, OpenAI-compatible surface.
- Notes: include it as a **last** provider when you want an uncensored path, or
  as the only provider when content policy is the point.

### 4. Optional additions

| Provider | Why include it | Caveat |
|---|---|---|
| Local Ollama (`OLLAMA_BASE_URL`) | Zero quota, zero latency to localhost, works offline | Needs RAM/GPU; model quality below frontier |
| Cerebras | Very fast inference, free dev tier (verify) | Model list is narrow |
| Google Gemini Flash | Generous free tier (verify RPD) | Different tool-calling schema; needs adapter |
| Mistral La Plateforme | Free experimental tier (verify) | Rate limits change often |

---

## 3. Recommended provider ladder

Order matters: cheap and fast first, volatile last.

```
1. Ollama (local, if available)     — zero quota, instant
2. Groq                             — fastest cloud, best free-tier shape
3. OpenRouter :free                 — breadth, volatile availability
4. Venice                           — uncensored / paid fallback
```

With `failureThreshold: 3`, a dead primary costs at most one round of retries
before failover, and takes itself out of rotation for 5 minutes.

---

## 4. Tuning the breaker

```js
new CircuitBreakerRouter(providers, {
  failureThreshold: 3,          // failures before tripping (default 3)
  baseCooldownMs: 5 * 60_000,   // first cooldown (default 5m)
  maxCooldownMs: 60 * 60_000,   // cooldown cap (default 1h)
  requestTimeoutMs: 60_000,     // per-attempt timeout (default 60s)
  maxRetriesPerProvider: 2,     // same-provider retries before failover
  retryBaseDelayMs: 500,        // exponential retry base
  maxRetryDelayMs: 15_000,      // retry delay cap
  jitter: 0.2,                  // ±20% on cooldowns and retry delays
});
```

Guidance:

- **Agent loops with tools**: keep `maxRetriesPerProvider` at 1–2. Each retry
  resends the whole conversation; with tool schemas that is expensive.
- **Phone/Telegram bridge**: `requestTimeoutMs` 45–60s. Users will re-send if
  the bot is silent longer than that.
- **Bursty batch jobs**: raise `failureThreshold` to 4–5 so a brief 429 storm
  does not eject a healthy provider.

---

## 5. Adding a provider

Any OpenAI-compatible endpoint works — no code changes:

```js
{
  id: "cerebras",
  name: "Cerebras",
  baseURL: "https://api.cerebras.ai/v1",
  apiKey: process.env.CEREBRAS_API_KEY,
  model: "llama3.1-70b",
  costPerMillionIn: 0,
  costPerMillionOut: 0,
}
```

`costPerMillionIn/Out` can stay at `0` for free tiers; telemetry will then
report `$0.0000` for those providers and real cost for any paid ones.

---

## 6. Operational notes

- **Per-minute vs per-day**: the router cannot see daily quotas until the
  provider rejects. If you run a long-lived bot on a 50/day tier, expect the
  breaker to sit OPEN for its cooldown after the daily cap is hit and add a
  second provider above it in the ladder.
- **Telemetry is per-provider**: `getStatus()` reports `state`, `trips`,
  `cooldownRemainingMs` and `lastError` so `/status` can show exactly which
  breaker is open and why.
- **Cost accounting**: `costSpent` per call plus cumulative totals in
  `router.stats`. For free tiers this stays at zero by design.
- **Security**: keys come from env only. Never commit `.env`; the provided
  `.env.example` lists the variables without values.

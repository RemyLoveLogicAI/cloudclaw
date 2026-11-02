/**
 * CloudClaw — Circuit Breaker Router (hardened)
 *
 * Routes OpenAI-compatible chat completion calls across a list of providers
 * (Groq, OpenRouter, Venice, local Ollama, ...) with per-provider circuit
 * breakers, exponential cooldown, per-request retries, request timeouts and
 * token/cost telemetry.
 *
 * Design rules:
 *  - Never trust a provider to be healthy.
 *  - Fail fast on auth/config errors (a bad key must not burn the retry budget).
 *  - Fail over on capacity errors (429/402/5xx/timeouts).
 *  - Everything is injectable (now/sleep/random/clientFactory) so the breaker
 *    is unit-testable without sleeping or hitting the network.
 *  - Zero hard dependency on `openai`: it is imported lazily by the default
 *    client factory, so tests and docs run without it installed.
 */

import { formatTelemetryBar } from "./telemetry.mjs";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const AUTH_FATAL_STATUS = new Set([401, 403]);

export const PROVIDER_STATE = Object.freeze({
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF-OPEN",
});

function num(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(err) {
  const raw = headerValue(err?.headers, "retry-after") ?? err?.retry_after;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber * 1000);
  const asDate = Date.parse(String(raw));
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

/** Extract an HTTP-ish status from OpenAI SDK errors and fetch failures. */
export function statusOf(err) {
  return num(err?.status ?? err?.response?.status ?? err?.statusCode, 0) || undefined;
}

/**
 * Classify an error into the breaker policy buckets.
 *  - "auth"    : 401/403 → trip immediately, no retry (bad key/account)
 *  - "config"  : 404 model not found → trip immediately (wrong model id)
 *  - "capacity": 429/402/5xx/timeout/network → retry, then trip
 *  - "request" : 400/422 → our bug; fail over but do not trip the provider
 */
export function classifyError(err) {
  const status = statusOf(err);
  const message = String(err?.message ?? "");
  const quota = status === 402 || /quota|insufficient|rate.?limit|exceeded/i.test(message);

  if (status && AUTH_FATAL_STATUS.has(status)) return { kind: "auth", retryable: false, trip: true, status };
  if (status === 404) return { kind: "config", retryable: false, trip: true, status };
  if (quota || (status && RETRYABLE_STATUS.has(status))) {
    return { kind: "capacity", retryable: true, trip: true, status };
  }
  if (status && status >= 400 && status < 500) return { kind: "request", retryable: false, trip: false, status };
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed/i.test(message)) {
    return { kind: "capacity", retryable: true, trip: true, status };
  }
  // Unknown error: treat as capacity so a broken provider cannot wedge the router.
  return { kind: "capacity", retryable: true, trip: true, status };
}

export class CircuitBreakerRouter {
  /**
   * @param {Array<Object>} providerConfigs  [{id,name,model,baseURL,apiKey,defaultHeaders,costPerMillionIn,costPerMillionOut}]
   * @param {Object} options
   */
  constructor(providerConfigs = [], options = {}) {
    if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
      throw new TypeError("CircuitBreakerRouter requires at least one provider config");
    }

    this.options = {
      failureThreshold: 3,
      baseCooldownMs: 5 * 60 * 1000,
      maxCooldownMs: 60 * 60 * 1000,
      requestTimeoutMs: 60 * 1000,
      maxRetriesPerProvider: 2,
      retryBaseDelayMs: 500,
      maxRetryDelayMs: 15 * 1000,
      jitter: 0.2,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      clientFactory: null, // async (cfg) => client
      onEvent: null, // (event) => void
      ...options,
    };

    this.providers = providerConfigs.map((cfg, index) => this.#buildProvider(cfg, index));
    this.stats = {
      requests: 0,
      successes: 0,
      failures: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      totalDurationMs: 0,
    };
  }

  #buildProvider(cfg, index) {
    if (!cfg || typeof cfg !== "object") throw new TypeError(`provider[${index}] must be an object`);
    if (!cfg.model) throw new TypeError(`provider[${index}] missing "model"`);
    if (!cfg.baseURL) throw new TypeError(`provider[${index}] missing "baseURL"`);
    return {
      id: cfg.id || cfg.name || `provider-${index}`,
      name: cfg.name || cfg.id || `provider-${index}`,
      model: cfg.model,
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      defaultHeaders: cfg.defaultHeaders || {},
      costPerMillionIn: num(cfg.costPerMillionIn, 0),
      costPerMillionOut: num(cfg.costPerMillionOut, 0),
      state: PROVIDER_STATE.CLOSED,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      trips: 0,
      probeInFlight: false,
      lastError: null,
      client: null,
    };
  }

  #emit(type, payload) {
    if (typeof this.options.onEvent === "function") {
      try {
        this.options.onEvent({ type, at: this.options.now(), ...payload });
      } catch {
        /* telemetry must never break routing */
      }
    }
  }

  async #client(provider) {
    if (provider.client) return provider.client;
    if (typeof this.options.clientFactory === "function") {
      provider.client = await this.options.clientFactory({
        id: provider.id,
        name: provider.name,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        model: provider.model,
        defaultHeaders: provider.defaultHeaders,
      });
      return provider.client;
    }
    // Lazy import keeps `openai` a peer dependency.
    const mod = await import("openai");
    const OpenAI = mod.default ?? mod.OpenAI;
    provider.client = new OpenAI({
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      defaultHeaders: provider.defaultHeaders,
    });
    return provider.client;
  }

  /** Providers eligible for this call. OPEN → HALF-OPEN when cooldown elapsed. */
  #eligible(now) {
    const out = [];
    for (const p of this.providers) {
      if (p.state === PROVIDER_STATE.CLOSED) out.push(p);
      else if (p.state === PROVIDER_STATE.OPEN && now >= p.cooldownUntil) {
        p.state = PROVIDER_STATE.HALF_OPEN;
        p.probeInFlight = false;
        this.#emit("breaker:half-open", { provider: p.id });
        out.push(p);
      } else if (p.state === PROVIDER_STATE.HALF_OPEN) out.push(p);
    }
    // A single probe per HALF-OPEN provider prevents probe stampedes.
    return out.filter((p) => p.state !== PROVIDER_STATE.HALF_OPEN || !p.probeInFlight);
  }

  #trip(provider, now) {
    provider.state = PROVIDER_STATE.OPEN;
    provider.trips += 1;
    const exponential = this.options.baseCooldownMs * Math.pow(2, provider.trips - 1);
    const capped = Math.min(exponential, this.options.maxCooldownMs);
    const jittered = capped * (1 + (this.options.random() * 2 - 1) * this.options.jitter);
    provider.cooldownUntil = now + Math.max(1, Math.round(jittered));
    provider.probeInFlight = false;
    this.#emit("breaker:trip", {
      provider: provider.id,
      trips: provider.trips,
      cooldownMs: provider.cooldownUntil - now,
      lastError: provider.lastError?.message,
    });
  }

  #reset(provider) {
    if (provider.state !== PROVIDER_STATE.CLOSED || provider.consecutiveFailures > 0) {
      this.#emit("breaker:reset", { provider: provider.id, previousState: provider.state });
    }
    provider.state = PROVIDER_STATE.CLOSED;
    provider.consecutiveFailures = 0;
    provider.trips = 0;
    provider.cooldownUntil = 0;
    provider.probeInFlight = false;
    provider.lastError = null;
  }

  #backoffMs(attempt) {
    const raw = this.options.retryBaseDelayMs * Math.pow(2, attempt);
    const jittered = raw * (1 + (this.options.random() * 2 - 1) * this.options.jitter);
    return Math.min(Math.round(jittered), this.options.maxRetryDelayMs);
  }

  async #callOnce(provider, payload) {
    const client = await this.#client(provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      return await client.chat.completions.create(payload, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Complete a chat request with failover across providers.
   * @returns {Promise<{message, telemetry, statusBar, providerId, providerName, attempts}>}
   */
  async complete(messages, tools = [], opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TypeError("complete() requires a non-empty messages array");
    }
    const toolsEnabled = Array.isArray(tools) && tools.length > 0;
    const startedAt = this.options.now();
    const failures = [];
    const now = () => this.options.now();

    const candidates = this.#eligible(now());
    if (candidates.length === 0) {
      const resets = this.providers
        .map((p) => `${p.name}: ${Math.max(0, Math.ceil((p.cooldownUntil - now()) / 1000))}s`)
        .join(", ");
      throw new Error(`All circuit breakers are OPEN. Reset times: [${resets}]`);
    }

    this.stats.requests += 1;

    for (const provider of candidates) {
      if (provider.state === PROVIDER_STATE.HALF_OPEN) provider.probeInFlight = true;
      let attempt = 0;

      while (true) {
        const attemptStart = now();
        try {
          const payload = {
            model: provider.model,
            messages,
            ...(toolsEnabled ? { tools, tool_choice: opts.toolChoice ?? "auto" } : {}),
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
            ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
          };

          const response = await this.#callOnce(provider, payload);
          const durationMs = now() - attemptStart;
          const usage = response?.usage ?? {};
          const promptTokens = num(usage.prompt_tokens);
          const completionTokens = num(usage.completion_tokens);
          const totalTokens = num(usage.total_tokens, promptTokens + completionTokens);
          const costSpent =
            (promptTokens / 1_000_000) * provider.costPerMillionIn +
            (completionTokens / 1_000_000) * provider.costPerMillionOut;

          this.#reset(provider);
          this.stats.successes += 1;
          this.stats.totalPromptTokens += promptTokens;
          this.stats.totalCompletionTokens += completionTokens;
          this.stats.totalTokens += totalTokens;
          this.stats.totalCost += costSpent;
          this.stats.totalDurationMs += durationMs;

          const telemetry = {
            providerId: provider.id,
            providerName: provider.name,
            model: provider.model,
            durationMs,
            elapsedMs: now() - startedAt,
            promptTokens,
            completionTokens,
            totalTokens,
            costSpent,
            tokensPerSecond: completionTokens > 0 && durationMs > 0
              ? Number((completionTokens / (durationMs / 1000)).toFixed(1))
              : 0,
            attempts: attempt + 1,
            breakerState: provider.state,
          };

          this.#emit("complete:ok", telemetry);

          return {
            message: response?.choices?.[0]?.message ?? null,
            telemetry,
            statusBar: formatTelemetryBar(telemetry),
            providerId: provider.id,
            providerName: provider.name,
            attempts: attempt + 1,
            raw: response,
          };
        } catch (err) {
          const cls = classifyError(err);
          provider.lastError = err;
          provider.probeInFlight = false;

          // A failed HALF-OPEN probe re-opens immediately with a fresh backoff.
          if (provider.state === PROVIDER_STATE.HALF_OPEN) {
            this.#trip(provider, now());
            failures.push({ provider: provider.id, attempt: attempt + 1, kind: cls.kind, status: cls.status, message: err?.message });
            this.#emit("complete:failover", { from: provider.id, reason: cls.kind });
            break;
          }

          const retryAfterMs = parseRetryAfter(err);
          const canRetry = cls.retryable && attempt < this.options.maxRetriesPerProvider;

          if (canRetry) {
            provider.consecutiveFailures += 1;
            const delay = retryAfterMs !== undefined
              ? Math.min(retryAfterMs, this.options.maxRetryDelayMs)
              : this.#backoffMs(attempt);
            this.#emit("provider:retry", { provider: provider.id, attempt: attempt + 1, delayMs: delay, kind: cls.kind });
            await this.options.sleep(delay);
            attempt += 1;
            continue;
          }

          if (cls.trip) {
            provider.consecutiveFailures += 1;
            this.#trip(provider, now());
          }
          failures.push({ provider: provider.id, attempt: attempt + 1, kind: cls.kind, status: cls.status, message: err?.message });
          this.#emit("complete:failover", { from: provider.id, reason: cls.kind });
          break;
        }
      }
    }

    this.stats.failures += 1;
    const summary = failures.map((f) => `${f.provider}[${f.kind}${f.status ? ` ${f.status}` : ""}]: ${f.message ?? "unknown"}`).join(" | ");
    const resets = this.providers
      .filter((p) => p.state === PROVIDER_STATE.OPEN)
      .map((p) => `${p.name} ${Math.max(0, Math.ceil((p.cooldownUntil - now()) / 1000))}s`)
      .join(", ");
    const error = new Error(`All providers exhausted. ${summary}${resets ? ` | cooling: ${resets}` : ""}`);
    error.failures = failures;
    this.#emit("complete:exhausted", { failures });
    throw error;
  }

  /** Snapshot for status bars and /status commands. */
  getStatus() {
    const now = this.options.now();
    return {
      stats: { ...this.stats },
      providers: this.providers.map((p) => ({
        id: p.id,
        name: p.name,
        model: p.model,
        state: p.state,
        consecutiveFailures: p.consecutiveFailures,
        trips: p.trips,
        cooldownRemainingMs: p.state === PROVIDER_STATE.OPEN ? Math.max(0, p.cooldownUntil - now) : 0,
        lastError: p.lastError?.message ?? null,
      })),
    };
  }

  /** Operator escape hatch after fixing a key/quota. */
  resetBreakers() {
    for (const p of this.providers) this.#reset(p);
  }
}

/**
 * CloudClaw — Telemetry (zero-dependency)
 *
 * Renders the one-line status bar used by the router, the Telegram bridge and
 * any terminal UI. Deliberately dependency-free: `chalk` is not required, but
 * the same visual hierarchy is kept (bold provider tag, green speed, dim
 * tokens, yellow latency, magenta cost). Honors NO_COLOR and TERM=dumb.
 *
 * Formats:  [Groq] ⚡ 184.2 tok/s · 512 tok · 0.42s · $0.0000
 *           [OpenRouter] ◐ 61.0 tok/s · 1,204 tok · 3.10s · $0.0012
 */

export const BREAKER_GLYPH = Object.freeze({
  CLOSED: "●",
  "HALF-OPEN": "◐",
  OPEN: "○",
});

const ESC = "\x1b[";
const ANSI = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
};

function colorEnabled(opts = {}) {
  if (typeof opts.color === "boolean") return opts.color;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout?.isTTY);
}

function paint(text, codes, enabled) {
  if (!enabled) return text;
  return `${codes.join("")}${text}${ANSI.reset}`;
}

/** 1234567 -> "1,234,567" */
export function formatNumber(n) {
  const v = Number.isFinite(n) ? n : 0;
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 0 -> "$0.0000"; 0.001234 -> "$0.0012" */
export function formatCost(c) {
  const v = Number.isFinite(c) ? c : 0;
  return `$${v.toFixed(4)}`;
}

/** 1234.56 -> "1,234 tok"; 4_800_000 -> "4.8M tok" */
export function formatTokens(n) {
  const v = Number.isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M tok`;
  return `${formatNumber(v)} tok`;
}

/**
 * One-line telemetry bar for a single completion.
 * @param {Object} telemetry {providerName, tokensPerSecond, totalTokens, durationMs, costSpent, breakerState, attempts}
 * @param {Object} [opts] {color?:boolean, compact?:boolean}
 */
export function formatTelemetryBar(telemetry = {}, opts = {}) {
  const color = colorEnabled(opts);
  const glyph = BREAKER_GLYPH[telemetry.breakerState] ?? BREAKER_GLYPH.CLOSED;

  const provider = `[${telemetry.providerName ?? "provider"}]`;
  const tps = Number.isFinite(telemetry.tokensPerSecond) ? telemetry.tokensPerSecond.toFixed(1) : "0.0";
  const durationMs = Number.isFinite(telemetry.durationMs) ? telemetry.durationMs : 0;
  const cost = Number.isFinite(telemetry.costSpent) ? telemetry.costSpent : 0;

  const parts = [
    paint(provider, [ANSI.bold, ANSI.cyan], color),
    paint(`${glyph} ${tps} tok/s`, [ANSI.green], color),
    paint(formatTokens(telemetry.totalTokens), [ANSI.dim], color),
    paint(`${(durationMs / 1000).toFixed(2)}s`, [ANSI.yellow], color),
    paint(`${formatCost(cost)}`, [ANSI.magenta], color),
  ];

  if (opts.compact !== true) {
    if ((telemetry.attempts ?? 1) > 1) parts.push(paint(`↻${telemetry.attempts}`, [ANSI.yellow], color));
    if ((telemetry.completionTokens ?? 0) > 0) {
      parts.push(paint(`↓${formatNumber(telemetry.completionTokens)}`, [ANSI.dim], color));
    }
  }

  return parts.join(paint(" · ", [ANSI.dim], color));
}

/** Markdown-safe variant for chat transports that render Markdown. */
export function formatTelemetryMarkdown(telemetry = {}) {
  const tps = Number.isFinite(telemetry.tokensPerSecond) ? telemetry.tokensPerSecond.toFixed(1) : "0.0";
  const durationMs = Number.isFinite(telemetry.durationMs) ? telemetry.durationMs : 0;
  return [
    `\`[${telemetry.providerName ?? "provider"}]\``,
    `⚡ ${tps} tok/s`,
    `${formatTokens(telemetry.totalTokens)}`,
    `${(durationMs / 1000).toFixed(2)}s`,
    `${formatCost(telemetry.costSpent)}`,
  ].join(" · ");
}

/**
 * Live session bar: accumulates completions and rewrites one line in place on
 * a TTY, or appends lines when piped. Dedupes identical frames.
 */
export class TelemetryBar {
  constructor({ stream = process.stdout, color, enabled = true } = {}) {
    this.stream = stream;
    this.color = color;
    this.enabled = enabled;
    this.session = {
      requests: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costSpent: 0,
      totalDurationMs: 0,
      lastTelemetry: null,
    };
    this._lastLine = "";
    this._startedAt = Date.now();
  }

  record(telemetry = {}, { error = false } = {}) {
    const s = this.session;
    if (error) {
      s.errors += 1;
    } else {
      s.requests += 1;
      s.promptTokens += Number.isFinite(telemetry.promptTokens) ? telemetry.promptTokens : 0;
      s.completionTokens += Number.isFinite(telemetry.completionTokens) ? telemetry.completionTokens : 0;
      s.totalTokens += Number.isFinite(telemetry.totalTokens) ? telemetry.totalTokens : 0;
      s.costSpent += Number.isFinite(telemetry.costSpent) ? telemetry.costSpent : 0;
      s.totalDurationMs += Number.isFinite(telemetry.durationMs) ? telemetry.durationMs : 0;
      s.lastTelemetry = telemetry;
    }
    return this;
  }

  snapshot() {
    const s = this.session;
    const avgTps = s.totalDurationMs > 0 ? (s.completionTokens / (s.totalDurationMs / 1000)).toFixed(1) : "0.0";
    const errorRate = s.requests + s.errors > 0 ? ((s.errors / (s.requests + s.errors)) * 100).toFixed(0) : "0";
    return { ...s, avgTps, errorRatePct: Number(errorRate), uptimeMs: Date.now() - this._startedAt };
  }

  render() {
    if (!this.enabled) return "";
    const snap = this.snapshot();
    const color = colorEnabled({ color: this.color });
    const last = snap.lastTelemetry ?? {};
    const glyph = BREAKER_GLYPH[last.breakerState] ?? BREAKER_GLYPH.CLOSED;
    const line = [
      paint(`${glyph} CloudClaw`, [ANSI.bold, ANSI.cyan], color),
      paint(`${snap.requests} req`, [ANSI.dim], color),
      paint(formatTokens(snap.totalTokens), [ANSI.dim], color),
      paint(`${snap.avgTps} tok/s`, [ANSI.green], color),
      paint(formatCost(snap.costSpent), [ANSI.magenta], color),
      paint(snap.errors > 0 ? `${snap.errors} err (${snap.errorRatePct}%)` : "0 err", [snap.errors > 0 ? ANSI.red : ANSI.dim], color),
    ].join(paint(" │ ", [ANSI.dim], color));

    const width = this.stream?.isTTY ? (this.stream.columns ?? 0) : 0;
    const out = width > 20 && line.length > width ? `${line.slice(0, width - 1)}…` : line;
    if (out === this._lastLine) return out;
    this._lastLine = out;

    if (this.stream?.isTTY) this.stream.write(`\r${out}\x1b[K`);
    else this.stream.write(`${out}\n`);
    return out;
  }

  /** Finish the in-place line (TTY) so subsequent logs start clean. */
  stop() {
    if (this.stream?.isTTY && this._lastLine) this.stream.write("\n");
    this._lastLine = "";
  }
}

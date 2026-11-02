import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTelemetryBar, formatTelemetryMarkdown, formatNumber, formatCost,
  formatTokens, BREAKER_GLYPH, TelemetryBar,
} from "../src/telemetry.mjs";

const sample = {
  providerName: "Groq", tokensPerSecond: 184.2, totalTokens: 512,
  durationMs: 420, costSpent: 0, completionTokens: 300,
  breakerState: "CLOSED", attempts: 1,
};

test("formatTelemetryBar renders provider, speed, tokens, latency, cost", () => {
  const bar = formatTelemetryBar(sample, { color: false });
  assert.match(bar, /\[Groq\]/);
  assert.match(bar, /184\.2 tok\/s/);
  assert.match(bar, /512 tok/);
  assert.match(bar, /0\.42s/);
  assert.match(bar, /\$0\.0000/);
});

test("formatTelemetryBar contains no ANSI escapes when color is off", () => {
  const bar = formatTelemetryBar(sample, { color: false });
  assert.equal(bar.includes("\x1b["), false);
});

test("formatTelemetryBar emits ANSI when color is on", () => {
  const bar = formatTelemetryBar(sample, { color: true });
  assert.equal(bar.includes("\x1b["), true);
});

test("breaker glyphs distinguish states", () => {
  assert.equal(formatTelemetryBar({ ...sample, breakerState: "OPEN" }, { color: false }).includes(BREAKER_GLYPH.OPEN), true);
  assert.equal(formatTelemetryBar({ ...sample, breakerState: "HALF-OPEN" }, { color: false }).includes(BREAKER_GLYPH["HALF-OPEN"]), true);
});

test("telemetry bar tolerates missing fields", () => {
  const bar = formatTelemetryBar({}, { color: false });
  assert.match(bar, /\[provider\]/);
  assert.match(bar, /0\.0 tok\/s/);
});

test("number, cost and token formatting", () => {
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(0.001234), "$0.0012");
  assert.equal(formatTokens(512), "512 tok");
  assert.equal(formatTokens(4_800_000), "4.8M tok");
});

test("markdown telemetry has no ANSI and keeps telemetry data", () => {
  const md = formatTelemetryMarkdown(sample);
  assert.equal(md.includes("\x1b["), false);
  assert.match(md, /Groq/);
  assert.match(md, /184\.2 tok\/s/);
});

test("TelemetryBar accumulates session totals and dedupes frames", () => {
  const writes = [];
  const stream = { isTTY: false, write: (s) => writes.push(s) };
  const bar = new TelemetryBar({ stream, color: false });
  bar.record(sample).render();
  bar.record({ ...sample, totalTokens: 1000, costSpent: 0.002 }).render();
  const snap = bar.snapshot();
  assert.equal(snap.requests, 2);
  assert.equal(snap.totalTokens, 1512);
  assert.ok(Math.abs(snap.costSpent - 0.002) < 1e-9);
  assert.equal(writes.length, 2);
  // identical frame is not rewritten
  bar.render();
  assert.equal(writes.length, 2);
});

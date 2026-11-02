import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, escapeHtml } from "../examples/telegram-bridge.mjs";

test("chunkText leaves short text alone", () => {
  assert.deepEqual(chunkText("hello", 4096), ["hello"]);
});

test("chunkText splits long text under the Telegram limit", () => {
  const line = "a".repeat(99) + "\n";
  const text = line.repeat(100); // 10,000 chars
  const chunks = chunkText(text, 4000);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 4000, `chunk too long: ${c.length}`);
  assert.equal(chunks.join("\n").replace(/\n+/g, "\n").length > 0, true);
});

test("chunkText prefers newline boundaries", () => {
  const text = `${"x".repeat(50)}\n${"y".repeat(50)}\n${"z".repeat(50)}`;
  const chunks = chunkText(text, 60);
  assert.equal(chunks[0], "x".repeat(50));
});

test("escapeHtml neutralizes tags and entities", () => {
  assert.equal(escapeHtml("<b>hi & bye</b>"), "&lt;b&gt;hi &amp; bye&lt;/b&gt;");
});

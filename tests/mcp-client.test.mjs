import test from "node:test";
import assert from "node:assert/strict";
import { StdioMCPClient, sanitizeToolName, runToolLoop } from "../src/mcp-client.mjs";

const FIXTURE = new URL("./fixtures/mock-mcp-server.mjs", import.meta.url).pathname;

test("handshake, tools/list and OpenAI schema translation", async () => {
  const client = new StdioMCPClient({ command: process.execPath, args: [FIXTURE], name: "mock" });
  try {
    await client.start();
    assert.equal(client.ready, true);
    const tools = await client.listTools();
    assert.equal(tools.length, 2);
    const openai = await client.getOpenAITools();
    assert.equal(openai[0].type, "function");
    assert.equal(openai[0].function.name, "echo");
    assert.equal(openai[0].function.parameters.type, "object");
  } finally {
    await client.close();
  }
});

test("callTool returns flattened text content", async () => {
  const client = new StdioMCPClient({ command: process.execPath, args: [FIXTURE] });
  try {
    await client.start();
    const out = await client.callTool("echo", { text: "hello" });
    assert.equal(out, "echo:hello");
  } finally {
    await client.close();
  }
});

test("tool errors reject with the server message", async () => {
  const client = new StdioMCPClient({ command: process.execPath, args: [FIXTURE] });
  try {
    await client.start();
    await assert.rejects(() => client.callTool("boom", {}), /boom failed intentionally/);
  } finally {
    await client.close();
  }
});

test("request timeout rejects rather than hanging", async () => {
  const client = new StdioMCPClient({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    name: "silent",
    requestTimeoutMs: 500,
  });
  try {
    await assert.rejects(
      () => client.start().catch((e) => { throw e; }),
      /timed out/
    );
  } finally {
    await client.close();
  }
});

test("sanitizeToolName enforces OpenAI constraints", () => {
  assert.equal(sanitizeToolName("read file.txt"), "read_file_txt");
  assert.equal(sanitizeToolName("a".repeat(80)).length, 64);
  assert.equal(sanitizeToolName(""), "tool");
});

test("runToolLoop executes a tool call then returns final answer", async () => {
  const client = new StdioMCPClient({ command: process.execPath, args: [FIXTURE] });
  await client.start();
  const scripts = [
    {
      choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } }],
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    {
      choices: [{ message: { role: "assistant", content: "final answer" } }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    },
  ];
  let i = 0;
  const seen = [];
  const router = {
    complete: async (messages, tools) => {
      seen.push({ messages: messages.length, tools: tools.length });
      const step = scripts[Math.min(i++, scripts.length - 1)];
      return { message: step.choices[0].message, telemetry: { totalTokens: step.usage.total_tokens }, statusBar: "" };
    },
  };
  try {
    const out = await runToolLoop({
      router,
      messages: [{ role: "user", content: "use echo" }],
      clients: [client],
    });
    assert.equal(out.message.content, "final answer");
    assert.equal(out.iterations, 2);
    assert.equal(out.limitHit, false);
    assert.equal(out.telemetry.length, 2);
    const toolMsg = out.messages.find((m) => m.role === "tool");
    assert.equal(toolMsg.content, "echo:hi");
    assert.equal(seen[0].tools, 2, "tool schemas offered to model");
    assert.equal(out.messages[0].role, "user");
  } finally {
    await client.close();
  }
});

test("runToolLoop reports unknown tools as tool errors, not crashes", async () => {
  const client = new StdioMCPClient({ command: process.execPath, args: [FIXTURE] });
  await client.start();
  const scripts = [
    { choices: [{ message: { role: "assistant", content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "nope", arguments: "{}" } }] } }], usage: {} },
    { choices: [{ message: { role: "assistant", content: "recovered" } }], usage: {} },
  ];
  let i = 0;
  const router = { complete: async () => {
    const step = scripts[Math.min(i++, scripts.length - 1)];
    return { message: step.choices[0].message, telemetry: {}, statusBar: "" };
  } };
  try {
    const out = await runToolLoop({ router, messages: [{ role: "user", content: "x" }], clients: [client] });
    const toolMsg = out.messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /unknown tool "nope"/);
    assert.equal(out.message.content, "recovered");
  } finally {
    await client.close();
  }
});

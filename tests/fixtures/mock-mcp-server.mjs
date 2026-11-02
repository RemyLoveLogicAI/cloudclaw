#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC) for tests.
import readline from "node:readline";

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the provided text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "boom",
    description: "Always fails, to test error mapping.",
    inputSchema: { type: "object", properties: {} },
  },
];

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-mcp", version: "0.0.1" },
    }});
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params ?? {};
    if (name === "echo") {
      return send({ jsonrpc: "2.0", id: msg.id, result: {
        content: [{ type: "text", text: `echo:${args?.text ?? ""}` }],
      }});
    }
    if (name === "boom") {
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom failed intentionally" } });
    }
    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } });
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
});

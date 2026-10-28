import { expect, test } from "bun:test";
import { AcpSessionControl } from "./acp-session";

const frame = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

test("opens, filters session updates and waits for an explicit permission decision", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const updates: unknown[] = [];
  const decision = Promise.withResolvers<string | null>();
  let acknowledged = false;
  let client: AcpSessionControl;
  client = new AcpSessionControl(async (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    sent.push(message);
    if (message.method === "initialize") queueMicrotask(() => client.ingest(frame({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })));
    if (message.method === "session/new") queueMicrotask(() => {
      client.ingest(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native" } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "available_commands_update" } } })}\n`));
    });
  }, () => decision.promise, (_id, update) => updates.push(update), () => { acknowledged = true; });
  expect(await client.open("/work")).toBe("native");
  expect(updates).toEqual([{ sessionUpdate: "available_commands_update" }]);
  client.ingest(frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk" } } }));
  client.ingest(frame({ jsonrpc: "2.0", id: "ask", method: "session/request_permission", params: { sessionId: "native", toolCall: { title: "write" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "deny", kind: "reject_once", name: "Deny" }] } }));
  await Promise.resolve();
  expect(sent.filter((message) => message.id === "ask")).toEqual([]);
  expect(acknowledged).toBe(false);
  decision.resolve("deny");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent.find((message) => message.id === "ask")?.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
  expect(acknowledged).toBe(true);
  await client.cancel();
  expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "native" } });
  expect(updates).toHaveLength(1);
  client.close();
});

test("a missing native session fails closed on load rather than creating a new one", async () => {
  const methods: string[] = [];
  let client: AcpSessionControl;
  client = new AcpSessionControl(async (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    methods.push(String(message.method));
    queueMicrotask(() => client.ingest(frame({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { loadSession: true } } : { sessions: [] } })));
  }, async () => null, () => {});
  await expect(client.open("/work", "missing")).rejects.toThrow("could not be restored");
  expect(methods).toEqual(["initialize", "session/list"]);
  client.close();
});

test("an empty successful load response does not prove restoration", async () => {
  let client: AcpSessionControl;
  client = new AcpSessionControl(async (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const result = message.method === "initialize"
      ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      : message.method === "session/list" ? { sessions: [{ sessionId: "missing" }] } : {};
    queueMicrotask(() => client.ingest(frame({ jsonrpc: "2.0", id: message.id, result })));
  }, async () => null, () => {});
  await expect(client.open("/work", "missing")).rejects.toThrow("could not be restored");
  client.close();
});

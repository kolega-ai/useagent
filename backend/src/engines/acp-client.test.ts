import { describe, expect, test } from "bun:test";
import { AcpClient } from "./acp-client";

const bytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

describe("ACP client", () => {
  test("correlates fragmented responses and streams notifications", async () => {
    const sent: string[] = [];
    const updates: unknown[] = [];
    const client = new AcpClient(async (line) => { sent.push(line); }, async () => ({}), (method, params) => updates.push([method, params]));
    const first = client.request("session/new", { cwd: "/work" });
    const second = client.request("initialize", { protocolVersion: 1 });
    const reply = bytes({ jsonrpc: "2.0", id: 2, result: { protocolVersion: 1 } });
    client.ingest(reply.slice(0, 10));
    client.ingest(reply.slice(10));
    client.ingest(bytes({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s" } }));
    client.ingest(bytes({ jsonrpc: "2.0", id: 1, result: { sessionId: "s" } }));
    expect(await first).toEqual({ sessionId: "s" });
    expect(await second).toEqual({ protocolVersion: 1 });
    expect(updates).toEqual([["session/update", { sessionId: "s" }]]);
    expect(sent.map((line) => JSON.parse(line).method)).toEqual(["session/new", "initialize"]);
    client.close();
  });

  test("permission responses wait for the handler rather than auto-approve", async () => {
    const sent: string[] = [];
    const answer = Promise.withResolvers<unknown>();
    const client = new AcpClient(async (line) => { sent.push(line); }, () => answer.promise, () => {});
    client.ingest(bytes({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "s" } }));
    await Promise.resolve();
    expect(sent).toEqual([]);
    answer.resolve({ outcome: { outcome: "selected", optionId: "reject-once" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(sent[0]!)).toEqual({ jsonrpc: "2.0", id: "permission-1", result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
    client.close();
  });

  test("connection loss rejects pending requests and cancellation is a notification", async () => {
    const sent: string[] = [];
    const client = new AcpClient(async (line) => { sent.push(line); }, async () => ({}), () => {});
    const pending = client.request("session/prompt", {});
    await client.notify("session/cancel", { sessionId: "s" });
    client.close();
    await expect(pending).rejects.toThrow("disconnected");
    expect(JSON.parse(sent[1]!)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
  });
});

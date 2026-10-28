import { expect, test } from "bun:test";
import { AcpApprovals } from "./acp-approvals";
import type { AcpPermission } from "./acp-session";

const permission: AcpPermission = {
  sessionId: "native", toolCall: { kind: "execute", title: "Run test command" },
  options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Reject" }],
};
const identity = { runId: "run-1", threadId: "thread-1", sessionId: "native", permissionMode: "approval-required" as const };
const redact = { text: (value: string) => value };

test("ACP approvals are bound to the run and acknowledged before a durable receipt", async () => {
  const events: Array<{ eventType: string; payload?: unknown; id: string }> = [];
  const requested = Promise.withResolvers<void>();
  const ledger = {
    record: (async (event: typeof events[number]) => { events.push(event); if (event.eventType === "approval.requested") requested.resolve(); }) as never,
    exists: (async (id: string) => events.some((event) => event.id === id && event.eventType === "approval.responded")) as never,
  };
  const approvals = new AcpApprovals(ledger);
  const nativeReply = approvals.request({ ...identity, permission, redact });
  await requested.promise;
  const requestId = (events[0]!.payload as { id: string }).id;
  await expect(approvals.reply({ ...identity, runId: "wrong", requestId, decision: "accept" })).rejects.toMatchObject({ code: "approval_not_pending" });
  const reply = approvals.reply({ ...identity, requestId, decision: "accept" });
  expect(await nativeReply).toBe("yes");
  expect(events.map((event) => event.eventType)).toEqual(["approval.requested", "approval.responding"]);
  await expect(approvals.reply({ ...identity, requestId, decision: "decline" })).rejects.toMatchObject({ code: "approval_not_pending" });
  approvals.acknowledge(permission);
  expect(await reply).toEqual({ alreadyAnswered: false });
  expect(events.map((event) => event.eventType)).toEqual(["approval.requested", "approval.responding", "approval.responded"]);
  expect(await approvals.reply({ ...identity, requestId, decision: "accept" })).toEqual({ alreadyAnswered: true });
});

test("read-only sessions refuse a command without granting it", async () => {
  const approvals = new AcpApprovals({ record: (async () => { throw new Error("unexpected event"); }) as never, exists: (async () => false) as never });
  expect(await approvals.request({ ...identity, permissionMode: "read-only", permission, redact })).toBe("no");
});

test("session cancellation rejects a pending native approval", async () => {
  const requested = Promise.withResolvers<void>();
  const approvals = new AcpApprovals({ record: (async () => requested.resolve()) as never, exists: (async () => false) as never });
  const answer = approvals.request({ ...identity, permission, redact });
  await requested.promise;
  approvals.cancelSession("native");
  expect(await answer).toBeNull();
});

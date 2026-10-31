import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { markForRetry, type OutboxTable } from "../src/db/outbox";
import { member } from "../src/db/auth-schema";
import { automationCodeActions, commands, runs, schedules } from "../src/db/schema";
import type { AutomationCodePolicy } from "../src/db/schema/schedules";
import { explicitRepositoryResources, resolveRunIntake } from "../src/resources/run-intake";
import { acceptRunCancel } from "../src/commands/cancel";
import { CodeActionAuthorityError, assertCodeActionAuthorized, attachCodeAction, codeSandboxPermission,
  getCodeAction, recordCodeActionOutcome, selectCodeAction, settleCodeAction } from "../src/schedules/code-actions-repo";
import { drainCodeActions, executeCodeAction, resetStuckCodeActions } from "../src/schedules/code-actions-worker";
import { getScheduleForOrg, updateSchedule } from "../src/schedules/repo";
import { createOrgSession, fetchApi, json, userIdOf, waitFor } from "./helpers";

const policy = { version: 1 as const, mode: "publish" as const, repository: "owner/repo", draft: true, allowSandboxActions: true };
const directPolicy = { version: 2 as const, mode: "agent" as const, repository: "owner/repo", draft: false as const, allowSandboxActions: true };

async function fixture(attach = true, selectedPolicy: AutomationCodePolicy = policy) {
  const session = await createOrgSession("auto-code");
  const userId = await userIdOf(session);
  const [schedule] = await db.insert(schedules).values({ orgId: session.orgId, userId, name: "Code action", cron: "0 9 * * *",
    timezone: "UTC", prompt: "Make a small change", engine: "kolega", model: "deepseek/deepseek-flash", repos: [selectedPolicy.repository], codePolicy: selectedPolicy }).returning();
  const intake = await resolveRunIntake({ source: "automation", text: "", explicitResources: explicitRepositoryResources([selectedPolicy.repository]) },
    { authorize: async () => ({ available: true, capabilities: ["content.read", "code.checkout"] }) });
  const key = `fixture:${crypto.randomUUID()}`;
  const action = await selectCodeAction(schedule!, key, new AbortController().signal);
  if (!action) throw new Error("Expected action");
  const runId = crypto.randomUUID();
  await db.insert(runs).values({ id: runId, orgId: session.orgId, userId, prompt: "fixture", model: "deepseek/deepseek-flash", engine: "kolega",
    status: "running", origin: "product:automation", threadId: runId, resolvedResources: intake.resources });
  if (attach) await attachCodeAction(key, runId);
  return { session, userId, schedule: schedule!, runId, key, action };
}

describe("unattended repository actions", () => {
  test("the owner can opt into native auto and an older editor cannot silently clear it", async () => {
    const f = await fixture(true, directPolicy);
    const update = (codePolicy: Record<string, unknown>) => json<{ code_policy: AutomationCodePolicy }>(`/api/schedules/${f.schedule.id}`, {
      method: "PATCH", cookies: f.session.cookies, body: { codePolicy },
    });
    const enabled = await update({ ...directPolicy, nativeAuto: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.code_policy).toEqual({ ...directPolicy, nativeAuto: true });
    const oldEditor = await update(directPolicy);
    expect(oldEditor.status).toBe(200);
    expect(oldEditor.body.code_policy).toEqual({ ...directPolicy, nativeAuto: true });
    const disabled = await update({ ...directPolicy, nativeAuto: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.code_policy).toEqual({ ...directPolicy, nativeAuto: false });
    const invalid = await update({ ...directPolicy, allowSandboxActions: false, nativeAuto: true });
    expect(invalid.status).toBe(400);
  });

  test("an agent-managed firing finishes without queuing a backend publication", async () => {
    const f = await fixture(true, directPolicy);
    expect(f.action.target).toBeNull();
    expect(await codeSandboxPermission(f.runId, f.runId)).toBe(true);
    expect(await codeSandboxPermission(f.runId, f.runId, "other")).toBe(true);
    await db.transaction((tx) => settleCodeAction(f.runId, "completed", tx));
    expect(await getCodeAction(f.key)).toMatchObject({ state: "done", resultReason: "The agent completed the run.", resultUrl: null });
    await drainCodeActions();
    expect((await getCodeAction(f.key))?.state).toBe("done");
  });

  test("attachment and crash recovery settle an agent-managed run without publication", async () => {
    const beforeAttach = await fixture(false, directPolicy);
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, beforeAttach.runId));
    await attachCodeAction(beforeAttach.key, beforeAttach.runId);
    expect(await getCodeAction(beforeAttach.key)).toMatchObject({ state: "done", resultReason: "The agent completed the run." });

    const crashed = await fixture(false, directPolicy);
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, crashed.runId));
    await db.insert(commands).values({ id: crypto.randomUUID(), orgId: crashed.session.orgId, idempotencyKey: crashed.key,
      kind: "run.create", runId: crashed.runId, state: "completed" });
    await resetStuckCodeActions();
    expect(await getCodeAction(crashed.key)).toMatchObject({ runId: crashed.runId, state: "done", resultReason: "The agent completed the run." });
  });

  test("an approval arriving before firing attachment recovers its durable binding", async () => {
    const f = await fixture(false, directPolicy);
    await db.insert(commands).values({ id: crypto.randomUUID(), orgId: f.session.orgId, idempotencyKey: f.key,
      kind: "run.create", runId: f.runId, state: "dispatched" });
    expect(await codeSandboxPermission(f.runId, f.runId)).toBe(true);
    expect(await getCodeAction(f.key)).toMatchObject({ runId: f.runId, state: "waiting" });
    await attachCodeAction(f.key, f.runId);
  });

  test("a failed agent-managed run and a stray worker claim cannot publish", async () => {
    const failed = await fixture(true, directPolicy);
    await db.transaction((tx) => settleCodeAction(failed.runId, "failed", tx));
    expect((await getCodeAction(failed.key))?.state).toBe("dead");
    const stray = await fixture(true, directPolicy);
    await db.update(automationCodeActions).set({ state: "processing", claimToken: crypto.randomUUID() }).where(eq(automationCodeActions.idempotencyKey, stray.key));
    await executeCodeAction((await getCodeAction(stray.key))!, new AbortController().signal);
    expect((await getCodeAction(stray.key))?.state).toBe("dead");
  });

  test("the per-firing selection is durable and sandbox access is bound to its owner and run", async () => {
    const f = await fixture();
    const again = await selectCodeAction(f.schedule, f.key, new AbortController().signal);
    expect(again?.runId).toBe(f.runId);
    expect(await codeSandboxPermission(f.runId, f.runId)).toBe(true);
    expect(await codeSandboxPermission(f.runId, f.runId, "other")).toBe(false);
    expect(await codeSandboxPermission(f.runId, "another-thread")).toBe(false);
    await db.update(runs).set({ userId: "another-user" }).where(eq(runs.id, f.runId));
    expect(await codeSandboxPermission(f.runId, f.runId)).toBe(false);
  });

  test("an edit revokes in-flight authority even if its timestamp is unchanged", async () => {
    const f = await fixture();
    await updateSchedule(f.session.orgId, f.schedule.id, { prompt: "Changed instructions" });
    await db.update(schedules).set({ updatedAt: f.schedule.updatedAt }).where(eq(schedules.id, f.schedule.id));
    expect(await codeSandboxPermission(f.runId, f.runId)).toBe(false);
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, f.runId));
    await db.update(automationCodeActions).set({ state: "processing", claimToken: crypto.randomUUID() }).where(eq(automationCodeActions.idempotencyKey, f.key));
    const action = await getCodeAction(f.key);
    await expect(assertCodeActionAuthorized(action!)).rejects.toBeInstanceOf(CodeActionAuthorityError);
  });

  test("removing organization membership revokes a selected action", async () => {
    const f = await fixture();
    await db.delete(member).where(and(eq(member.organizationId, f.session.orgId), eq(member.userId, f.userId)));
    expect(await codeSandboxPermission(f.runId, f.runId)).toBe(false);
  });

  test("stopping a queued run settles the action both before and after attachment", async () => {
    for (const attach of [true, false]) {
      const f = await fixture(attach);
      await db.update(runs).set({ status: "queued" }).where(eq(runs.id, f.runId));
      expect((await acceptRunCancel({ orgId: f.session.orgId, actorId: f.userId, runId: f.runId })).status).toBe("accepted");
      if (!attach) await attachCodeAction(f.key, f.runId);
      expect(await getCodeAction(f.key)).toMatchObject({ runId: f.runId, state: "dead" });
      expect(await codeSandboxPermission(f.runId, f.runId)).toBe(false);
    }
  });

  test("attachment racing queued cancellation cannot leave an action waiting", async () => {
    const f = await fixture(false);
    await db.update(runs).set({ status: "queued" }).where(eq(runs.id, f.runId));
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, f.runId)).for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const attaching = attachCodeAction(f.key, f.runId);
    const cancelling = acceptRunCancel({ orgId: f.session.orgId, actorId: f.userId, runId: f.runId });
    try {
      await waitFor(async () => {
        const rows = await db.execute(sql`select count(*)::integer as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
        return Number(rows[0]?.waiting) >= 2 || null;
      });
    } finally { release.resolve(); }
    await holder;
    await attaching;
    expect((await cancelling).status).toBe("accepted");
    expect(await getCodeAction(f.key)).toMatchObject({ runId: f.runId, state: "dead" });
  });

  test("a completed run with an explicit skip never calls a provider", async () => {
    const f = await fixture();
    await db.update(runs).set({ status: "completed", summary: '{"decision":"skip"}' }).where(eq(runs.id, f.runId));
    await db.update(automationCodeActions).set({ state: "processing", claimToken: crypto.randomUUID() }).where(eq(automationCodeActions.idempotencyKey, f.key));
    await executeCodeAction((await getCodeAction(f.key))!, new AbortController().signal);
    expect(await getCodeAction(f.key)).toMatchObject({ state: "skipped", resultReason: "The agent chose not to act." });
  });

  test("a completed action is claimed and settled by the durable worker", async () => {
    const f = await fixture();
    await db.update(runs).set({ status: "completed", summary: '{"decision":"skip"}' }).where(eq(runs.id, f.runId));
    await db.update(automationCodeActions).set({ state: "pending", nextAttemptAt: new Date(0) }).where(eq(automationCodeActions.idempotencyKey, f.key));
    await drainCodeActions();
    const action = await waitFor(async () => {
      const row = await getCodeAction(f.key);
      return row?.state === "skipped" ? row : null;
    });
    expect(action.claimToken).toMatch(/^[a-f0-9-]{36}$/u);
    expect(action.resultReason).toBe("The agent chose not to act.");
  });

  test("a superseded claim cannot authorize, settle or retry a code action", async () => {
    const f = await fixture();
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, f.runId));
    await db.update(automationCodeActions).set({ state: "processing", claimToken: crypto.randomUUID() }).where(eq(automationCodeActions.idempotencyKey, f.key));
    const old = (await getCodeAction(f.key))!;
    const currentToken = crypto.randomUUID();
    await db.update(automationCodeActions).set({ claimToken: currentToken }).where(eq(automationCodeActions.idempotencyKey, f.key));
    await expect(assertCodeActionAuthorized(old)).rejects.toBeInstanceOf(CodeActionAuthorityError);
    await recordCodeActionOutcome(old, "done", "stale worker");
    const table: OutboxTable = { table: "automation_code_actions", key: "idempotency_key", stateColumn: "state", attemptColumn: "attempt_count",
      pending: "pending", claimed: "processing", dead: "dead", claimTokenColumn: "claim_token" };
    await markForRetry(table, f.key, new Date(), "stale worker", old.claimToken!);
    expect(await getCodeAction(f.key)).toMatchObject({ state: "processing", claimToken: currentToken, attemptCount: 0 });
    await markForRetry(table, f.key, new Date(Date.now() + 60_000), "current worker", currentToken);
    expect(await getCodeAction(f.key)).toMatchObject({ state: "pending", attemptCount: 1 });
  });

  test("code policy changes and run-now require a trusted browser origin", async () => {
    const f = await fixture();
    const invalid = { origin: "https://untrusted.example" };
    expect((await fetchApi(`/api/schedules/${f.schedule.id}`, { method: "PATCH", cookies: f.session.cookies,
      headers: invalid, body: { codePolicy: null } })).status).toBe(403);
    expect((await fetchApi(`/api/schedules/${f.schedule.id}/run-now`, { method: "POST", cookies: f.session.cookies,
      headers: invalid })).status).toBe(403);
    const removed = await json<{ code_policy: unknown }>(`/api/schedules/${f.schedule.id}`, {
      method: "PATCH", cookies: f.session.cookies, body: { codePolicy: null } });
    expect(removed.status).toBe(200);
    expect(removed.body.code_policy).toBeNull();
    expect((await getScheduleForOrg(f.session.orgId, f.schedule.id))?.codeGeneration).toBe(1);
  });

  test("an untrusted edit waiting on a newly enabled code policy cannot alter its instructions", async () => {
    const f = await fixture();
    await db.update(schedules).set({ codePolicy: null }).where(eq(schedules.id, f.schedule.id));
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = db.transaction(async (tx) => {
      await tx.update(schedules).set({ codePolicy: policy, codeGeneration: 1 }).where(eq(schedules.id, f.schedule.id));
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const request = fetchApi(`/api/schedules/${f.schedule.id}`, { method: "PATCH", cookies: f.session.cookies,
      headers: { origin: "https://untrusted.example" }, body: { prompt: "Change the authorized work" } });
    try {
      await waitFor(async () => {
        const rows = await db.execute(sql`select count(*)::integer as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
        return Number(rows[0]?.waiting) >= 1 || null;
      });
    } finally { release.resolve(); }
    await writer;
    expect((await request).status).toBe(403);
    expect((await getScheduleForOrg(f.session.orgId, f.schedule.id))?.prompt).toBe("Make a small change");
  });
});

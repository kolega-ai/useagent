// Durable per-firing selections and the trusted authority for code effects.
import { createHash } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { automationCodeActions, commands, member, runs, schedules } from "../db/schema";
import { stableJson } from "../github/publication-repo-input";
import type { ScheduleRecord } from "./repo";
import { findReviewTarget, reviewKey } from "./code-review-provider";
import { assertCodePolicyEngine, assertCodePolicyRepository } from "./code-policy";
import type { RuntimeApprovalRequest } from "../engines/runtime-approval";

export type CodeActionRecord = typeof automationCodeActions.$inferSelect;
export class CodeActionAuthorityError extends Error {
  constructor() { super("Automation code authority is no longer valid."); this.name = "CodeActionAuthorityError"; }
}

/** Also fences edits made by an older backend during a rolling deployment. */
function scheduleConfigHash(schedule: ScheduleRecord): string {
  const { orgId, userId, botId, prompt, engine, model, skillId, skillVersion, skillContentHash,
    repos, codePolicy, enabled, workspaceFileSelection } = schedule;
  return createHash("sha256").update(stableJson({ orgId, userId, botId, prompt, engine, model,
    skillId, skillVersion, skillContentHash, repos, codePolicy, enabled,
    ...(workspaceFileSelection?.length ? { workspaceFileSelection } : {}) })).digest("hex");
}

export async function getCodeAction(key: string, exec: Executor = db): Promise<CodeActionRecord | null> {
  const [row] = await exec.select().from(automationCodeActions).where(eq(automationCodeActions.idempotencyKey, key)).limit(1);
  return row ?? null;
}

/** Load only the current run's review binding, after rechecking its authority. */
export async function reviewTargetForRun(orgId: string, runId: string) {
  const [action] = await db.select().from(automationCodeActions).where(and(
    eq(automationCodeActions.orgId, orgId), eq(automationCodeActions.runId, runId),
    eq(automationCodeActions.state, "waiting"),
  )).limit(1);
  if (!action || action.policy.mode !== "review" || !action.target) return null;
  await assertCodeActionAuthorized(action, db, "sandbox");
  return action.target;
}

/** Persist the selection before accepting its run so a firing replay cannot pick a different revision. */
export async function selectCodeAction(schedule: ScheduleRecord, key: string, signal: AbortSignal): Promise<CodeActionRecord | null> {
  const existing = await getCodeAction(key);
  if (existing) {
    if (existing.scheduleId !== schedule.id || existing.orgId !== schedule.orgId) throw new Error("Automation action identity mismatch.");
    return existing;
  }
  const policy = schedule.codePolicy;
  if (!policy) return null;
  assertCodePolicyRepository(policy, schedule.repos, schedule.userId);
  assertCodePolicyEngine(policy, schedule.engine);
  if (!schedule.userId || schedule.botId) throw new Error("Code automation requires an owner and an independent thread.");
  // A selection that never reached command acceptance cannot reserve a review forever.
  await db.execute(sql`update automation_code_actions a set state = 'dead', last_error = 'Firing was not accepted.', updated_at = now()
    where a.schedule_id = ${schedule.id}::uuid and a.state = 'selected' and a.run_id is null
      and a.created_at < now() - interval '15 minutes'
      and not exists (select 1 from commands c where c.org_id = a.org_id and c.idempotency_key = a.idempotency_key)`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = policy.mode === "review" ? await db.select({ key: automationCodeActions.reviewKey }).from(automationCodeActions).where(and(
      eq(automationCodeActions.scheduleId, schedule.id), ne(automationCodeActions.state, "dead"),
    )).limit(10_000) : [];
    const excluded = new Set(rows.flatMap((row) => row.key ? [row.key] : []));
    const target = policy.mode === "review" ? await findReviewTarget(schedule.orgId, policy.repository, excluded, signal) : null;
    const [inserted] = await db.insert(automationCodeActions).values({ idempotencyKey: key, scheduleId: schedule.id,
      orgId: schedule.orgId, ownerUserId: schedule.userId, policy, scheduleUpdatedAt: schedule.updatedAt,
      scheduleGeneration: schedule.codeGeneration, scheduleConfigHash: scheduleConfigHash(schedule),
      target, reviewKey: target ? reviewKey(target) : null }).onConflictDoNothing().returning();
    if (inserted) return inserted;
    const raced = await getCodeAction(key);
    if (raced) return raced;
  }
  throw new Error("Could not reserve a review request. Retry the automation.");
}

export async function attachCodeAction(key: string, runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', '10000', true), set_config('statement_timeout', '10000', true)`);
    // Cancellation and finalization lock this row too. Whichever wins settles
    // the selected action, including a Stop between acceptance and attachment.
    const [run] = await tx.select({ status: runs.status, orgId: runs.orgId, userId: runs.userId, origin: runs.origin })
      .from(runs).where(eq(runs.id, runId)).limit(1).for("update");
    const existing = await getCodeAction(key, tx);
    if (!run || !existing || run.orgId !== existing.orgId || run.userId !== existing.ownerUserId ||
        run.origin !== "product:automation") throw new Error("Automation action run identity mismatch.");
    if (existing.runId === runId) return;
    if (existing.runId || existing.state !== "selected") throw new Error("Automation action run identity mismatch.");
    const state = run.status === "completed" ? existing.policy.mode === "agent" ? "done" : "pending" : run.status === "failed" ? "dead" : "waiting";
    const [row] = await tx.update(automationCodeActions).set({ runId, state,
      resultReason: state === "dead" ? "The automation run did not complete." : state === "done" ? "The agent completed the run." : null, updatedAt: new Date() })
      .where(and(eq(automationCodeActions.idempotencyKey, key), eq(automationCodeActions.state, "selected")))
      .returning({ runId: automationCodeActions.runId });
    if (row?.runId !== runId) throw new Error("Automation action run identity mismatch.");
  });
}

/** Settle in the same transaction as the run; failed/cancelled runs cannot publish. */
export async function settleCodeAction(runId: string, status: "completed" | "failed", exec: Executor): Promise<void> {
  await exec.update(automationCodeActions).set({
    state: status === "completed" ? sql`case when ${automationCodeActions.policy}->>'mode' = 'agent' then 'done' else 'pending' end` : "dead",
    resultReason: status === "completed" ? sql`case when ${automationCodeActions.policy}->>'mode' = 'agent' then 'The agent completed the run.' else null end` : "The automation run did not complete.",
    updatedAt: new Date() })
    .where(and(eq(automationCodeActions.runId, runId), eq(automationCodeActions.state, "waiting")));
}

/** Re-read membership, the owning schedule, its exact policy and run at the effect boundary. */
export async function assertCodeActionAuthorized(action: CodeActionRecord, exec: Executor = db, phase: "effect" | "sandbox" = "effect"): Promise<void> {
  if (phase === "effect" && !action.claimToken) throw new CodeActionAuthorityError();
  const [row] = await exec.select({ schedule: schedules, run: runs, memberId: member.id }).from(automationCodeActions)
    .innerJoin(schedules, eq(schedules.id, automationCodeActions.scheduleId))
    .innerJoin(runs, eq(runs.id, automationCodeActions.runId))
    .innerJoin(member, and(eq(member.organizationId, automationCodeActions.orgId), eq(member.userId, automationCodeActions.ownerUserId)))
    .where(and(eq(automationCodeActions.idempotencyKey, action.idempotencyKey),
      eq(automationCodeActions.state, phase === "effect" ? "processing" : "waiting"),
      ...(phase === "effect" ? [eq(automationCodeActions.claimToken, action.claimToken!)] : [])))
    .limit(1);
  if (!row || row.schedule.orgId !== action.orgId || row.run.orgId !== action.orgId || row.run.userId !== action.ownerUserId ||
      row.schedule.userId !== action.ownerUserId || row.run.engine !== row.schedule.engine || row.run.model !== row.schedule.model ||
      row.run.status !== (phase === "effect" ? "completed" : "running") || row.run.origin !== "product:automation" ||
      row.schedule.updatedAt.getTime() !== action.scheduleUpdatedAt.getTime() ||
      row.schedule.codeGeneration !== action.scheduleGeneration || scheduleConfigHash(row.schedule) !== action.scheduleConfigHash ||
      !row.schedule.codePolicy ||
      stableJson(row.schedule.codePolicy) !== stableJson(action.policy) || !row.run.resolvedResources.some((resource) => {
        if (resource.locator.type === "gitlab.repository") return `gitlab.com/${resource.locator.repository}` === action.policy.repository && resource.capabilities.includes("code.checkout");
        return resource.locator.type === "github.repository" && resource.locator.repository.toLowerCase() === action.policy.repository.toLowerCase() && resource.capabilities.includes("code.checkout");
      })) throw new CodeActionAuthorityError();
  if (action.policy.mode === "review" && action.target) {
    const target = action.target;
    if (target.repository !== action.policy.repository ||
        (target.provider === "gitlab") !== target.repository.startsWith("gitlab.com/") ||
        !/^[a-f0-9]{40}$/u.test(target.headSha)) throw new CodeActionAuthorityError();
    const bound = row.run.resolvedResources.some((resource) => target.provider === "github"
      ? resource.locator.type === "github.pull_request" && resource.locator.repository.toLowerCase() === target.repository.toLowerCase() &&
        resource.locator.number === target.number && resource.locator.revision === target.headSha
      : resource.locator.type === "gitlab.repository" && `gitlab.com/${resource.locator.repository}` === target.repository &&
        resource.locator.revision === target.sourceBranch);
    if (!bound) throw new CodeActionAuthorityError();
  }
}

/** Only an explicitly opted-in, still-authorized firing can approve sandbox work. */
export async function codeSandboxPermission(runId: string, threadId: string, kind: RuntimeApprovalRequest["requestKind"] = "command"): Promise<boolean> {
  const readAction = async () => (await db.select().from(automationCodeActions).where(and(
    eq(automationCodeActions.runId, runId), eq(automationCodeActions.state, "waiting"),
  )).limit(1))[0];
  let action = await readAction();
  if (!action) {
    // The fleet may start a just-accepted run before the firing attaches its
    // selection. Recover the same durable command binding before answering.
    const [selected] = await db.select({ key: automationCodeActions.idempotencyKey }).from(automationCodeActions)
      .innerJoin(commands, and(eq(commands.orgId, automationCodeActions.orgId), eq(commands.idempotencyKey, automationCodeActions.idempotencyKey)))
      .where(and(eq(commands.runId, runId), eq(commands.kind, "run.create"), eq(automationCodeActions.state, "selected"), isNull(automationCodeActions.runId))).limit(1);
    if (selected) {
      await attachCodeAction(selected.key, runId);
      action = await readAction();
    }
  }
  if (!action || !action.policy.allowSandboxActions || (kind === "other" && action.policy.mode !== "agent")) return false;
  const [run] = await db.select({ threadId: runs.threadId }).from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run || run.threadId !== threadId) return false;
  try { await assertCodeActionAuthorized(action, db, "sandbox"); return true; } catch { return false; }
}

export async function setActionChangeSet(action: CodeActionRecord, changeSetId: string): Promise<boolean> {
  if (!action.claimToken) return false;
  const [row] = await db.update(automationCodeActions).set({ changeSetId, updatedAt: new Date() }).where(and(
    eq(automationCodeActions.idempotencyKey, action.idempotencyKey), eq(automationCodeActions.state, "processing"),
    eq(automationCodeActions.claimToken, action.claimToken),
    sql`(${automationCodeActions.changeSetId} IS NULL OR ${automationCodeActions.changeSetId} = ${changeSetId}::uuid)`,
  )).returning({ id: automationCodeActions.idempotencyKey });
  return Boolean(row);
}

export async function recordCodeActionOutcome(action: CodeActionRecord, state: "done" | "skipped", reason: string, url?: string | null): Promise<void> {
  if (!action.claimToken) return;
  await db.update(automationCodeActions).set({ state, resultReason: reason.slice(0, 300), resultUrl: url ?? null,
    lastError: null, updatedAt: new Date() }).where(and(eq(automationCodeActions.idempotencyKey, action.idempotencyKey),
      eq(automationCodeActions.state, "processing"), eq(automationCodeActions.claimToken, action.claimToken)));
}

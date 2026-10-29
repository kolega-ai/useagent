// Deliver unattended code actions after the originating run has settled.
import { createHash } from "node:crypto";
import { backoffAt, claimDue, isDeadLetter, markDead, markForRetry, resetStuck, type OutboxTable } from "../db/outbox";
import { getGitHubPublicationReceiptForChangeSet } from "../github/publication-repo";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { prepareGitLabPublication } from "../gitlab/publication-prepare";
import { publishGitLabChangeSet } from "../gitlab/publication-publish";
import { createAutomationGithubPublicationExecutor } from "../knowledge/gateway/github-publication-tools";
import { NoRepositoryChangesError } from "../repositories/capture-patch";
import { getRunForOrg } from "../runs/repo";
import { resolveRunSandbox, resolveSandboxBindingForSandbox } from "../sandboxes/binding";
import { sandboxRuntimeLayout } from "../sandboxes/provider";
import { CodeActionAuthorityError, assertCodeActionAuthorized, getCodeAction, recordCodeActionOutcome, setActionChangeSet,
  type CodeActionRecord } from "./code-actions-repo";
import { prepareGithubAutomationChange } from "./code-publish-github";
import { parseCodeDecision } from "./code-result";
import { mergeReviewedTarget } from "./code-review-provider";
import { reviewedWorkspaceMatches } from "./code-review-workspace";

const TABLE: OutboxTable = { table: "automation_code_actions", key: "idempotency_key", stateColumn: "state",
  attemptColumn: "attempt_count", pending: "pending", claimed: "processing", dead: "dead", claimTokenColumn: "claim_token" };
const BACKOFF = { baseMs: 10_000, maxMs: 60_000 };
const DEADLINE_MS = 8 * 60_000;

async function publish(action: CodeActionRecord, title: string, signal: AbortSignal, authorize: () => Promise<void>): Promise<string | null> {
  if (!action.runId) throw new Error("Automation run is unavailable.");
  let changeSetId = action.changeSetId;
  const isGitLab = action.policy.repository.startsWith("gitlab.com/");
  if (!changeSetId) {
    const prepared = isGitLab
      ? (await prepareGitLabPublication({ orgId: action.orgId, userId: action.ownerUserId, runId: action.runId,
          repository: action.policy.repository, title, draft: action.policy.draft, signal })).changeSet
      : (await prepareGithubAutomationChange({ orgId: action.orgId, userId: action.ownerUserId, runId: action.runId,
          repository: action.policy.repository, signal })).row;
    await authorize();
    if (!(await setActionChangeSet(action, prepared.id))) throw new CodeActionAuthorityError();
    changeSetId = prepared.id;
  }
  if (isGitLab) {
    const receipt = await publishGitLabChangeSet({ orgId: action.orgId, userId: action.ownerUserId, changeSetId, signal }, { assertAuthorized: authorize });
    return receipt.state === "published" ? receipt.pullRequestUrl : null;
  }
  const run = await getRunForOrg(action.orgId, action.runId);
  if (!run) throw new CodeActionAuthorityError();
  const branch = `useagent/${createHash("sha256").update(action.idempotencyKey).digest("hex").slice(0, 32)}`;
  const execute = createAutomationGithubPublicationExecutor(authorize);
  const result = await execute({ orgId: action.orgId, userId: action.ownerUserId, threadId: run.threadId,
    runId: run.id, scope: "run", exp: Date.now() + DEADLINE_MS }, "github_pull_request_publish", {
    changeSetId, idempotencyKey: action.idempotencyKey, headBranch: branch, commitMessage: title,
    pullRequestTitle: title, pullRequestBody: "Automated change prepared by UseAgent.", draft: action.policy.draft,
  });
  const receipt = await getGitHubPublicationReceiptForChangeSet(action.orgId, changeSetId);
  if (receipt?.state === "published" && receipt.pullRequestUrl) return receipt.pullRequestUrl;
  if (result.isError) throw new Error("The GitHub publication needs another attempt.");
  return null;
}

export async function executeCodeAction(action: CodeActionRecord, signal: AbortSignal): Promise<void> {
  // Agent-managed runs perform their own effects in the sandbox, never here.
  if (action.policy.mode === "agent") {
    if (action.claimToken) await markDead(TABLE, action.idempotencyKey, "Agent-managed actions are not published by the backend.", undefined, action.claimToken);
    return;
  }
  const authorize = async () => { signal.throwIfAborted(); await assertCodeActionAuthorized(action); };
  await authorize();
  if (!action.runId) throw new CodeActionAuthorityError();
  const run = await getRunForOrg(action.orgId, action.runId);
  if (!run) throw new CodeActionAuthorityError();
  const decision = parseCodeDecision(run.summary, action.policy, action.target);
  if (!decision) {
    await markDead(TABLE, action.idempotencyKey, "The agent did not return a valid code-action decision.", undefined, action.claimToken!);
    return;
  }
  if (decision.decision === "skip") {
    await recordCodeActionOutcome(action, "skipped", "The agent chose not to act.");
    return;
  }
  if (decision.decision === "publish") {
    const url = await publish(action, decision.title, signal, authorize);
    if (!url) throw new Error("Publication is awaiting reconciliation.");
    await recordCodeActionOutcome(action, "done", "Published the automated change.", url);
    return;
  }
  if (!action.target || !run.sandboxId) throw new CodeActionAuthorityError();
  const sandbox = await resolveRunSandbox(run);
  const kind = run.sandboxProvider ?? sandbox.providerKind ?? (await resolveSandboxBindingForSandbox(run.sandboxId)).kind;
  const matches = await reviewedWorkspaceMatches({ sandbox, layout: sandboxRuntimeLayout(kind), target: action.target, signal });
  if (!matches) {
    await recordCodeActionOutcome(action, "skipped", "The review workspace did not match the selected revision.");
    return;
  }
  const result = await mergeReviewedTarget({ orgId: action.orgId, target: action.target, signal, assertAuthorized: authorize });
  if (result.status === "waiting") throw new Error("The provider has not marked the request ready to merge.");
  if (result.status === "stale") {
    await recordCodeActionOutcome(action, "skipped", result.reason ?? "The reviewed revision changed.");
    return;
  }
  await recordCodeActionOutcome(action, "done", "The reviewed revision is merged.", result.url);
}

export async function drainCodeActions(): Promise<number> {
  const claims = await claimDue(TABLE, 1);
  for (const claim of claims) {
    const key = String(claim.idempotency_key);
    const action = await getCodeAction(key);
    if (!action || action.state !== "processing" || !action.claimToken || action.claimToken !== claim.claim_token) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    try { await executeCodeAction(action, controller.signal); }
    catch (error) {
      if (error instanceof NoRepositoryChangesError || error instanceof CodeActionAuthorityError) {
        await recordCodeActionOutcome(action, "skipped", error.message);
      } else if (isDeadLetter(action.attemptCount, action.maxAttempts)) {
        await markDead(TABLE, key, "The code action could not be completed. Check the connection and request status.", undefined, action.claimToken);
      } else {
        await markForRetry(TABLE, key, backoffAt(BACKOFF, Date.now(), action.attemptCount),
          "The code action is waiting for the provider or a safe retry.", action.claimToken);
      }
    } finally { clearTimeout(timer); }
  }
  return claims.length;
}

export async function resetStuckCodeActions(): Promise<number> {
  // A crash can occur after command acceptance but before the firing attaches
  // its run. Recover from the command lane's durable idempotency key.
  await db.execute(sql`update automation_code_actions a
    set run_id = c.run_id,
        state = case when r.status = 'completed' and a.policy->>'mode' = 'agent' then 'done'
                     when r.status = 'completed' then 'pending' when r.status = 'failed' then 'dead' else 'waiting' end,
        result_reason = case when r.status = 'completed' and a.policy->>'mode' = 'agent' then 'The agent completed the run.'
                             when r.status = 'failed' then 'The automation run did not complete.' else null end,
        updated_at = now()
    from commands c join runs r on r.id = c.run_id
    where a.state = 'selected' and a.run_id is null and c.org_id = a.org_id
      and c.idempotency_key = a.idempotency_key and c.kind = 'run.create'
      and r.origin = 'product:automation' and r.user_id = a.owner_user_id`);
  return resetStuck(TABLE);
}

export function startCodeActions(intervalMs = 2000): () => void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void drainCodeActions().catch(() => { console.error("[automation-code] delivery tick failed"); }).finally(() => { busy = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}

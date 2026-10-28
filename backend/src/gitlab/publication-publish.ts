// Publish a frozen change set with the backend-held GitLab credential.
// The persisted commit intent fences retries before any external ref is made.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { artifactStorage } from "../artifacts/storage";
import {
  claimGitHubPublicationReceipt, claimGitHubPublicationReconciliation,
  getGitHubChangeSetForOrg, getGitHubPublicationReceiptForChangeSet,
  recordGitHubPublicationAbsentAfterReconcile, recordGitHubPublicationAmbiguous,
  recordGitHubPublicationIntent, recordGitHubPublicationPreRefAbort, recordGitHubPublicationSuccess,
  renewGitHubPublicationClaim, type ClaimedGitHubPublicationReceipt,
  type GitHubChangeSetRecord, type GitHubPublicationReceiptRecord,
} from "../github/publication-repo";
import { stableJson } from "../github/publication-repo-input";
import { GITLAB_REPOSITORY_PREFIX, normalizeGitLabRepository } from "../resources/gitlab-resolver";
import { getRunForOrg } from "../runs/repo";
import { authorizeGitLabCheckout, authorizeGitLabProject, withGitLabCheckout } from "./checkout";
import { GitLabApiError, gitLabRequest } from "./client";
import { applyPatchAndDescribe } from "./publication-manifest";

const LEASE_MS = 240_000; // Longer than the 180-second Git operation deadline.
type Branch = { name?: unknown; commit?: { id?: unknown } };
type MergeRequest = { iid?: unknown; web_url?: unknown; source_branch?: unknown; target_branch?: unknown;
  source_project_id?: unknown; target_project_id?: unknown; description?: unknown; sha?: unknown };

function mrResult(mr: MergeRequest, repository: string, projectId: number, receipt: GitHubPublicationReceiptRecord) {
  const iid = mr.iid;
  if (!Number.isSafeInteger(iid) || Number(iid) < 1 || mr.source_branch !== receipt.headBranch ||
      mr.target_branch !== receipt.targetBranch || mr.source_project_id !== projectId || mr.target_project_id !== projectId ||
      mr.web_url !== `https://gitlab.com/${repository}/-/merge_requests/${iid}` ||
      (typeof mr.sha === "string" && mr.sha !== receipt.commitSha) ||
      typeof mr.description !== "string" || !mr.description.includes(`<!-- useagent-publication:${receipt.id} -->`)) {
    throw new Error("GitLab returned an unexpected merge request identity.");
  }
  return { number: Number(iid), url: mr.web_url as string };
}

async function branch(token: string, repository: string, name: string, signal: AbortSignal): Promise<Branch | null> {
  try {
    return await gitLabRequest<Branch>(token, `/projects/${encodeURIComponent(repository)}/repository/branches/${encodeURIComponent(name)}`, { signal });
  } catch (error) { if (error instanceof GitLabApiError && error.status === 404) return null; throw error; }
}

async function renew(orgId: string, claim: ClaimedGitHubPublicationReceipt): Promise<void> {
  if (!(await renewGitHubPublicationClaim({ orgId, receiptId: claim.receipt.id, claimToken: claim.claimToken, leaseMs: LEASE_MS }))) {
    throw new Error("The publication lease expired. Retry after checking its status.");
  }
}

async function currentToken(orgId: string, repository: string, previous?: string): Promise<string> {
  const token = await authorizeGitLabCheckout(orgId, repository);
  if (previous && token !== previous) throw new Error("The GitLab connection changed. Retry with the current connection.");
  return token;
}

async function findMergeRequest(token: string, repository: string, projectId: number, receipt: GitHubPublicationReceiptRecord, signal: AbortSignal) {
  const query = new URLSearchParams({ state: "all", source_branch: receipt.headBranch, target_branch: receipt.targetBranch, per_page: "100" });
  const items = await gitLabRequest<MergeRequest[]>(token, `/projects/${encodeURIComponent(repository)}/merge_requests?${query}`, { signal });
  if (!Array.isArray(items)) throw new Error("GitLab returned an invalid merge-request list.");
  const matches = items.filter((item) => typeof item.description === "string" && item.description.includes(`<!-- useagent-publication:${receipt.id} -->`));
  if (matches.length > 1) throw new Error("Multiple matching merge requests require manual review.");
  return matches[0] ? mrResult(matches[0], repository, projectId, receipt) : null;
}

async function createMergeRequest(token: string, repository: string, projectId: number, receipt: GitHubPublicationReceiptRecord, signal: AbortSignal) {
  const mr = await gitLabRequest<MergeRequest>(token, `/projects/${encodeURIComponent(repository)}/merge_requests`, {
    method: "POST", signal, body: { source_branch: receipt.headBranch, target_branch: receipt.targetBranch,
      title: receipt.draft ? `Draft: ${receipt.pullRequestTitle}` : receipt.pullRequestTitle,
      description: `${receipt.pullRequestBody}\n\n<!-- useagent-publication:${receipt.id} -->` },
  });
  return mrResult(mr, repository, projectId, receipt);
}

async function markSuccess(orgId: string, claim: ClaimedGitHubPublicationReceipt, commitSha: string, result: { number: number; url: string }) {
  const receipt = await recordGitHubPublicationSuccess({ orgId, receiptId: claim.receipt.id, claimToken: claim.claimToken,
    commitSha, pullRequestNumber: result.number, pullRequestUrl: result.url, provider: "gitlab" });
  if (!receipt) throw new Error("Publication finished but its receipt could not be confirmed. Check its status before retrying.");
  return receipt;
}

async function reconcile(orgId: string, set: GitHubChangeSetRecord, claim: ClaimedGitHubPublicationReceipt, signal: AbortSignal) {
  const repository = set.repoFullName.slice(GITLAB_REPOSITORY_PREFIX.length);
  const sha = claim.receipt.commitSha;
  if (!sha) return recordGitHubPublicationPreRefAbort({ orgId, receiptId: claim.receipt.id, claimToken: claim.claimToken });
  await renew(orgId, claim);
  const { token, project } = await authorizeGitLabProject(orgId, repository);
  const remote = await branch(token, repository, claim.receipt.headBranch, signal);
  if (!remote) return recordGitHubPublicationAbsentAfterReconcile({ orgId, receiptId: claim.receipt.id, claimToken: claim.claimToken });
  if (remote.name !== claim.receipt.headBranch || remote.commit?.id !== sha) throw new Error("The publication branch has a different commit. Review it in GitLab.");
  const existing = await findMergeRequest(token, repository, project.id, claim.receipt, signal);
  if (existing) return markSuccess(orgId, claim, sha, existing);
  await renew(orgId, claim);
  await currentToken(orgId, repository, token);
  const result = await createMergeRequest(token, repository, project.id, claim.receipt, signal);
  return markSuccess(orgId, claim, sha, result);
}

export async function publishGitLabChangeSet(input: {
  readonly orgId: string; readonly userId: string; readonly changeSetId: string; readonly signal: AbortSignal;
}, dependencies: { readonly checkout?: typeof withGitLabCheckout } = {}): Promise<GitHubPublicationReceiptRecord> {
  const set = await getGitHubChangeSetForOrg(input.orgId, input.changeSetId);
  if (!set || set.provider !== "gitlab" || set.userId !== input.userId ||
      !set.repoFullName.startsWith(GITLAB_REPOSITORY_PREFIX) || !normalizeGitLabRepository(set.repoFullName)) {
    throw new Error("Publication is unavailable.");
  }
  const run = await getRunForOrg(input.orgId, set.runId);
  if (!run || run.userId !== input.userId || !run.resolvedResources.some((resource) => resource.provider === "gitlab" &&
      resource.locator.type === "gitlab.repository" && `${GITLAB_REPOSITORY_PREFIX}${resource.locator.repository}` === set.repoFullName &&
      resource.capabilities.includes("code.checkout"))) throw new Error("The thread's repository binding is unavailable.");
  const existing = await getGitHubPublicationReceiptForChangeSet(input.orgId, set.id);
  if (!existing) throw new Error("Publication receipt is unavailable.");
  if (existing.state === "published") return existing;
  if ((existing.state === "pending" || existing.state === "failed") && set.expiresAt.getTime() <= Date.now()) {
    throw new Error("The prepared changes expired. Prepare them again before publishing.");
  }
  let claim = await claimGitHubPublicationReceipt(input.orgId, existing.id, LEASE_MS);
  if (!claim) claim = await claimGitHubPublicationReconciliation(input.orgId, existing.id, LEASE_MS);
  if (!claim) return (await getGitHubPublicationReceiptForChangeSet(input.orgId, set.id)) ?? existing;
  let externalEffectStarted = claim.mode === "reconcile";
  try {
    if (claim.mode === "reconcile") {
      const result = await reconcile(input.orgId, set, claim, input.signal);
      if (!result) throw new Error("Publication status could not be confirmed.");
      return result;
    }
    const repository = set.repoFullName.slice(GITLAB_REPOSITORY_PREFIX.length);
    const { token, project } = await authorizeGitLabProject(input.orgId, repository);
    if (await artifactStorage().size(set.payloadStorageKey) !== set.payloadSizeBytes) throw new Error("The frozen changes failed their integrity check.");
    const patch = await artifactStorage().read(set.payloadStorageKey);
    if (patch.length !== set.payloadSizeBytes || createHash("sha256").update(patch).digest("hex") !== set.payloadSha256) {
      throw new Error("The frozen changes failed their integrity check.");
    }
    await renew(input.orgId, claim);
    return await (dependencies.checkout ?? withGitLabCheckout)({ repository, branch: set.baseRef, token, signal: input.signal }, async ({ directory, git }) => {
      const manifest = await applyPatchAndDescribe({ directory, git, baseSha: set.baseSha, patch });
      if (stableJson(manifest) !== stableJson(set.manifest)) throw new Error("The frozen changes no longer match their review.");
      const messageFile = join(directory, "..", "publication-message.txt");
      await writeFile(messageFile, `${claim!.receipt.commitMessage}\n`, { mode: 0o600 });
      const date = claim!.receipt.createdAt.toISOString();
      await git(["-C", directory, "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-F", messageFile], {
        env: { GIT_AUTHOR_NAME: "UseAgent", GIT_AUTHOR_EMAIL: "useagent@localhost", GIT_COMMITTER_NAME: "UseAgent",
          GIT_COMMITTER_EMAIL: "useagent@localhost", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
      const sha = (await git(["-C", directory, "rev-parse", "HEAD"], { captureMaxBytes: 128 })).toString("utf8").trim();
      if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Could not verify the prepared commit.");
      await renew(input.orgId, claim!);
      if (!(await recordGitHubPublicationIntent({ orgId: input.orgId, receiptId: claim!.receipt.id, claimToken: claim!.claimToken, commitSha: sha }))) {
        throw new Error("Could not record publication intent.");
      }
      const intended = { ...claim!.receipt, commitSha: sha };
      const target = await branch(token, repository, set.baseRef, input.signal);
      const head = await branch(token, repository, intended.headBranch, input.signal);
      if (!target || target.name !== set.baseRef || target.commit?.id !== set.baseSha || head) throw new Error("The target changed or the publication branch already exists. Prepare the changes again.");
      await currentToken(input.orgId, repository, token);
      await renew(input.orgId, claim!);
      externalEffectStarted = true;
      await git(["-C", directory, "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "http.followRedirects=false",
        "push", `--force-with-lease=refs/heads/${intended.headBranch}:`, "origin", `HEAD:refs/heads/${intended.headBranch}`]);
      await renew(input.orgId, claim!);
      await currentToken(input.orgId, repository, token);
      const result = await createMergeRequest(token, repository, project.id, intended, input.signal);
      return await markSuccess(input.orgId, claim!, sha, result);
    });
  } catch (error) {
    if (externalEffectStarted) {
      await recordGitHubPublicationAmbiguous({ orgId: input.orgId, receiptId: claim.receipt.id, claimToken: claim.claimToken,
        error: "GitLab publication needs reconciliation. Retry to check the branch and merge request." }).catch(() => null);
    } else {
      await recordGitHubPublicationPreRefAbort({ orgId: input.orgId, receiptId: claim.receipt.id, claimToken: claim.claimToken,
        error: "Publication did not reach GitLab. Review the connection and retry." }).catch(() => null);
    }
    throw error;
  }
}

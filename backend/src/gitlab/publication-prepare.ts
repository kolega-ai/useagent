// Prepare a frozen, reviewable GitLab change set in the trusted control plane.
import { createHash, randomUUID } from "node:crypto";
import { artifactStorage } from "../artifacts/storage";
import { withArtifactStorageKeyLock } from "../artifacts/storage-key-lock";
import { freezeGitHubChangeSet, ensureGitHubPublicationReceipt } from "../github/publication-repo";
import { boundedText } from "../github/publication-repo-input";
import { isSafeGitRevision } from "../resources/github-resolver";
import { GITLAB_REPOSITORY_PREFIX, normalizeGitLabRepository } from "../resources/gitlab-resolver";
import { getRunForOrg, threadHasActiveRuns } from "../runs/repo";
import { resolveRunSandbox, resolveSandboxBindingForSandbox } from "../sandboxes/binding";
import { sandboxRuntimeLayout } from "../sandboxes/provider";
import { authorizeGitLabProject, withGitLabCheckout } from "./checkout";
import { gitLabRequest } from "./client";
import { captureRepositoryPatch } from "../repositories/capture-patch";
import { applyPatchAndDescribe } from "../repositories/patch-manifest";

export async function prepareGitLabPublication(input: {
  readonly orgId: string; readonly userId: string; readonly runId: string;
  readonly repository: string; readonly title: string; readonly draft: boolean; readonly signal: AbortSignal;
}, dependencies: {
  readonly resolveSandbox?: typeof resolveRunSandbox;
  readonly capturePatch?: typeof captureRepositoryPatch;
  readonly checkout?: typeof withGitLabCheckout;
} = {}) {
  const run = await getRunForOrg(input.orgId, input.runId);
  if (!run || run.userId !== input.userId) throw new Error("Thread is unavailable for publication.");
  if (!run.sandboxId) throw new Error("This thread has no retained workspace to publish.");
  if (await threadHasActiveRuns(input.orgId, run.threadId)) throw new Error("Wait for the thread to finish before preparing a merge request.");
  const repository = normalizeGitLabRepository(input.repository);
  if (!repository || input.repository !== `${GITLAB_REPOSITORY_PREFIX}${repository}`) throw new Error("Invalid GitLab project.");
  const resource = run.resolvedResources.find((entry) => entry.provider === "gitlab" && entry.locator.type === "gitlab.repository" &&
    entry.locator.repository === repository && entry.capabilities.includes("code.checkout"));
  if (!resource || resource.locator.type !== "gitlab.repository") throw new Error("This project is not bound to the thread.");
  const title = boundedText(input.title, "Merge request title", 220);
  const { token, project } = await authorizeGitLabProject(input.orgId, repository);
  const targetBranch = resource.locator.revision ?? project.default_branch;
  if (!targetBranch || !isSafeGitRevision(targetBranch)) throw new Error("The GitLab target branch is unavailable.");
  const projectPath = `/projects/${encodeURIComponent(repository)}`;
  const branch = await gitLabRequest<{ name?: unknown; commit?: { id?: unknown } }>(token,
    `${projectPath}/repository/branches/${encodeURIComponent(targetBranch)}`, { signal: input.signal });
  const baseSha = branch.commit?.id;
  if (branch.name !== targetBranch || typeof baseSha !== "string" || !/^[a-f0-9]{40}$/u.test(baseSha)) {
    throw new Error("GitLab returned an invalid target branch.");
  }
  const sandbox = await (dependencies.resolveSandbox ?? resolveRunSandbox)(run);
  const kind = run.sandboxProvider ?? sandbox.providerKind ?? (await resolveSandboxBindingForSandbox(run.sandboxId)).kind;
  const layout = sandboxRuntimeLayout(kind);
  const patch = await (dependencies.capturePatch ?? captureRepositoryPatch)({ sandbox, repositoryPath: `${layout.workdir}/${GITLAB_REPOSITORY_PREFIX}${repository}`,
    baseSha, layout, signal: input.signal });
  const manifest = await (dependencies.checkout ?? withGitLabCheckout)({ repository, branch: targetBranch, token, signal: input.signal },
    ({ directory, git }) => applyPatchAndDescribe({ directory, git, baseSha, patch }));
  if (await threadHasActiveRuns(input.orgId, run.threadId)) throw new Error("The thread started another turn. Prepare the changes again after it finishes.");
  const digest = createHash("sha256").update(patch).digest("hex");
  const frozen = await withArtifactStorageKeyLock(digest, async (tx) => {
    await artifactStorage().put(digest, patch);
    return freezeGitHubChangeSet({ orgId: input.orgId, userId: input.userId, runId: run.id, provider: "gitlab",
      repoFullName: `${GITLAB_REPOSITORY_PREFIX}${repository}`, baseRef: targetBranch, baseSha, manifest,
      payloadStorageKey: digest, payloadSha256: digest, payloadSizeBytes: patch.length,
      expiresAt: new Date(Date.now() + 60 * 60_000) }, tx);
  });
  const receipt = await ensureGitHubPublicationReceipt({ orgId: input.orgId, changeSetId: frozen.row.id,
    idempotencyKey: randomUUID(), targetBranch, headBranch: `useagent/${randomUUID()}`, draft: input.draft,
    commitMessage: title, pullRequestTitle: title, pullRequestBody: "Prepared by UseAgent." });
  return { changeSet: frozen.row, receipt: receipt.row };
}

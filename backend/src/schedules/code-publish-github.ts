// Freeze a sandbox tree through the existing GitHub publication owner.
import { createHash } from "node:crypto";
import { artifactStorage } from "../artifacts/storage";
import { withArtifactStorageKeyLock } from "../artifacts/storage-key-lock";
import { freezeGitHubChangeSet } from "../github/publication-repo";
import { resolveGithubPublicationToken } from "../github/auth";
import { captureRepositoryPatch } from "../repositories/capture-patch";
import { applyPatchAndDescribe } from "../repositories/patch-manifest";
import { withTrustedCheckout } from "../repositories/trusted-checkout";
import { hasGitHubRepositoryCheckoutIntent } from "../resources/public-github";
import { isSafeGitRevision } from "../resources/github-resolver";
import { getRunForOrg, threadHasActiveRuns } from "../runs/repo";
import { resolveRunSandbox, resolveSandboxBindingForSandbox } from "../sandboxes/binding";
import { sandboxRuntimeLayout } from "../sandboxes/provider";
import { githubPath, githubRequest } from "./code-review-provider";

export async function prepareGithubAutomationChange(input: {
  orgId: string; userId: string; runId: string; repository: string; signal: AbortSignal;
}) {
  const run = await getRunForOrg(input.orgId, input.runId);
  if (!run || run.userId !== input.userId || !run.sandboxId) throw new Error("The automation workspace is unavailable.");
  if (await threadHasActiveRuns(input.orgId, run.threadId)) throw new Error("The automation workspace is busy.");
  const resource = run.resolvedResources.find((entry) => entry.provider === "github" && entry.locator.type === "github.repository" &&
    entry.locator.repository.toLowerCase() === input.repository.toLowerCase() && entry.capabilities.includes("code.checkout") &&
    hasGitHubRepositoryCheckoutIntent(entry));
  if (!resource || resource.locator.type !== "github.repository") throw new Error("The repository is not bound to this run.");
  const token = await resolveGithubPublicationToken(input.repository, input.orgId);
  const project = await githubRequest<{ full_name?: unknown; default_branch?: unknown }>(token, githubPath(input.repository), { signal: input.signal });
  if (typeof project.full_name !== "string" || project.full_name.toLowerCase() !== input.repository.toLowerCase()) throw new Error("GitHub returned a different repository.");
  const branch = resource.locator.revision ?? project.default_branch;
  if (typeof branch !== "string" || !isSafeGitRevision(branch)) throw new Error("The GitHub target branch is unavailable.");
  const ref = await githubRequest<{ object?: { sha?: unknown } }>(token, `${githubPath(input.repository)}/git/ref/heads/${encodeURIComponent(branch)}`, { signal: input.signal });
  const baseSha = ref.object?.sha;
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/u.test(baseSha)) throw new Error("GitHub returned an invalid target branch.");
  const sandbox = await resolveRunSandbox(run);
  const kind = run.sandboxProvider ?? sandbox.providerKind ?? (await resolveSandboxBindingForSandbox(run.sandboxId)).kind;
  const layout = sandboxRuntimeLayout(kind);
  const patch = await captureRepositoryPatch({ sandbox, layout, repositoryPath: `${layout.workdir}/${input.repository}`, baseSha, signal: input.signal });
  const frozen = await withTrustedCheckout({ remote: `https://github.com/${input.repository}.git`, branch, token,
    username: "x-access-token", signal: input.signal,
    failureMessage: "GitHub repository operation failed. Check access and the target branch." }, async ({ directory, git }) => {
    const manifest = await applyPatchAndDescribe({ directory, git, baseSha, patch });
    const files: { path: string; mode: string; contentBase64: string }[] = [];
    for (const file of manifest.files) {
      if (file.action === "delete") continue;
      const bytes = await git(["--literal-pathspecs", "-C", directory, "show", `:${file.path}`], { captureMaxBytes: 5 * 1024 * 1024 + 1 });
      if (bytes.length !== file.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256 || !file.mode) {
        throw new Error("The captured file failed its integrity check.");
      }
      files.push({ path: file.path, mode: file.mode, contentBase64: bytes.toString("base64") });
    }
    const stored = Buffer.from(JSON.stringify({ version: 1, files }));
    if (stored.length > 25 * 1024 * 1024) throw new Error("The publication exceeds the payload limit.");
    return { manifest, stored };
  });
  const digest = createHash("sha256").update(frozen.stored).digest("hex");
  if (await threadHasActiveRuns(input.orgId, run.threadId)) throw new Error("The automation workspace is busy.");
  return withArtifactStorageKeyLock(digest, async (tx) => {
    await artifactStorage().put(digest, frozen.stored);
    return freezeGitHubChangeSet({ orgId: input.orgId, userId: input.userId, runId: input.runId,
      repoFullName: input.repository, baseRef: branch, baseSha, manifest: frozen.manifest,
      payloadStorageKey: digest, payloadSha256: digest, payloadSizeBytes: frozen.stored.length,
      expiresAt: new Date(Date.now() + 60 * 60_000) }, tx);
  });
}

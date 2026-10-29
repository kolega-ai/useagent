// Copy an authorized GitLab checkout into the sandbox as a private archive.
// The control plane's checkout keeps a clean remote URL. Connected personal
// tokens are also made available separately for the agent's Git and CLI use.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";
import { isSafeGitRevision } from "../resources/github-resolver";
import { normalizeGitLabRepository } from "../resources/gitlab-resolver";
import { gitLabProject } from "./client";
import { gitLabToken } from "./connection";
import { withTrustedCheckout, type TrustedGit } from "../repositories/trusted-checkout";
import type { AutomationReviewTarget } from "../db/schema/schedules";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const GIT_TIMEOUT_MS = 180_000;

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Archive a checkout without copying host-specific extended attributes. */
export async function archiveGitLabCheckout(directory: string, signal: AbortSignal): Promise<Buffer> {
  const archive = join(directory, "project.tar.gz");
  const child = Bun.spawn(["tar", "-czf", archive, "-C", "checkout", "."], {
    cwd: directory, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    // On macOS bsdtar otherwise turns extended attributes into untracked ._* files.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
  });
  const abort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, GIT_TIMEOUT_MS);
  try {
    const status = await child.exited;
    signal.throwIfAborted();
    if (status !== 0) throw new Error("Could not prepare the GitLab checkout archive");
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  if ((await stat(archive)).size > MAX_ARCHIVE_BYTES) throw new Error("GitLab checkout exceeds the 128 MiB transfer limit");
  return await readFile(archive);
}

/** Exported for an opt-in live test; callers must have authorized the project. */
export async function withGitLabCheckout<T>(input: {
  repository: string; branch: string | null; token: string; signal: AbortSignal;
}, action: (checkout: {
  readonly directory: string;
  readonly git: TrustedGit;
}) => Promise<T>): Promise<T> {
  if (normalizeGitLabRepository(input.repository) !== input.repository || !isSafeGitRevision(input.branch)) {
    throw new Error("Invalid GitLab project or branch");
  }
  return withTrustedCheckout({ remote: `https://gitlab.com/${input.repository}.git`, branch: input.branch,
    token: input.token, username: "oauth2", signal: input.signal,
    failureMessage: "GitLab repository operation failed. Check the connection, repository access and branch." }, action);
}

export async function createGitLabArchive(input: {
  repository: string; branch: string | null; token: string; signal: AbortSignal; review?: AutomationReviewTarget | null;
}): Promise<Buffer> {
  // Preserve .git/shallow with the checkout: a shallow bundle alone does not
  // contain the boundary commit's parents. The origin contains no credential.
  return withGitLabCheckout(input, async ({ directory, git }) => {
    if (input.review) await prepareGitLabReviewHistory({ directory, git, review: input.review, repository: input.repository, branch: input.branch });
    return archiveGitLabCheckout(join(directory, ".."), input.signal);
  });
}

/** Supply both sides of a review using the control plane's checkout. */
export async function prepareGitLabReviewHistory(input: {
  directory: string; git: TrustedGit; review: AutomationReviewTarget; repository: string; branch: string | null;
}): Promise<void> {
  const { review, git, directory } = input;
  if (review.provider !== "gitlab" || review.repository !== `gitlab.com/${input.repository}` ||
      review.sourceBranch !== input.branch || !isSafeGitRevision(review.targetBranch) || !/^[a-f0-9]{40}$/u.test(review.headSha)) {
    throw new Error("The GitLab review checkout does not match its selected request.");
  }
  const head = (await git(["-C", directory, "rev-parse", "HEAD"], { captureMaxBytes: 128 })).toString().trim();
  if (head !== review.headSha) throw new Error("The GitLab request changed before the review started.");
  try {
    await git(["-C", directory, "fetch", "--deepen=1000", "--no-tags", "origin"]);
    await git(["-C", directory, "fetch", "--depth=1000", "--no-tags", "origin",
      `refs/heads/${review.targetBranch}:refs/remotes/origin/${review.targetBranch}`]);
    await git(["-C", directory, "merge-base", "HEAD", `refs/remotes/origin/${review.targetBranch}`]);
  } catch {
    throw new Error("Could not prepare the GitLab review history or find a common ancestor within 1000 commits.");
  }
}

/** Recheck organization access and return the validated project from one request. */
export async function authorizeGitLabProject(orgId: string, repository: string) {
  const token = await gitLabToken(orgId);
  if (!token) throw new Error("GitLab is not connected for this organization");
  const project = await gitLabProject(token, repository);
  return { token, project };
}

/** Check current organization access before exposing a checkout to an agent. */
export async function authorizeGitLabCheckout(orgId: string, repository: string): Promise<string> {
  return (await authorizeGitLabProject(orgId, repository)).token;
}

export async function stageGitLabArchive(input: {
  sandbox: SandboxHandle; orgId: string; repository: string; branch: string | null;
  runtimeLayout: SandboxRuntimeLayout; signal: AbortSignal; review?: AutomationReviewTarget | null;
}): Promise<{ source: string; cleanup(): Promise<void> }> {
  const token = await authorizeGitLabCheckout(input.orgId, input.repository);
  const bytes = await createGitLabArchive({ ...input, token });
  input.signal.throwIfAborted();
  const directory = `${input.runtimeLayout.home}/${SANDBOX_STATE_DIR}/gitlab-checkouts`;
  const source = `${directory}/${crypto.randomUUID()}.tar.gz`;
  const cleanup = async () => { await input.sandbox.process.executeCommand(`rm -f -- ${quote(source)}`, undefined, undefined, 30); };
  const ready = await input.sandbox.process.executeCommand(
    `set -eu; install -d -m 700 ${quote(directory)}; test ! -L ${quote(directory)}; test ! -e ${quote(source)}`,
    undefined, undefined, 30,
  );
  if (ready.exitCode !== 0) throw new Error("Could not prepare the GitLab checkout staging directory");
  try {
    await input.sandbox.fs.uploadFile(bytes, source, 120);
    input.signal.throwIfAborted();
    return { source, cleanup };
  } catch (error) { await cleanup().catch(() => {}); throw error; }
}

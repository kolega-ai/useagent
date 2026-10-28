// Copy an authorized GitLab checkout into the sandbox as a private archive. The
// long-lived GitLab token is used only by the trusted control plane's Git
// process; the sandbox receives repository data and a clean remote URL.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";
import { isSafeGitRevision } from "../resources/github-resolver";
import { normalizeGitLabRepository } from "../resources/gitlab-resolver";
import { gitLabProject } from "./client";
import { gitLabToken } from "./connection";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const GIT_TIMEOUT_MS = 180_000;

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function runGit(args: string[], options: { directory: string; token: string; signal: AbortSignal }): Promise<void> {
  options.signal.throwIfAborted();
  const child = Bun.spawn(["git", ...args], {
    cwd: options.directory, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: options.directory,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: join(options.directory, "askpass"), USEAGENT_GITLAB_TOKEN: options.token,
      GIT_LFS_SKIP_SMUDGE: "1",
    },
  });
  const abort = () => child.kill("SIGKILL");
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const timeout = setTimeout(abort, GIT_TIMEOUT_MS);
  try {
    const status = await child.exited;
    options.signal.throwIfAborted();
    if (status !== 0) throw new Error("Could not fetch the GitLab repository. Check the connection, repository access and branch.");
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}

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
export async function createGitLabArchive(input: {
  repository: string; branch: string | null; token: string; signal: AbortSignal;
}): Promise<Buffer> {
  if (normalizeGitLabRepository(input.repository) !== input.repository || !isSafeGitRevision(input.branch)) {
    throw new Error("Invalid GitLab project or branch");
  }
  const directory = await mkdtemp(join(tmpdir(), "useagent-gitlab-checkout-"));
  try {
    await writeFile(join(directory, "askpass"),
      "#!/bin/sh\ncase \"$1\" in Username*) printf '%s\\n' oauth2 ;; *) printf '%s\\n' \"$USEAGENT_GITLAB_TOKEN\" ;; esac\n",
      { mode: 0o700 });
    const git = (args: string[]) => runGit(args, { directory, token: input.token, signal: input.signal });
    await git(["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "http.followRedirects=false",
      "clone", "--depth=1", "--single-branch", "--no-tags", ...(input.branch ? ["--branch", input.branch] : []),
      "--", `https://gitlab.com/${input.repository}.git`, "checkout"]);
    // A bundle of a shallow clone lacks the parents of its boundary commit,
    // so an empty receiver cannot clone it. Preserve .git/shallow together
    // with the actual checkout; its origin contains no credential.
    return await archiveGitLabCheckout(directory, input.signal);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Check current organization access before exposing a checkout to an agent. */
export async function authorizeGitLabCheckout(orgId: string, repository: string): Promise<string> {
  const token = await gitLabToken(orgId);
  if (!token) throw new Error("GitLab is not connected for this organization");
  await gitLabProject(token, repository);
  return token;
}

export async function stageGitLabArchive(input: {
  sandbox: SandboxHandle; orgId: string; repository: string; branch: string | null;
  runtimeLayout: SandboxRuntimeLayout; signal: AbortSignal;
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

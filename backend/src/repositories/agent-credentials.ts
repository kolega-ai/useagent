// Deliver connected source-control credentials to the agent's isolated sandbox.
import { createHash, randomUUID } from "node:crypto";
import { resolveGithubAgentToken } from "../github/auth";
import { gitLabToken } from "../gitlab/connection";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";

export const AGENT_SOURCE_CONTROL_ROOT = "/tmp/useagent-source-control";
export const AGENT_SOURCE_CONTROL_ENV = `${AGENT_SOURCE_CONTROL_ROOT}/environment`;
export const AGENT_SOURCE_CONTROL_BIN = `${AGENT_SOURCE_CONTROL_ROOT}/bin`;

export interface AgentSourceControlCredentials {
  readonly github: string | null;
  readonly gitlab: string | null;
}

export async function agentSourceControlCredentials(orgId: string | null | undefined): Promise<AgentSourceControlCredentials> {
  if (!orgId) return { github: null, gitlab: null };
  const [github, gitlab] = await Promise.all([resolveGithubAgentToken(orgId), gitLabToken(orgId)]);
  return { github, gitlab };
}

export function sourceControlCredentialValues(credentials: AgentSourceControlCredentials): string[] {
  return [credentials.github, credentials.gitlab].filter((value): value is string => Boolean(value));
}

export function sourceControlCredentialRevision(credentials: AgentSourceControlCredentials): string {
  return createHash("sha256").update(credentials.github ?? "").update("\0").update(credentials.gitlab ?? "").digest("hex");
}

function revisionPath(layout: SandboxRuntimeLayout, threadId: string): string {
  return `${layout.home}/.useagent/source-control-revisions/${createHash("sha256").update(threadId).digest("hex")}`;
}

export async function readSourceControlRevision(sandbox: SandboxHandle, layout: SandboxRuntimeLayout, threadId: string): Promise<string | null> {
  const result = await sandbox.process.executeCommand(`cat ${q(revisionPath(layout, threadId))} 2>/dev/null || true`, undefined, undefined, 10);
  if ((result.exitCode ?? 1) !== 0) throw new Error("Could not read sandbox source-control revision");
  const value = result.result?.trim() ?? "";
  return /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

export async function stampSourceControlRevision(sandbox: SandboxHandle, layout: SandboxRuntimeLayout, threadId: string, revision: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(revision)) throw new Error("Invalid source-control revision");
  const path = revisionPath(layout, threadId);
  const directory = path.slice(0, path.lastIndexOf("/"));
  const result = await sandbox.process.executeCommand(`set -eu; install -d -m 700 ${q(directory)}; ` +
    `test ! -L ${q(path)}; printf '%s' ${q(revision)} > ${q(path)}; chmod 600 ${q(path)}`, undefined, undefined, 10);
  if ((result.exitCode ?? 1) !== 0) throw new Error("Could not record sandbox source-control revision");
}

function q(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** The env is uploaded as file bytes; no credential is placed in a command. */
export function sourceControlEnvironment(credentials: AgentSourceControlCredentials, root = AGENT_SOURCE_CONTROL_ROOT): string {
  return [
    "unset GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN",
    ...(credentials.github ? [`export GH_TOKEN=${q(credentials.github)}`] : []),
    ...(credentials.gitlab ? [`export GITLAB_TOKEN=${q(credentials.gitlab)}`, "export GITLAB_HOST=gitlab.com"] : []),
    "export GIT_TERMINAL_PROMPT=0",
    "export GIT_CONFIG_COUNT=3",
    "export GIT_CONFIG_KEY_0=credential.helper",
    "export GIT_CONFIG_VALUE_0=''",
    "export GIT_CONFIG_KEY_1=credential.https://github.com.helper",
    `export GIT_CONFIG_VALUE_1=${q(`${root}/credential`)}`,
    "export GIT_CONFIG_KEY_2=credential.https://gitlab.com.helper",
    `export GIT_CONFIG_VALUE_2=${q(`${root}/credential`)}`,
    `export PATH=${q(`${root}/bin`)}:"$PATH"`,
    "",
  ].join("\n");
}

/** Git asks this helper only for a matching HTTPS provider host. */
export function sourceControlCredentialHelper(root = AGENT_SOURCE_CONTROL_ROOT): string {
  return [
    "#!/bin/sh", "set -eu", '[ "${1:-}" = get ] || exit 0',
    "protocol=", "host=",
    'while IFS= read -r line && [ -n "$line" ]; do',
    '  case "$line" in protocol=*) protocol=${line#protocol=} ;; host=*) host=${line#host=} ;; esac',
    "done",
    '[ "$protocol" = https ] || exit 0',
    `. ${q(`${root}/environment`)}`,
    'case "$host" in',
    '  github.com) [ -n "${GH_TOKEN:-}" ] && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN" ;;',
    '  gitlab.com) [ -n "${GITLAB_TOKEN:-}" ] && printf "username=oauth2\\npassword=%s\\n" "$GITLAB_TOKEN" ;;',
    "esac", "exit 0", "",
  ].join("\n");
}

/** Each invocation reads the current token, including after a rotation. */
export function sourceControlCommandWrapper(tool: "git" | "gh" | "glab", layout: SandboxRuntimeLayout, root = AGENT_SOURCE_CONTROL_ROOT): string {
  const search = `${layout.home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  return ["#!/bin/sh", "set -eu", `. ${q(`${root}/environment`)}`,
    `PATH=${q(search)}; export PATH`, `executable=$(command -v ${q(tool)}) || { echo ${q(`${tool} is not installed in the sandbox image`)} >&2; exit 127; }`,
    'exec "$executable" "$@"', ""].join("\n");
}

/** Materialize after allocation, never into the image or a prewarmed pool. */
export async function materializeAgentSourceControl(input: {
  readonly sandbox: SandboxHandle;
  readonly layout: SandboxRuntimeLayout;
  readonly credentials: AgentSourceControlCredentials;
  readonly root?: string;
}): Promise<void> {
  const { sandbox, layout, credentials } = input;
  const root = input.root ?? AGENT_SOURCE_CONTROL_ROOT;
  const prepare = await sandbox.process.executeCommand(
    `set -eu; umask 077; if [ -e ${q(root)} ] || [ -L ${q(root)} ]; then ` +
      `test -d ${q(root)} && test ! -L ${q(root)} && test "$(stat -c %u ${q(root)})" = "$(id -u)"; ` +
      `else mkdir -m 700 ${q(root)}; fi; chmod 700 ${q(root)}; ` +
      `test ! -L ${q(`${root}/bin`)}; mkdir -p ${q(`${root}/bin`)}; chmod 700 ${q(`${root}/bin`)}`,
    undefined, undefined, 20,
  );
  if ((prepare.exitCode ?? 1) !== 0) throw new Error("Could not prepare sandbox source-control credentials");
  const files = [
    { path: `${root}/environment`, content: sourceControlEnvironment(credentials, root), mode: "644" },
    { path: `${root}/credential`, content: sourceControlCredentialHelper(root), mode: "755" },
    ...(["git", "gh", "glab"] as const).map((tool) => ({ path: `${root}/bin/${tool}`, content: sourceControlCommandWrapper(tool, layout, root), mode: "755" })),
  ];
  for (const file of files) {
    const temp = `${file.path}.${randomUUID()}.tmp`;
    await sandbox.fs.uploadFile(Buffer.from(file.content, "utf8"), temp, 60);
    const installed = await sandbox.process.executeCommand(
      `set -eu; test -f ${q(temp)} && test ! -L ${q(temp)}; chmod ${file.mode} ${q(temp)}; mv -f -- ${q(temp)} ${q(file.path)}`,
      undefined, undefined, 20,
    );
    if ((installed.exitCode ?? 1) !== 0) throw new Error("Could not install sandbox source-control credentials");
  }
  const ready = await sandbox.process.executeCommand(`chmod 755 ${q(`${root}/bin`)} ${q(root)}`, undefined, undefined, 10);
  if ((ready.exitCode ?? 1) !== 0) throw new Error("Could not make source-control tools available to the agent");
}

// Pinned GitHub and GitLab CLI releases, verified against upstream SHA-256 manifests.
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { AGENT_SOURCE_CONTROL_ENV } from "../repositories/agent-credentials";

export const GITHUB_CLI_VERSION = "2.95.0";
export const GITLAB_CLI_VERSION = "1.99.0";
const GH_SHA: Readonly<Record<string, string>> = {
  amd64: "25d1e4729e8808c9ed3d613e96ebd3f3e44446f2d368c89d878a71a36ddb3d8c",
  arm64: "d41e0b3b6218e5741c8bb4db39b16e53a59e0e06299a8489bd38f623ef7ebaae",
};
const GLAB_SHA: Readonly<Record<string, string>> = {
  amd64: "85cc54b35eef8196026d18d0a0e74d2343acff7dcbd199af089c506c91314fdc",
  arm64: "f65737b39193b3c26d0ee3f94c8475bc5284e2b126eab1c25f5c4747701c4c77",
};

function q(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function sourceControlEngineWrapperPath(layout: SandboxRuntimeLayout, engine: "codex" | "opencode"): string {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  return `${prefix}/bin/useagent-${engine}`;
}

export function sourceControlEngineWrapper(layout: SandboxRuntimeLayout, engine: "codex" | "opencode", sourceControlEnv = AGENT_SOURCE_CONTROL_ENV): string {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  return ["#!/bin/sh", `[ ! -r ${q(sourceControlEnv)} ] || . ${q(sourceControlEnv)}`,
    `exec ${q(`${prefix}/bin/${engine}`)} "$@"`, ""].join("\n");
}

export function sourceControlToolInstallCommand(layout: SandboxRuntimeLayout, options: {
  readonly github: boolean;
  readonly gitlab: boolean;
  readonly pinned?: boolean;
}): string {
  const bin = layout.runsAsRoot ? "/usr/local/bin" : `${layout.home}/.local/bin`;
  const githubCheck = options.pinned
    ? `${q(`${bin}/gh`)} --version 2>/dev/null | head -1 | grep -Fq ${q(`gh version ${GITHUB_CLI_VERSION}`)}`
    : "command -v gh >/dev/null 2>&1";
  const gitlabCheck = options.pinned
    ? `${q(`${bin}/glab`)} --version 2>/dev/null | head -1 | grep -Eq ${q(`^glab (version )?${GITLAB_CLI_VERSION.replaceAll(".", "\\.")}( |$)`)}`
    : "command -v glab >/dev/null 2>&1";
  return [
    "set -eu",
    `PATH=${q(`${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)}; export PATH`,
    "command -v git >/dev/null 2>&1 || { echo 'git is not installed in the sandbox image' >&2; exit 1; }",
    `mkdir -p ${q(bin)}`,
    'case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported sandbox architecture" >&2; exit 1 ;; esac',
    'tmp=$(mktemp -d); trap \'rm -rf -- "$tmp"\' EXIT',
    ...(options.github ? [
      `if ! (${githubCheck}); then`,
      `  case "$arch" in amd64) sha=${q(GH_SHA.amd64!)} ;; arm64) sha=${q(GH_SHA.arm64!)} ;; esac`,
      `  archive="gh_${GITHUB_CLI_VERSION}_linux_$arch.tar.gz"`,
      `  curl -fsSL --connect-timeout 10 --max-time 120 "https://github.com/cli/cli/releases/download/v${GITHUB_CLI_VERSION}/$archive" -o "$tmp/gh.tar.gz"`,
      '  printf "%s  %s\\n" "$sha" "$tmp/gh.tar.gz" | sha256sum -c - >/dev/null',
      `  tar -xzf "$tmp/gh.tar.gz" -C "$tmp" "gh_${GITHUB_CLI_VERSION}_linux_$arch/bin/gh"`,
      `  install -m 755 "$tmp/gh_${GITHUB_CLI_VERSION}_linux_$arch/bin/gh" ${q(`${bin}/gh`)}`,
      "fi",
    ] : []),
    ...(options.gitlab ? [
      `if ! (${gitlabCheck}); then`,
      `  case "$arch" in amd64) sha=${q(GLAB_SHA.amd64!)} ;; arm64) sha=${q(GLAB_SHA.arm64!)} ;; esac`,
      `  archive="glab_${GITLAB_CLI_VERSION}_linux_$arch.tar.gz"`,
      `  curl -fsSL --connect-timeout 10 --max-time 120 "https://gitlab.com/gitlab-org/cli/-/releases/v${GITLAB_CLI_VERSION}/downloads/$archive" -o "$tmp/glab.tar.gz"`,
      '  printf "%s  %s\\n" "$sha" "$tmp/glab.tar.gz" | sha256sum -c - >/dev/null',
      '  tar -xzf "$tmp/glab.tar.gz" -C "$tmp" bin/glab',
      `  install -m 755 "$tmp/bin/glab" ${q(`${bin}/glab`)}`,
      "fi",
    ] : []),
  ].join("\n");
}

export async function ensureSourceControlTools(sandbox: SandboxHandle, layout: SandboxRuntimeLayout,
  options: { readonly github: boolean; readonly gitlab: boolean }): Promise<void> {
  if (!options.github && !options.gitlab) return;
  const result = await sandbox.process.executeCommand(sourceControlToolInstallCommand(layout, options), undefined, undefined, 300);
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("Could not install source-control tools in the sandbox. Add git, gh and glab to the image or allow the sandbox to download their pinned releases.");
  }
}

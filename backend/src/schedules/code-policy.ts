// Explicit repository authority for unattended code actions.
import type { AutomationCodePolicy } from "../db/schema/schedules";
import { normalizeGitHubRepository } from "../resources/github-resolver";
import { GITLAB_REPOSITORY_PREFIX, normalizeGitLabRepository } from "../resources/gitlab-resolver";
import { sandboxRepositoryActionsSupported } from "../engines/permission-mode";

export function parseCodePolicy(value: unknown): AutomationCodePolicy | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid code automation policy.");
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).some((key) => !["version", "mode", "repository", "draft", "allowSandboxActions", "nativeAuto"].includes(key)) ||
      !((policy.version === 1 && (policy.mode === "publish" || policy.mode === "review")) ||
        (policy.version === 2 && policy.mode === "agent" && policy.draft === false)) ||
      typeof policy.repository !== "string" || typeof policy.draft !== "boolean" || typeof policy.allowSandboxActions !== "boolean" ||
      (policy.nativeAuto !== undefined && (policy.version !== 2 || typeof policy.nativeAuto !== "boolean" || (policy.nativeAuto && !policy.allowSandboxActions)))) {
    throw new Error("Invalid code automation policy.");
  }
  const repository = policy.repository;
  const valid = repository.startsWith(GITLAB_REPOSITORY_PREFIX)
    ? normalizeGitLabRepository(repository) === repository.slice(GITLAB_REPOSITORY_PREFIX.length)
    : normalizeGitHubRepository(repository) === repository;
  if (!valid) throw new Error("Select a valid GitHub or GitLab repository.");
  if (policy.version === 2) return { version: 2, mode: "agent", repository, draft: false, allowSandboxActions: policy.allowSandboxActions,
    ...(policy.nativeAuto === undefined ? {} : { nativeAuto: policy.nativeAuto as boolean }) };
  return { version: 1, mode: policy.mode as "publish" | "review", repository, draft: policy.draft, allowSandboxActions: policy.allowSandboxActions };
}

export function assertCodePolicyRepository(policy: AutomationCodePolicy | null, repos: readonly string[], owner: string | null): void {
  if (!policy) return;
  if (!owner) throw new Error("Code automation requires an owner.");
  if (repos.length !== 1 || repos[0] !== policy.repository) throw new Error("Choose exactly the repository authorized for this automation.");
}

export function assertCodePolicyEngine(policy: AutomationCodePolicy | null, engine: string): void {
  if (policy?.version === 2 && policy.nativeAuto && engine !== "kolega") {
    throw new Error("Native auto is available only for Kolega Code.");
  }
  if (policy && !sandboxRepositoryActionsSupported(engine, policy.allowSandboxActions)) {
    throw new Error("Choose a sandbox coding agent that can honor the selected approval setting.");
  }
}

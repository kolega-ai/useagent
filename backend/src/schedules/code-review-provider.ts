// Provider API operations for discovering and merging an exact reviewed revision.
import type { AutomationReviewTarget } from "../db/schema/schedules";
import { resolveGithubPublicationToken } from "../github/auth";
import { authorizeGitLabProject } from "../gitlab/checkout";
import { gitLabRequest, type GitLabProject, type GitLabRequestOptions } from "../gitlab/client";
import { isSafeGitRevision } from "../resources/github-resolver";
import { GITLAB_REPOSITORY_PREFIX } from "../resources/gitlab-resolver";

const SHA = /^[a-f0-9]{40}$/u;
type GithubPull = { number?: unknown; html_url?: unknown; state?: unknown; draft?: unknown; merged?: unknown;
  mergeable?: unknown; mergeable_state?: unknown; head?: { sha?: unknown; ref?: unknown }; base?: { ref?: unknown; repo?: { full_name?: unknown } } };
type GitLabMerge = { iid?: unknown; web_url?: unknown; state?: unknown; draft?: unknown; work_in_progress?: unknown;
  sha?: unknown; source_branch?: unknown; target_branch?: unknown; source_project_id?: unknown; target_project_id?: unknown;
  detailed_merge_status?: unknown; has_conflicts?: unknown };

export interface ReviewProviderDependencies {
  githubToken(orgId: string, repository: string): Promise<string>;
  gitlabProject(orgId: string, repository: string): Promise<{ token: string; project: GitLabProject }>;
  github<T>(token: string, path: string, options?: { method?: "GET" | "PUT"; body?: unknown; signal?: AbortSignal }): Promise<T>;
  gitlab<T>(token: string, path: string, options?: GitLabRequestOptions): Promise<T>;
}

export async function githubRequest<T>(token: string, path: string, options: { method?: "GET" | "PUT"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitHub API path.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(`https://api.github.com${path}`, { method: options.method ?? "GET", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "useagent", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: controller.signal });
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
    return await response.json() as T;
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

const production: ReviewProviderDependencies = {
  githubToken: (orgId, repository) => resolveGithubPublicationToken(repository, orgId),
  gitlabProject: authorizeGitLabProject,
  github: githubRequest,
  gitlab: gitLabRequest,
};

export function githubPath(repository: string): string {
  const [owner, name] = repository.split("/");
  return `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

function target(provider: "github" | "gitlab", repository: string, number: unknown, sha: unknown,
  source: unknown, base: unknown): AutomationReviewTarget | null {
  if (!Number.isSafeInteger(number) || Number(number) < 1 || typeof sha !== "string" || !SHA.test(sha) ||
      typeof source !== "string" || !isSafeGitRevision(source) || typeof base !== "string" || !isSafeGitRevision(base)) return null;
  return { provider, repository, number: Number(number), headSha: sha, sourceBranch: source, targetBranch: base };
}

export function reviewKey(value: AutomationReviewTarget): string { return `${value.provider}:${value.number}:${value.headSha}`; }

export async function findReviewTarget(orgId: string, repository: string, excluded: ReadonlySet<string>, signal: AbortSignal,
  deps: ReviewProviderDependencies = production): Promise<AutomationReviewTarget | null> {
  if (repository.startsWith(GITLAB_REPOSITORY_PREFIX)) {
    const projectPath = repository.slice(GITLAB_REPOSITORY_PREFIX.length);
    const { token, project } = await deps.gitlabProject(orgId, projectPath);
    for (let page = 1; page <= 20; page++) {
      const rows = await deps.gitlab<GitLabMerge[]>(token, `/projects/${encodeURIComponent(projectPath)}/merge_requests?state=opened&scope=all&per_page=100&order_by=created_at&sort=asc&page=${page}`, { signal });
      if (!Array.isArray(rows)) throw new Error("GitLab returned an invalid merge-request list.");
      for (const row of rows) {
        if (row.state !== "opened" || row.draft === true || row.work_in_progress === true ||
            row.source_project_id !== project.id || row.target_project_id !== project.id) continue;
        const candidate = target("gitlab", repository, row.iid, row.sha, row.source_branch, row.target_branch);
        if (candidate && !excluded.has(reviewKey(candidate))) return candidate;
      }
      if (rows.length < 100) return null;
    }
    throw new Error("There are too many open GitLab merge requests to select safely.");
  }
  const token = await deps.githubToken(orgId, repository);
  for (let page = 1; page <= 20; page++) {
    const rows = await deps.github<GithubPull[]>(token, `${githubPath(repository)}/pulls?state=open&per_page=100&sort=created&direction=asc&page=${page}`, { signal });
    if (!Array.isArray(rows)) throw new Error("GitHub returned an invalid pull-request list.");
    for (const row of rows) {
      if (row.state !== "open" || row.draft === true || typeof row.base?.repo?.full_name !== "string" ||
          row.base.repo.full_name.toLowerCase() !== repository.toLowerCase()) continue;
      const candidate = target("github", repository, row.number, row.head?.sha, row.head?.ref, row.base.ref);
      if (candidate && !excluded.has(reviewKey(candidate))) return candidate;
    }
    if (rows.length < 100) return null;
  }
  throw new Error("There are too many open GitHub pull requests to select safely.");
}

export type MergeOutcome = { readonly status: "merged" | "waiting" | "stale"; readonly url?: string; readonly reason?: string };

export async function mergeReviewedTarget(input: { orgId: string; target: AutomationReviewTarget; signal: AbortSignal;
  assertAuthorized: () => Promise<void> }, deps: ReviewProviderDependencies = production): Promise<MergeOutcome> {
  const { target: selected, orgId, signal } = input;
  if (!target(selected.provider, selected.repository, selected.number, selected.headSha, selected.sourceBranch, selected.targetBranch)) {
    throw new Error("Invalid reviewed request identity.");
  }
  if (selected.provider === "gitlab") {
    if (!selected.repository.startsWith(GITLAB_REPOSITORY_PREFIX)) throw new Error("Invalid GitLab repository.");
    const repository = selected.repository.slice(GITLAB_REPOSITORY_PREFIX.length);
    const { token, project } = await deps.gitlabProject(orgId, repository);
    const path = `/projects/${encodeURIComponent(repository)}/merge_requests/${selected.number}`;
    const mr = await deps.gitlab<GitLabMerge>(token, path, { signal });
    const url = `https://gitlab.com/${repository}/-/merge_requests/${selected.number}`;
    if (mr.iid !== selected.number || mr.web_url !== url || mr.source_project_id !== project.id || mr.target_project_id !== project.id ||
        mr.sha !== selected.headSha || mr.source_branch !== selected.sourceBranch || mr.target_branch !== selected.targetBranch) {
      return { status: "stale", reason: "The reviewed merge request changed." };
    }
    if (mr.state === "merged") return { status: "merged", url };
    if (mr.state !== "opened") return { status: "stale", reason: "The merge request is no longer open." };
    if (mr.draft === true || mr.work_in_progress === true || mr.has_conflicts === true || mr.detailed_merge_status !== "mergeable") {
      return { status: "waiting", reason: "GitLab has not marked the merge request mergeable." };
    }
    await input.assertAuthorized();
    const merged = await deps.gitlab<GitLabMerge>(token, `${path}/merge`, { method: "PUT", body: { sha: selected.headSha }, signal });
    if (merged.state !== "merged" || merged.iid !== selected.number || merged.sha !== selected.headSha || merged.web_url !== url) {
      throw new Error("GitLab did not confirm the merge.");
    }
    return { status: "merged", url };
  }
  const token = await deps.githubToken(orgId, selected.repository);
  const path = `${githubPath(selected.repository)}/pulls/${selected.number}`;
  const pr = await deps.github<GithubPull>(token, path, { signal });
  const url = `https://github.com/${selected.repository}/pull/${selected.number}`;
  if (pr.number !== selected.number || pr.html_url !== url || pr.head?.sha !== selected.headSha ||
      pr.head.ref !== selected.sourceBranch || pr.base?.ref !== selected.targetBranch ||
      typeof pr.base.repo?.full_name !== "string" || pr.base.repo.full_name.toLowerCase() !== selected.repository.toLowerCase()) {
    return { status: "stale", reason: "The reviewed pull request changed." };
  }
  if (pr.merged === true) return { status: "merged", url };
  if (pr.state !== "open") return { status: "stale", reason: "The pull request is no longer open." };
  if (pr.draft === true || pr.mergeable !== true || pr.mergeable_state !== "clean") {
    return { status: "waiting", reason: "GitHub has not marked the pull request ready to merge." };
  }
  await input.assertAuthorized();
  const result = await deps.github<{ merged?: unknown }>(token, `${path}/merge`, { method: "PUT", body: { sha: selected.headSha }, signal });
  if (result.merged !== true) throw new Error("GitHub did not confirm the merge.");
  return { status: "merged", url };
}

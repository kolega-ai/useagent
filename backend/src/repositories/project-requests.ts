// Read a single authorized repository's open change requests for its project view.
import { githubAllowedOwners, gitlabExcludedGroups } from "../env";
import { resolveGithubCatalogAuth } from "../github/auth";
import { fetchRepoPulls } from "../github/pulls";
import { listRepos } from "../github/repos";
import { gitLabProject, gitLabRequest } from "../gitlab/client";
import { gitLabToken } from "../gitlab/connection";
import { normalizeGitHubRepository } from "../resources/github-resolver";
import { GITLAB_REPOSITORY_PREFIX, normalizeGitLabRepository } from "../resources/gitlab-resolver";

export interface ProjectChangeRequest {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updated_at: string;
}

export interface ProjectRequests {
  provider: "github" | "gitlab";
  requests: ProjectChangeRequest[];
  truncated: boolean;
}

export class ProjectRepositoryUnavailable extends Error {}

type GitLabMergeRequest = {
  iid?: unknown;
  title?: unknown;
  draft?: unknown;
  work_in_progress?: unknown;
  updated_at?: unknown;
  target_project_id?: unknown;
};

const production = {
  githubRepos: listRepos,
  githubAuth: resolveGithubCatalogAuth,
  githubPulls: fetchRepoPulls,
  gitlabToken: gitLabToken,
  gitlabProject: gitLabProject,
  gitlabRequest: gitLabRequest<GitLabMergeRequest[]>,
};

export async function listProjectRequests(
  orgId: string,
  repository: string,
  deps: typeof production = production,
): Promise<ProjectRequests> {
  if (repository.startsWith(GITLAB_REPOSITORY_PREFIX)) {
    const path = normalizeGitLabRepository(repository);
    if (!path || `${GITLAB_REPOSITORY_PREFIX}${path}` !== repository ||
        gitlabExcludedGroups().some((group) => path.toLowerCase().startsWith(`${group}/`))) {
      throw new ProjectRepositoryUnavailable();
    }
    const token = await deps.gitlabToken(orgId);
    if (!token) throw new ProjectRepositoryUnavailable();
    const project = await deps.gitlabProject(token, path);
    const rows = await deps.gitlabRequest(token,
      `/projects/${encodeURIComponent(path)}/merge_requests?state=opened&scope=all&per_page=51&order_by=updated_at&sort=desc`);
    if (!Array.isArray(rows)) throw new Error("Invalid GitLab change request response");
    const requests = rows.map((row): ProjectChangeRequest => {
      if (!Number.isSafeInteger(row.iid) || Number(row.iid) < 1 || row.target_project_id !== project.id ||
          typeof row.title !== "string" || typeof row.updated_at !== "string") throw new Error("Invalid GitLab change request");
      return { number: Number(row.iid), title: row.title, url: `https://gitlab.com/${path}/-/merge_requests/${row.iid}`,
        draft: row.draft === true || row.work_in_progress === true, updated_at: row.updated_at };
    });
    return { provider: "gitlab", requests: requests.slice(0, 50), truncated: rows.length > 50 };
  }

  const normalized = normalizeGitHubRepository(repository);
  const allowed = githubAllowedOwners();
  if (!normalized || (allowed && !allowed.has((normalized.split("/")[0] ?? "").toLowerCase()))) {
    throw new ProjectRepositoryUnavailable();
  }
  const listing = await deps.githubRepos(orgId);
  if (listing.error) throw new Error("GitHub repositories unavailable");
  const selected = listing.repos.find((item) => item.full_name.toLowerCase() === normalized.toLowerCase());
  if (!selected) throw new ProjectRepositoryUnavailable();
  const auth = await deps.githubAuth(orgId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const pulls = await deps.githubPulls(selected.full_name, auth.token, controller.signal, 31);
    if (pulls.some((pull) => !Number.isSafeInteger(pull.number) || pull.number < 1 ||
      typeof pull.title !== "string" || typeof pull.updated_at !== "string")) throw new Error("Invalid GitHub change request");
    return {
      provider: "github",
      requests: pulls.slice(0, 30).map((pull) => ({
        number: pull.number, title: pull.title, url: `https://github.com/${selected.full_name}/pull/${pull.number}`,
        draft: pull.draft, updated_at: pull.updated_at,
      })),
      truncated: pulls.length > 30,
    };
  } finally { clearTimeout(timer); }
}

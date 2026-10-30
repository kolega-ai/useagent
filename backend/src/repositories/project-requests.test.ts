import { afterEach, expect, test } from "bun:test";
import { listProjectRequests, ProjectRepositoryUnavailable } from "./project-requests";

const originalExcluded = process.env.GITLAB_EXCLUDED_GROUPS;
const originalAllowed = process.env.GITHUB_ALLOWED_OWNERS;
afterEach(() => {
  if (originalExcluded === undefined) delete process.env.GITLAB_EXCLUDED_GROUPS;
  else process.env.GITLAB_EXCLUDED_GROUPS = originalExcluded;
  if (originalAllowed === undefined) delete process.env.GITHUB_ALLOWED_OWNERS;
  else process.env.GITHUB_ALLOWED_OWNERS = originalAllowed;
});

type Deps = NonNullable<Parameters<typeof listProjectRequests>[2]>;
const deps: Deps = {
  githubRepos: async () => ({ configured: true, repos: [{ full_name: "team/repo", name: "repo", private: true, default_branch: "main" }] }),
  githubAuth: async () => ({ token: "fixture", owner: null, source: "pat", connectionId: null }),
  githubPulls: async () => [{ id: "team/repo#4", repo: "team/repo", number: 4, title: "Improve speed", state: "open",
    draft: false, author: "dev", author_avatar_url: null, url: "https://wrong.example/4", updated_at: "2026-10-30T00:00:00Z" }],
  gitlabToken: async () => "fixture",
  gitlabProject: async (_token, path) => ({ id: 42, path_with_namespace: path, name: "repo", default_branch: "main", visibility: "private" }),
  gitlabRequest: async () => [{ iid: 3, title: "Fix tests", draft: true, target_project_id: 42, updated_at: "2026-10-30T00:00:00Z" }],
};

test("project requests resolve an authorized GitHub repository and construct a safe link", async () => {
  delete process.env.GITHUB_ALLOWED_OWNERS;
  expect(await listProjectRequests("org", "team/repo", deps)).toEqual({ provider: "github", truncated: false,
    requests: [{ number: 4, title: "Improve speed", draft: false, url: "https://github.com/team/repo/pull/4", updated_at: "2026-10-30T00:00:00Z" }] });
  await expect(listProjectRequests("org", "team/other", deps)).rejects.toBeInstanceOf(ProjectRepositoryUnavailable);
  process.env.GITHUB_ALLOWED_OWNERS = "another-team";
  await expect(listProjectRequests("org", "team/repo", deps)).rejects.toBeInstanceOf(ProjectRepositoryUnavailable);
});

test("project requests preserve nested GitLab paths and respect excluded groups", async () => {
  delete process.env.GITLAB_EXCLUDED_GROUPS;
  expect(await listProjectRequests("org", "gitlab.com/team/sub/repo", deps)).toEqual({ provider: "gitlab", truncated: false,
    requests: [{ number: 3, title: "Fix tests", draft: true, url: "https://gitlab.com/team/sub/repo/-/merge_requests/3", updated_at: "2026-10-30T00:00:00Z" }] });
  process.env.GITLAB_EXCLUDED_GROUPS = "team/sub";
  await expect(listProjectRequests("org", "gitlab.com/team/sub/repo", deps)).rejects.toBeInstanceOf(ProjectRepositoryUnavailable);
});

test("malformed upstream data is not presented as an empty project", async () => {
  delete process.env.GITLAB_EXCLUDED_GROUPS;
  const broken = { ...deps, gitlabRequest: async () => [{ iid: 1, title: "Missing target", updated_at: "2026-10-30T00:00:00Z" }] };
  await expect(listProjectRequests("org", "gitlab.com/team/repo", broken)).rejects.toThrow("Invalid GitLab change request");
});

test("a full GitHub page reports truncation only when an additional request exists", async () => {
  delete process.env.GITHUB_ALLOWED_OWNERS;
  const example = (await deps.githubPulls("team/repo", "fixture", new AbortController().signal))[0];
  if (!example) throw new Error("missing pull request fixture");
  const result = await listProjectRequests("org", "team/repo", { ...deps,
    githubPulls: async () => Array.from({ length: 31 }, (_, index) => ({ ...example, number: index + 1 })) });
  expect(result.requests).toHaveLength(30);
  expect(result.truncated).toBe(true);
});

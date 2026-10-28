import { describe, expect, test } from "bun:test";
import { findReviewTarget, mergeReviewedTarget, type ReviewProviderDependencies } from "./code-review-provider";

const sha = "a".repeat(40);
const github = { provider: "github" as const, repository: "owner/repo", number: 4, headSha: sha, sourceBranch: "topic", targetBranch: "main" };
const gitlab = { provider: "gitlab" as const, repository: "gitlab.com/group/repo", number: 6, headSha: sha, sourceBranch: "topic", targetBranch: "main" };

function setup() {
  const writes: { provider: string; body: unknown }[] = [];
  let authorized = 0;
  const gh = { number: 4, html_url: "https://github.com/owner/repo/pull/4", state: "open", draft: false,
    merged: false, mergeable: true, mergeable_state: "clean", head: { sha, ref: "topic" }, base: { ref: "main", repo: { full_name: "owner/repo" } } };
  const gl = { iid: 6, web_url: "https://gitlab.com/group/repo/-/merge_requests/6", state: "opened", draft: false,
    sha, source_branch: "topic", target_branch: "main", source_project_id: 9, target_project_id: 9,
    detailed_merge_status: "mergeable", has_conflicts: false };
  const deps: ReviewProviderDependencies = {
    githubToken: async () => "fixture",
    gitlabProject: async () => ({ token: "fixture", project: { id: 9, path_with_namespace: "group/repo", name: "repo", default_branch: "main", visibility: "private" } }),
    github: async <T>(_token: string, path: string, options?: { method?: "GET" | "PUT"; body?: unknown }) => {
      if (options?.method === "PUT") { writes.push({ provider: "github", body: options.body }); return { merged: true } as T; }
      return (path.includes("?state=open") ? [gh] : gh) as T;
    },
    gitlab: async <T>(_token: string, path: string, options?: { method?: "GET" | "POST" | "PUT"; body?: unknown }) => {
      if (options?.method === "PUT") { writes.push({ provider: "gitlab", body: options.body }); return { ...gl, state: "merged" } as T; }
      return (path.includes("?state=opened") ? [gl] : gl) as T;
    },
  };
  return { deps, gh, gl, writes, assertAuthorized: async () => { authorized++; }, authorized: () => authorized };
}

describe("automatic code review provider boundary", () => {
  test("selects open non-draft requests and skips an already reviewed revision", async () => {
    const { deps } = setup();
    const signal = new AbortController().signal;
    expect(await findReviewTarget("org", github.repository, new Set(), signal, deps)).toEqual(github);
    expect(await findReviewTarget("org", github.repository, new Set([`github:4:${sha}`]), signal, deps)).toBeNull();
    expect(await findReviewTarget("org", gitlab.repository, new Set(), signal, deps)).toEqual(gitlab);
  });
  test("GitHub merges only the approved head after provider readiness and authority checks", async () => {
    const s = setup();
    const input = { orgId: "org", target: github, signal: new AbortController().signal, assertAuthorized: s.assertAuthorized };
    s.gh.mergeable_state = "unstable";
    expect((await mergeReviewedTarget(input, s.deps)).status).toBe("waiting");
    s.gh.mergeable_state = "clean";
    s.gh.head.sha = "b".repeat(40);
    expect((await mergeReviewedTarget(input, s.deps)).status).toBe("stale");
    expect(s.writes).toHaveLength(0);
    s.gh.head.sha = sha;
    expect((await mergeReviewedTarget(input, s.deps)).status).toBe("merged");
    expect(s.authorized()).toBe(1);
    expect(s.writes).toEqual([{ provider: "github", body: { sha } }]);
  });
  test("GitLab waits for mergeability and passes the reviewed SHA to merge", async () => {
    const s = setup();
    const input = { orgId: "org", target: gitlab, signal: new AbortController().signal, assertAuthorized: s.assertAuthorized };
    s.gl.detailed_merge_status = "ci_still_running";
    expect((await mergeReviewedTarget(input, s.deps)).status).toBe("waiting");
    s.gl.detailed_merge_status = "mergeable";
    expect((await mergeReviewedTarget(input, s.deps)).status).toBe("merged");
    expect(s.authorized()).toBe(1);
    expect(s.writes).toEqual([{ provider: "gitlab", body: { sha } }]);
  });
  test("a previously merged exact revision is reconciled without another write", async () => {
    const s = setup();
    s.gl.state = "merged";
    expect((await mergeReviewedTarget({ orgId: "org", target: gitlab, signal: new AbortController().signal,
      assertAuthorized: s.assertAuthorized }, s.deps)).status).toBe("merged");
    expect(s.writes).toHaveLength(0);
  });
  test("a revoked authorization prevents a provider merge write", async () => {
    const s = setup();
    await expect(mergeReviewedTarget({ orgId: "org", target: gitlab, signal: new AbortController().signal,
      assertAuthorized: async () => { throw new Error("revoked"); } }, s.deps)).rejects.toThrow("revoked");
    expect(s.writes).toHaveLength(0);
  });
  test("selection searches beyond the first page and skips GitLab forks and drafts", async () => {
    const s = setup();
    const draft = { ...s.gl, draft: true };
    const fork = { ...s.gl, source_project_id: 10 };
    let pages = 0;
    s.deps.gitlab = async <T>(_token: string, path: string) => {
      pages++;
      return (/[?&]page=1(?:&|$)/u.test(path) ? Array(100).fill(draft) : [fork, s.gl]) as T;
    };
    expect(await findReviewTarget("org", gitlab.repository, new Set(), new AbortController().signal, s.deps)).toEqual(gitlab);
    expect(pages).toBe(2);
  });
});

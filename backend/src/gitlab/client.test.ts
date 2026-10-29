import { afterEach, describe, expect, mock, test } from "bun:test";
import { gitLabProject, gitLabProjects, gitLabRequest } from "./client";

const originalFetch = globalThis.fetch;
const originalExcludedGroups = process.env.GITLAB_EXCLUDED_GROUPS;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalExcludedGroups === undefined) delete process.env.GITLAB_EXCLUDED_GROUPS;
  else process.env.GITLAB_EXCLUDED_GROUPS = originalExcludedGroups;
  mock.restore();
});

describe("GitLab API boundary", () => {
  test("uses a header for the token, refuses redirects and verifies project identity", async () => {
    let called = false;
    globalThis.fetch = mock(async (url, init) => {
      called = true;
      expect(String(url)).toBe("https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo");
      expect(init?.headers).toEqual({ "PRIVATE-TOKEN": "fixture-secret", Accept: "application/json" });
      expect(init?.redirect).toBe("error");
      return Response.json({ id: 9, path_with_namespace: "group/sub/repo", name: "repo", visibility: "private", default_branch: "main" });
    }) as unknown as typeof fetch;
    expect((await gitLabProject("fixture-secret", "group/sub/repo")).id).toBe(9);
    expect(called).toBe(true);
    await expect(gitLabProject("fixture-secret", "group/../repo")).rejects.toThrow("Invalid GitLab project");
  });

  test("does not expose response bodies on errors or follow a foreign API origin", async () => {
    globalThis.fetch = mock(async () => new Response("fixture-secret", { status: 403 })) as unknown as typeof fetch;
    await expect(gitLabRequest("fixture-secret", "/user")).rejects.toThrow("HTTP 403");
    await expect(gitLabRequest("fixture-secret", "//attacker.invalid")).rejects.toThrow("Invalid GitLab API path");
  });

  test("offers valid private projects using provider-qualified names", async () => {
    globalThis.fetch = mock(async () => Response.json([
      { id: 7, path_with_namespace: "a/b/c", name: "c", visibility: "private", default_branch: "main" },
      { id: 0, path_with_namespace: "../bad", name: "bad", visibility: "private" },
    ])) as unknown as typeof fetch;
    expect(await gitLabProjects("fixture-secret")).toEqual([{ full_name: "gitlab.com/a/b/c", name: "c", private: true, default_branch: "main" }]);
  });

  test("omits excluded groups and their subgroups without hiding similar names", async () => {
    process.env.GITLAB_EXCLUDED_GROUPS = " gitlab.com/Blocked-Group/ ";
    globalThis.fetch = mock(async () => Response.json([
      { id: 1, path_with_namespace: "blocked-group/a", name: "a", visibility: "private" },
      { id: 2, path_with_namespace: "blocked-group/sub/b", name: "b", visibility: "private" },
      { id: 3, path_with_namespace: "blocked-group-other/c", name: "c", visibility: "private" },
      { id: 4, path_with_namespace: "allowed/d", name: "d", visibility: "private" },
    ])) as unknown as typeof fetch;
    expect((await gitLabProjects("fixture-secret", "group")).map((project) => project.full_name)).toEqual([
      "gitlab.com/blocked-group-other/c", "gitlab.com/allowed/d",
    ]);
  });

  test("searches project names and namespaces and reads all advertised pages", async () => {
    const pages: number[] = [];
    globalThis.fetch = mock(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("search")).toBe("subgroup");
      expect(url.searchParams.get("search_namespaces")).toBe("true");
      expect(url.searchParams.get("membership")).toBe("true");
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      return Response.json([{ id: page, path_with_namespace: `group/subgroup/repo-${page}`, name: `repo-${page}`, visibility: "private" }],
        { headers: { "x-total-pages": "3" } });
    }) as unknown as typeof fetch;
    const projects = await gitLabProjects("fixture-secret", "subgroup");
    expect(pages.sort()).toEqual([1, 2, 3]);
    expect(projects.map((project) => project.full_name)).toEqual([
      "gitlab.com/group/subgroup/repo-1", "gitlab.com/group/subgroup/repo-2", "gitlab.com/group/subgroup/repo-3",
    ]);
  });

  test("does not silently truncate an oversized project search", async () => {
    globalThis.fetch = mock(async () => Response.json([], { headers: { "x-total-pages": "51" } })) as unknown as typeof fetch;
    await expect(gitLabProjects("fixture-secret", "group")).rejects.toThrow("refine your search");
  });
});

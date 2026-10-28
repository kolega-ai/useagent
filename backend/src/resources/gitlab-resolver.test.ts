import { describe, expect, test } from "bun:test";
import { createRunResourceAuthorization } from "./authorization";
import { gitlabResourceResolver, normalizeGitLabRepository } from "./gitlab-resolver";
import { explicitRepositoryResources, resolveRunIntake } from "./run-intake";

describe("GitLab repository identity", () => {
  test("keeps nested project paths distinct from the same GitHub name", async () => {
    const result = await resolveRunIntake({ source: "web", text: "", explicitResources: explicitRepositoryResources([
      "team/repo", "gitlab.com/team/group/repo:feature/ref",
    ]) }, { authorize: async () => true });
    expect(result.repos).toEqual(["team/repo", "gitlab.com/team/group/repo:feature/ref"]);
    expect(result.resources.map((r) => r.provider)).toEqual(["github", "gitlab"]);
    expect(result.resources[1]?.locator).toEqual({ type: "gitlab.repository", repository: "team/group/repo", revision: "feature/ref" });
  });

  test("rejects traversal, URL credentials and unsupported project subpaths", () => {
    expect(normalizeGitLabRepository("team/../repo")).toBeNull();
    expect(normalizeGitLabRepository("team/-/repo")).toBeNull();
    expect(() => gitlabResourceResolver.resolve({ raw: "https://user:pass@gitlab.com/team/repo", start: 0, end: 1 })).toThrow();
    expect(() => gitlabResourceResolver.resolve({ raw: "https://gitlab.com/team/repo/-/blob/main/file", start: 0, end: 1 })).toThrow();
  });

  test("rechecks the selected project against the current organization", async () => {
    const inputs: string[] = [];
    const authorize = createRunResourceAuthorization("org-a", {
      verifyGitLabRepository: async (org, repo) => { inputs.push(`${org}:${repo}`); return org === "org-a" && repo === "group/sub/repo"; },
    });
    const accepted = await resolveRunIntake({ source: "web", text: "", explicitResources: explicitRepositoryResources(["gitlab.com/group/sub/repo"]) }, { authorize });
    expect(accepted.repos).toEqual(["gitlab.com/group/sub/repo"]);
    await expect(resolveRunIntake({ source: "web", text: "", explicitResources: explicitRepositoryResources(["gitlab.com/group/other"]) }, { authorize })).rejects.toThrow("GitLab is not connected");
    expect(inputs).toEqual(["org-a:group/sub/repo", "org-a:group/other"]);
  });
});

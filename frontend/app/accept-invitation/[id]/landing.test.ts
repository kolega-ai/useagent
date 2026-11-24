import { expect, test } from "bun:test";
import type { Workspace } from "@/lib/auth";
import type { WorkspaceProject } from "@/lib/project-access";
import { landingAfterJoin } from "./landing";

const workspace = (role: Workspace["role"]): Workspace => ({
  id: "k",
  name: "Kolega",
  role,
  active: true,
  members: 3,
  defaultName: false,
});
const projects: WorkspaceProject[] = [
  { id: "a", label: "notes", repository: null },
  { id: "b", label: "billing", repository: "gitlab.com/acme/billing" },
];

test("a project member lands on their first project with a repository", async () => {
  const to = await landingAfterJoin({
    listWorkspaces: async () => [workspace("project_member")],
    listWorkspaceProjects: async () => projects,
  });
  expect(to).toBe("/projects?repo=gitlab.com%2Facme%2Fbilling");
});

test("everyone else, a project member with no repository, and a failed read land on the start", async () => {
  expect(
    await landingAfterJoin({
      listWorkspaces: async () => [workspace("member")],
      listWorkspaceProjects: async () => projects,
    }),
  ).toBe("/");
  expect(
    await landingAfterJoin({
      listWorkspaces: async () => [workspace("project_member")],
      listWorkspaceProjects: async () => projects.slice(0, 1),
    }),
  ).toBe("/");
  expect(
    await landingAfterJoin({
      listWorkspaces: async () => {
        throw new Error("down");
      },
      listWorkspaceProjects: async () => projects,
    }),
  ).toBe("/");
});

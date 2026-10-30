import { expect, test } from "bun:test";

import type { ProjectGroup } from "@/components/session-ui/project-thread-tree";
import { projectMenuItems, taskBoardHref } from "./sidebar-project-menu";

const group = (over: Partial<ProjectGroup> = {}): ProjectGroup => ({
  key: "acme/api",
  label: "api",
  fullName: "acme/api",
  threads: [],
  ...over,
});

test("taskBoardHref deep-links to the project board with an encoded key", () => {
  expect(taskBoardHref("acme/api")).toBe("/tasks?project=acme%2Fapi");
});

test("the menu opens the project, task board, and new thread", () => {
  const items = projectMenuItems(group());
  expect(items.map((i) => i.label)).toEqual(["Open project", "Open task board", "New thread"]);
  expect(items[0].href).toBe("/projects?repo=acme%2Fapi");
  // "Open task board" targets the project's Kanban deep-link.
  expect(items[1].href).toBe("/tasks?project=acme%2Fapi");
  // "New thread" reuses the existing per-repo composer route (the folder it was
  // opened from already names the project).
  expect(items[2].href).toBe("/agent/new?repo=acme%2Fapi");
});

test("the no-project bucket carries no actions (no dead rows)", () => {
  expect(projectMenuItems(group({ fullName: null }))).toEqual([]);
});

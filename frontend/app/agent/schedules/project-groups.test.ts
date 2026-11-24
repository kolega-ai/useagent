import { expect, test } from "bun:test";
import { automationMatchesRepository } from "./project-scope";
import { automationProjectRepo, groupAutomationsByProject, type ScheduleRecord } from "./schedules-data";

function automation(id: string, extra: Partial<ScheduleRecord>): ScheduleRecord {
  return { id, name: id, repos: [], code_policy: null, ...extra } as ScheduleRecord;
}

const api = { id: "p-api", key: "acme/api", name: "api", repo: "acme/api" };
const billing = { id: "p-billing", key: "gitlab.com/acme/billing", name: "billing", repo: "gitlab.com/acme/billing" };

test("automations group by project, projects by name, legacy ones without a project last", () => {
  const groups = groupAutomationsByProject([
    automation("a1", { project_id: api.id, project: api }),
    automation("legacy", { project_id: null, project: null }),
    automation("b1", { project_id: billing.id, project: billing }),
    automation("a2", { project_id: api.id, project: api }),
  ]);
  expect(groups.map((group) => [group.label, group.repo, group.automations.map((item) => item.id)])).toEqual([
    ["api", "acme/api", ["a1", "a2"]],
    ["billing", "gitlab.com/acme/billing", ["b1"]],
    ["No project", null, ["legacy"]],
  ]);
});

test("a backend from before projects owned automations groups them by their repository", () => {
  const groups = groupAutomationsByProject([
    automation("x", { repos: ["acme/api:main"] }),
    automation("y", { code_policy: { version: 2, mode: "agent", repository: "acme/api", draft: false, allowSandboxActions: true } }),
  ]);
  expect(groups.map((group) => [group.label, group.repo, group.automations.length])).toEqual([["api", "acme/api", 2]]);
});

test("an automation's project repository is its project's, else what its work names", () => {
  expect(automationProjectRepo(automation("p", { project: billing, repos: ["acme/other"] }))).toBe("gitlab.com/acme/billing");
  expect(automationProjectRepo(automation("r", { repos: ["acme/api:dev"] }))).toBe("acme/api");
  expect(automationProjectRepo(automation("none", {}))).toBe("");
});

test("an automation belongs to a project page by its project when the server reports one", () => {
  // Its project wins over a repository it once named.
  expect(automationMatchesRepository(automation("p", { project: api, repos: ["acme/old"] }), "acme/api")).toBe(true);
  expect(automationMatchesRepository(automation("p", { project: api, repos: ["acme/old"] }), "acme/old")).toBe(false);
  expect(automationMatchesRepository(automation("none", { project: null, repos: ["acme/api"] }), "acme/api")).toBe(false);
  // A backend from before reports no project at all: the repository decides.
  expect(automationMatchesRepository(automation("legacy", { repos: ["acme/api:main"] }), "acme/api")).toBe(true);
});

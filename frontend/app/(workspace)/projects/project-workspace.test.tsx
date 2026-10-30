import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { projectData } from "./project-data";
import { ProjectWorkspace } from "./project-workspace";

test("a GitLab project joins its automation, task, run, and merge request with scoped actions", () => {
  const repo = "gitlab.com/group/sub/repo";
  const time = "2026-10-30T00:00:00.000Z";
  const data = projectData(repo, {
    runs: { runs: [{ id: "run-1", prompt: "Review", model: "mock", engine: "mock", status: "running", summary: null,
      duration_ms: null, project_id: null, repo, repos: [repo], repo_specs: [{ repo, branch: null }], connector: null,
      created_at: time, updated_at: time, latest_run_id: "run-1", latest_status: "running", latest_created_at: time,
      latest_updated_at: time, automation: { id: "a", name: "Check catalog", trigger: "cron" } }] },
    automations: { automations: [
      { id: "a", name: "Check catalog", repos: [`${repo}:main`], enabled: true, cron: "0 9 * * *" },
      { id: "b", name: "Different repo", repos: ["team/other"], enabled: true, cron: "0 9 * * *" },
    ] },
    tasks: { tasks: [{ id: "t", title: "Fix latency", status: "todo" }] },
    requests: { provider: "gitlab", truncated: false, requests: [{ number: 3, title: "Speed up tests", draft: false,
      url: "https://gitlab.com/group/sub/repo/-/merge_requests/3", updated_at: time }] },
  });
  const html = renderToStaticMarkup(<ProjectWorkspace repository={repo} data={data} />);
  expect(html).toContain("Check catalog");
  expect(html).not.toContain("Different repo");
  expect(html).toContain("Fix latency");
  expect(html).toContain("Speed up tests");
  expect(html).toContain('href="/session/run-1"');
  expect(html).toContain('href="/agent/new?repo=gitlab.com%2Fgroup%2Fsub%2Frepo"');
  expect(html).toContain("/agent/automations?repo=gitlab.com%2Fgroup%2Fsub%2Frepo&amp;new=1");
});

test("unavailable project sources are not presented as empty data", () => {
  const data = projectData("team/repo", { runs: null, automations: null, tasks: null, requests: null });
  const html = renderToStaticMarkup(<ProjectWorkspace repository="team/repo" data={data} />);
  expect(html).toContain("Activity is unavailable");
  expect(html).toContain("Automations are unavailable");
  expect(html).toContain("Tasks are unavailable");
  expect(html).toContain("Change requests are unavailable");
});

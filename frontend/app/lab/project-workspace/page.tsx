import { projectData } from "@/app/(workspace)/projects/project-data";
import { ProjectWorkspace } from "@/app/(workspace)/projects/project-workspace";

const repository = "example/service";
const now = "2026-10-30T08:00:00.000Z";
const data = projectData(repository, {
  runs: { runs: [{
    id: "fixture-run", prompt: "Refresh the provider catalog", model: "mock", engine: "mock", status: "running",
    summary: null, duration_ms: null, project_id: null, repo: repository, repos: [repository],
    repo_specs: [{ repo: repository, branch: null }], connector: null, created_at: now, updated_at: now,
    latest_run_id: "fixture-run", latest_status: "running", latest_created_at: now, latest_updated_at: now,
    automation: { id: "fixture-schedule", name: "Refresh provider catalog", trigger: "cron" },
  }] },
  automations: { automations: [{ id: "fixture-schedule", name: "Refresh provider catalog", repos: [repository],
    enabled: true, cron: "0 9 * * *" }] },
  tasks: { tasks: [{ id: "fixture-task", title: "Investigate startup latency", status: "todo" }] },
  requests: { provider: "github", truncated: false, requests: [{ number: 12, title: "Speed up startup", draft: false,
    url: "https://github.com/example/service/pull/12", updated_at: now }] },
});

export default function ProjectWorkspaceLab() {
  return <ProjectWorkspace repository={repository} data={data} />;
}

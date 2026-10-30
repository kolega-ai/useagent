import { decodeApiRunSummary, type ApiRunSummary } from "@useagent/agent-client/wire";
import type { ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import { automationMatchesRepository } from "@/app/agent/schedules/project-scope";
import type { Task } from "@/app/(library)/tasks/tasks-data";

export interface ProjectRequest {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updated_at: string;
}
export interface ProjectRequests {
  provider: "github" | "gitlab";
  requests: ProjectRequest[];
  truncated: boolean;
}
export interface ProjectData {
  runs: ApiRunSummary[] | null;
  automations: ScheduleRecord[] | null;
  tasks: Task[] | null;
  requests: ProjectRequests | null;
}

export function decodeProjectRequests(value: unknown): ProjectRequests | null {
  const result = value && typeof value === "object" ? value as Partial<ProjectRequests> : null;
  return result && (result.provider === "github" || result.provider === "gitlab") && Array.isArray(result.requests)
    ? result as ProjectRequests : null;
}

/** Keep unavailable data distinct from an empty project. */
export function projectData(repository: string, values: {
  runs: unknown; automations: unknown; tasks: unknown; requests: unknown;
}): ProjectData {
  const arrayAt = (value: unknown, key: string): unknown[] | null => {
    if (!value || typeof value !== "object") return null;
    const rows = (value as Record<string, unknown>)[key];
    return Array.isArray(rows) ? rows : null;
  };
  const runs = arrayAt(values.runs, "runs");
  const automations = arrayAt(values.automations, "automations");
  const tasks = arrayAt(values.tasks, "tasks");
  return {
    runs: runs ? runs.map(decodeApiRunSummary).filter((run): run is ApiRunSummary => run !== null) : null,
    automations: automations ? (automations as ScheduleRecord[]).filter((item) =>
      item && Array.isArray(item.repos) && automationMatchesRepository(item, repository)) : null,
    tasks: tasks as Task[] | null,
    requests: decodeProjectRequests(values.requests),
  };
}

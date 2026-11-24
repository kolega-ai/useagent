import type { ScheduleRecord } from "./schedules-data";

/** Whether an automation belongs to the project that is this repository: by
 *  its project when the server reports one, else (a backend from before
 *  projects owned automations) by the repository it works in. */
export function automationMatchesRepository(
  automation: Pick<ScheduleRecord, "repos" | "code_policy" | "project">,
  repository: string,
): boolean {
  if (automation.project !== undefined) return automation.project?.repo === repository;
  return automation.repos.some((entry) => entry.split(":", 1)[0] === repository) ||
    automation.code_policy?.repository === repository;
}

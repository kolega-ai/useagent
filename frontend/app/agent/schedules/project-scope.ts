import type { ScheduleRecord } from "./schedules-data";

/** Both stored repository refs and code policies can bind an automation. */
export function automationMatchesRepository(
  automation: Pick<ScheduleRecord, "repos" | "code_policy">,
  repository: string,
): boolean {
  return automation.repos.some((entry) => entry.split(":", 1)[0] === repository) ||
    automation.code_policy?.repository === repository;
}

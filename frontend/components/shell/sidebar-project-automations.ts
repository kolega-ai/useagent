import { automationProjectRepo, type ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import type { ProjectAutomations, ProjectThread } from "@/components/session-ui/project-thread-tree";
import { relativeTimeShort } from "@/utils/format";
import { rankSidebarAutomations } from "./sidebar-automations";

// A project's automations in the rail: one folded "Automations" row under the
// project, its most active automations beneath it. Only a run in progress, or
// the run the page is on, sits under its automation; older runs live on the
// automations page, so a project's thread list is the threads people started.

/** How many automations a project shows before "View all". */
export const VISIBLE_PROJECT_AUTOMATIONS = 4;

/** The id prefix that tells an automation row from a thread row. */
export const AUTOMATION_ROW_PREFIX = "automation:";

/** Where a project's automations are listed in full. */
export function projectAutomationsHref(repo: string): string {
  return `/agent/automations?repo=${encodeURIComponent(repo)}`;
}

/** Automations by the repository of the project they belong to. */
export function automationsByProject(automations: readonly ScheduleRecord[]): Map<string, ScheduleRecord[]> {
  const byRepo = new Map<string, ScheduleRecord[]>();
  for (const automation of automations) {
    const repo = automationProjectRepo(automation);
    if (!repo) continue;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), automation]);
  }
  return byRepo;
}

const live = (status: string) => status === "running" || status === "queued";

/** The Automations row of one project, or undefined when it has none. */
export function projectAutomationBranch(
  automations: readonly ScheduleRecord[] | undefined,
  repo: string,
  pathname: string | null,
): ProjectAutomations | undefined {
  if (!automations?.length) return undefined;
  const rows = rankSidebarAutomations(automations).slice(0, VISIBLE_PROJECT_AUTOMATIONS).map((automation): ProjectThread => {
    const firings = automation.recent_firings ?? [];
    const latest = firings[0];
    const shown = firings.filter((firing) => live(firing.run_status) || pathname === `/session/${firing.run_id}`);
    return {
      id: `${AUTOMATION_ROW_PREFIX}${automation.id}`,
      label: automation.name,
      time: !automation.enabled ? "Paused" : latest ? relativeTimeShort(latest.fired_at) : "",
      // A run that needs attention shows its status; otherwise a calendar mark.
      status: latest?.run_status ?? "completed",
      kind: "automation",
      children: shown.map((firing) => ({
        id: firing.run_id,
        label: firing.trigger === "manual" ? "Manual run" : "Scheduled run",
        time: relativeTimeShort(firing.fired_at),
        status: firing.run_status,
        isSelected: pathname === `/session/${firing.run_id}`,
      })),
    };
  });
  return { rows, total: automations.length, href: projectAutomationsHref(repo) };
}

/** Where a row of the project tree goes: a thread opens itself, an automation its project's list. */
export function projectTreeHref(id: string, automationRepos: ReadonlyMap<string, string>): string {
  if (!id.startsWith(AUTOMATION_ROW_PREFIX)) return `/session/${id}`;
  const repo = automationRepos.get(id.slice(AUTOMATION_ROW_PREFIX.length));
  return repo ? projectAutomationsHref(repo) : "/agent/automations";
}

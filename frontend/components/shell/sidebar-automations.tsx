"use client";

// Automation data for the rail. The project tree nests each project's
// automations (sidebar-project-automations.ts); the folded rail links their latest runs.
import { RiCalendarScheduleLine } from "@remixicon/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { fetchSchedules } from "@/app/agent/schedules/schedules-api";
import type { ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import { useAutomationRecovery } from "@/app/agent/schedules/use-automation-recovery";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar-kit/sidebar";
import { StatusDot } from "@/components/shared/status-dot";
import { useOrgChanges } from "@/hooks/use-org-changes";
import type { OrgChange } from "@/lib/org-changes";
import { threadStatusPresentation } from "./thread-discovery";

const VISIBLE_AUTOMATIONS = 6;

export type SidebarAutomation = Pick<ScheduleRecord,
  "id" | "name" | "created_at" | "last_run_at" | "recent_firings">;

export function refreshesSidebarAutomations(change: OrgChange): boolean {
  return change.type === "automation" || change.type === "run";
}

/** Active work first, then the latest firing, without inventing a run for an empty job. */
export function rankSidebarAutomations<T extends SidebarAutomation>(automations: readonly T[]): T[] {
  const active = (item: SidebarAutomation) => item.recent_firings?.some(
    (firing) => firing.run_status === "running" || firing.run_status === "queued",
  ) ?? false;
  return [...automations].sort((a, b) =>
    Number(active(b)) - Number(active(a)) ||
    Date.parse(b.last_run_at ?? b.created_at) - Date.parse(a.last_run_at ?? a.created_at) ||
    a.id.localeCompare(b.id),
  );
}

/** The workspace's automations for the rail, refreshed on their own and run
 *  lifecycle events: the project tree nests them under their projects. */
export function useSidebarAutomations() {
  const [automations, setAutomations] = useState<ScheduleRecord[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const requestSequence = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    try {
      const next = await fetchSchedules(signal);
      if (!signal?.aborted && sequence === requestSequence.current) {
        setAutomations(next);
        setUnavailable(false);
      }
    } catch {
      if (!signal?.aborted && sequence === requestSequence.current) setUnavailable(true);
    }
  }, []);
  useAutomationRecovery(load);
  useOrgChanges((change) => {
    if (refreshesSidebarAutomations(change)) void load();
  }, () => void load());
  return { automations, unavailable };
}

/** Compact rail links to the latest or open run for each visible automation. */
export function CollapsedAutomationRuns({ automations, pathname }: {
  automations: readonly SidebarAutomation[];
  pathname: string | null;
}) {
  const entries = rankSidebarAutomations(automations).flatMap((automation) => {
    const firing = automation.recent_firings?.find((item) => pathname === `/session/${item.run_id}`) ?? automation.recent_firings?.[0];
    return firing ? [{ automation, firing }] : [];
  }).slice(0, VISIBLE_AUTOMATIONS);
  if (!entries.length) return null;
  return <SidebarGroup className="items-center p-0 pt-2" aria-label="Automation runs">
    <SidebarMenu className="items-center gap-1">
      {entries.map(({ automation, firing }) => {
        const href = `/session/${firing.run_id}`;
        const status = threadStatusPresentation(firing.run_status);
        const label = `${automation.name}, ${status.label}`;
        return <SidebarMenuItem key={automation.id} className="w-8">
          <SidebarMenuButton
            className="justify-center rounded-2lg text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary"
            isActive={pathname === href}
            render={<Link href={href} aria-label={label} aria-current={pathname === href ? "page" : undefined} />}
            tooltip={label}
          >
            <span className="relative flex size-4 items-center justify-center">
              <RiCalendarScheduleLine className="size-4" aria-hidden />
              {status.dot ? <span className="absolute -right-1 -bottom-1"><StatusDot {...status.dot} /></span> : null}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>;
      })}
    </SidebarMenu>
  </SidebarGroup>;
}

export function CollapsedSidebarAutomations() {
  const pathname = usePathname();
  const { automations } = useSidebarAutomations();
  return <CollapsedAutomationRuns automations={automations} pathname={pathname} />;
}

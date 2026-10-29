"use client";

// The automation rail reuses the shared section and thread-row treatments.
import { RiArrowDownSLine, RiCalendarScheduleLine, RiCheckLine } from "@remixicon/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { fetchSchedules } from "@/app/agent/schedules/schedules-api";
import type { ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import { useAutomationRecovery } from "@/app/agent/schedules/use-automation-recovery";
import { ProjectThreadList, type ProjectThread } from "@/components/session-ui/project-thread-tree";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar-kit/sidebar";
import { StatusDot } from "@/components/shared/status-dot";
import { useOrgChanges } from "@/hooks/use-org-changes";
import type { OrgChange } from "@/lib/org-changes";
import { cx } from "@/utils/cx";
import { relativeTimeShort } from "@/utils/format";
import { SidebarSectionToggle } from "./sidebar-nav";
import { threadStatusPresentation } from "./thread-discovery";

const VISIBLE_AUTOMATIONS = 6;

export type SidebarAutomation = Pick<ScheduleRecord,
  "id" | "name" | "created_at" | "last_run_at" | "recent_firings">;

export function refreshesSidebarAutomations(change: OrgChange): boolean {
  return change.type === "automation" || change.type === "run";
}

/** Active work first, then the latest firing, without inventing a run for an empty job. */
export function rankSidebarAutomations(automations: readonly SidebarAutomation[]): SidebarAutomation[] {
  const active = (item: SidebarAutomation) => item.recent_firings?.some(
    (firing) => firing.run_status === "running" || firing.run_status === "queued",
  ) ?? false;
  return [...automations].sort((a, b) =>
    Number(active(b)) - Number(active(a)) ||
    Date.parse(b.last_run_at ?? b.created_at) - Date.parse(a.last_run_at ?? a.created_at) ||
    a.id.localeCompare(b.id),
  );
}

/** The rail's real-shaped view, also used by the lab and rendering tests. */
export function AutomationSidebarSection({
  automations,
  pathname,
  unavailable = false,
}: {
  automations: readonly SidebarAutomation[];
  pathname: string | null;
  unavailable?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const ranked = useMemo(() => rankSidebarAutomations(automations), [automations]);
  const shown = ranked.slice(0, VISIBLE_AUTOMATIONS);

  return (
    <section aria-label="Automations" data-testid="sidebar-automations">
      <SidebarSectionToggle open={open} onToggle={() => setOpen((value) => !value)} controls="sidebar-automations-section">
        Automations
      </SidebarSectionToggle>
      {open ? <div id="sidebar-automations-section">
        {shown.map((automation, index) => {
          const firings = automation.recent_firings;
          const hasActive = firings?.some((firing) => firing.run_status === "running" || firing.run_status === "queued") ?? false;
          const containsCurrent = firings?.some((firing) => pathname === `/session/${firing.run_id}`) ?? false;
          const expanded = overrides[automation.id] ?? (index === 0 || hasActive || containsCurrent);
          const status = firings?.[0] ? threadStatusPresentation(firings[0].run_status) : null;
          const threads: ProjectThread[] = (firings ?? []).map((firing) => ({
            id: firing.run_id,
            label: firing.trigger === "manual" ? "Manual run" : "Scheduled run",
            time: relativeTimeShort(firing.fired_at),
            status: firing.run_status,
            isSelected: pathname === `/session/${firing.run_id}`,
          }));
          return <div key={automation.id}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOverrides((current) => ({ ...current, [automation.id]: !expanded }))}
              className="flex w-full min-w-0 items-center gap-2 rounded-2lg px-2.5 py-1.5 text-left text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiCalendarScheduleLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-body-2-medium">{automation.name}</span>
              {status?.dot ? <span role="img" aria-label={status.label} title={status.label}><StatusDot {...status.dot} /></span> :
                status?.label === "Completed" ? <RiCheckLine className="size-3.5 shrink-0 text-lime-600" aria-label="Completed" /> : null}
              <RiArrowDownSLine className={cx("size-3.5 shrink-0", !expanded && "-rotate-90")} aria-hidden />
            </button>
            {expanded && threads.length > 0 ? <ProjectThreadList
              ariaLabel={`Runs for ${automation.name}`}
              threads={threads}
              threadHref={(thread) => `/session/${thread.id}`}
            /> : null}
            {expanded && threads.length === 0 ? <p className="px-6 py-1 text-caption-1-regular text-text-tertiary">
              {firings === undefined ? "Open automations to view runs" : "No runs yet"}
            </p> : null}
          </div>;
        })}
        {unavailable && automations.length === 0 ? <p className="px-2.5 py-1 text-caption-1-regular text-text-tertiary">Couldn&apos;t load automations</p> : null}
        <Link href="/agent/automations" className="block rounded-lg px-2.5 py-1 text-caption-1-regular text-text-tertiary hover:bg-background-secondary-hover hover:text-text-primary">
          {ranked.length > VISIBLE_AUTOMATIONS ? `View all ${ranked.length} automations` : "Manage automations"}
        </Link>
      </div> : null}
    </section>
  );
}

/** Refresh the existing automation list on its own and run lifecycle events. */
function useSidebarAutomationData() {
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

export function SidebarAutomations() {
  const pathname = usePathname();
  const { automations, unavailable } = useSidebarAutomationData();
  return <AutomationSidebarSection automations={automations} pathname={pathname} unavailable={unavailable} />;
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
  const { automations } = useSidebarAutomationData();
  return <CollapsedAutomationRuns automations={automations} pathname={pathname} />;
}

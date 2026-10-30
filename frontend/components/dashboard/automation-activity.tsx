import Link from "next/link";
import type { ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import { StatusDot } from "@/components/shared/status-dot";
import { relativeTimeShort } from "@/utils/format";
import { Card } from "./card";

export function AutomationActivity({ automations }: { automations: readonly ScheduleRecord[] | null }) {
  const activeCount = automations?.filter((item) => item.enabled).length ?? 0;
  const firings = (automations ?? []).flatMap((automation) => (automation.recent_firings ?? []).map((firing) => ({
    ...firing, name: automation.name,
  }))).toSorted((a, b) => {
    const active = (status: string) => status === "running" || status === "queued" ? 1 : 0;
    return active(b.run_status) - active(a.run_status) || Date.parse(b.fired_at) - Date.parse(a.fired_at);
  }).slice(0, 5);
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-body-medium text-text-primary">Automations</h2>
          <p className="text-caption-1-regular text-text-secondary">
            {automations ? `${activeCount} active ${activeCount === 1 ? "automation" : "automations"}` : "Automations are unavailable."}
          </p>
        </div>
        <Link href="/agent/automations" className="text-body-2-medium text-text-secondary hover:text-text-primary">View all</Link>
      </div>
      {automations && firings.length === 0 ? <p className="mt-3 text-body-2-regular text-text-tertiary">No automation runs yet.</p> : null}
      {firings.length > 0 ? <div className="mt-3 flex flex-col gap-1">
        {firings.map((firing) => <Link key={firing.run_id} href={`/session/${firing.run_id}`}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-background-secondary-hover">
          <StatusDot tone={firing.run_status === "failed" ? "error" : firing.run_status === "completed" ? "success" : "away"} />
          <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">{firing.name}</span>
          <span className="text-caption-1-regular text-text-secondary">{firing.run_status}</span>
          <span className="text-caption-1-regular text-text-tertiary">{relativeTimeShort(firing.fired_at)}</span>
        </Link>)}
      </div> : null}
    </Card>
  );
}

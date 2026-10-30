import Link from "next/link";
import { runTitle } from "@/components/chat/types";
import { type DotTone, StatusDot } from "@/components/shared/status-dot";
import { threadActivityTimestamp } from "@/components/shell/thread-discovery";
import { relativeTimeShort } from "@/utils/format";

export interface RecentRun {
  id: string;
  prompt: string;
  status: string;
  latest_status?: string;
  automation?: { name: string | null };
  created_at: string;
  updated_at: string;
  latest_created_at?: string;
  latest_updated_at?: string;
}

const STATUS_DOT: Record<string, DotTone> = {
  completed: "success", running: "away", queued: "away", failed: "error",
};

export function RecentTasks({ runs }: { runs: RecentRun[] }) {
  return <section className="mt-8">
    <h2 className="text-mono-label px-1 text-text-tertiary">Recent tasks</h2>
    <div className="mt-2 flex flex-col gap-1">
      {runs.map((run) => <Link key={run.id} href={`/session/${run.id}`}
        className="flex items-center gap-2.5 rounded-xl border border-border-button-default bg-background-primary-default px-3 py-2 outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring">
        <StatusDot tone={STATUS_DOT[run.latest_status ?? run.status] ?? "info"} />
        <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">{run.automation?.name || runTitle(run.prompt)}</span>
        {run.automation ? <span className="shrink-0 text-caption-1-regular text-text-secondary">Automation</span> : null}
        <span className="shrink-0 text-caption-1-regular tabular-nums text-text-tertiary">{relativeTimeShort(threadActivityTimestamp(run))}</span>
      </Link>)}
    </div>
  </section>;
}

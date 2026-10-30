import Link from "next/link";
import type { ReactNode } from "react";
import { RiAddLine, RiCalendarScheduleLine, RiExternalLinkLine } from "@remixicon/react";
import { ButtonLink } from "@/components/base/buttons/button";
import { runTitle } from "@/components/chat/types";
import { Card } from "@/components/dashboard/card";
import { StatusDot } from "@/components/shared/status-dot";
import { cadenceLabel } from "@/app/agent/schedules/schedules-data";
import { relativeTimeShort } from "@/utils/format";
import { repositoryWebUrl } from "@/lib/project-links";
import type { ProjectData, ProjectRequests } from "./project-data";

const row = "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-background-secondary-hover";
const item = "min-w-0 flex-1 truncate text-body-2-medium text-text-primary";
const note = "shrink-0 text-caption-1-regular text-text-secondary";

function Section({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
  return <Card>
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-body-medium text-text-primary">{title}</h2>
      {href ? <Link href={href} className="text-body-2-medium text-text-secondary hover:text-text-primary">View all</Link> : null}
    </div>
    {children}
  </Card>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-body-2-regular text-text-tertiary">{children}</p>;
}

export function ProjectRequestsPanel({ repository, requests, loading = false }: {
  repository: string; requests: ProjectRequests | null; loading?: boolean;
}) {
  return <Section title={repository.startsWith("gitlab.com/") ? "Merge requests" : "Pull requests"}>
    {loading ? <Empty>Loading change requests…</Empty> : requests === null ? <Empty>Change requests are unavailable. Check the repository connection and refresh.</Empty> :
      requests.requests.length === 0 ? <Empty>No open change requests.</Empty> : <>
        {requests.requests.slice(0, 8).map((request) => <a key={request.number} href={request.url} target="_blank" rel="noreferrer" className={row}>
          <span className={item}>#{request.number} {request.title}</span>
          {request.draft ? <span className={note}>Draft</span> : null}
        </a>)}
        {requests.truncated || requests.requests.length > 8 ? <p className="px-2 py-1 text-caption-1-regular text-text-tertiary">More change requests are available in the repository.</p> : null}
      </>}
  </Section>;
}

export function ProjectWorkspace({ repository, data, requestsView }: {
  repository: string; data: ProjectData; requestsView?: ReactNode;
}) {
  const encoded = encodeURIComponent(repository);
  const automationHref = `/agent/automations?repo=${encoded}`;
  const tasksHref = `/tasks?project=${encoded}`;
  const source = repositoryWebUrl(repository);
  return <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-6 py-8 sm:px-10 sm:py-10">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-mono-label text-text-tertiary">Project</p>
        <h1 className="break-all text-title-2-medium text-text-primary">{repository}</h1>
        {source ? <a href={source} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-body-2-regular text-text-secondary hover:text-text-primary">
          Open repository <RiExternalLinkLine className="size-3.5" aria-hidden />
        </a> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`/agent/new?repo=${encoded}`} variant="primary" size="small" leadingIcon={RiAddLine}>New thread</ButtonLink>
        <ButtonLink href={`${automationHref}&new=1`} variant="secondary" size="small" leadingIcon={RiCalendarScheduleLine}>New automation</ButtonLink>
      </div>
    </header>

    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Recent activity" href={`/agent/runs?repo=${encoded}`}>
        {data.runs === null ? <Empty>Activity is unavailable. Refresh to try again.</Empty> : data.runs.length === 0 ? <Empty>No threads or automation runs yet.</Empty> :
          data.runs.slice(0, 12).map((run) => <Link key={run.id} href={`/session/${run.id}`} className={row}>
            <StatusDot tone={run.latest_status === "failed" ? "error" : run.latest_status === "completed" ? "success" : "away"} />
            <span className={item}>{run.automation?.name || runTitle(run.prompt)}</span>
            {run.automation ? <span className={note}>Automation</span> : null}
            <span className={note}>{run.latest_status}</span>
            <span className={note}>{relativeTimeShort(run.latest_updated_at)}</span>
          </Link>)}
      </Section>
      <Section title="Automations" href={automationHref}>
        {data.automations === null ? <Empty>Automations are unavailable. Refresh to try again.</Empty> : data.automations.length === 0 ? <Empty>No automations for this project.</Empty> :
          data.automations.slice(0, 12).map((automation) => <Link key={automation.id} href={automationHref} className={row}>
            <span className={item}>{automation.name}</span>
            <span className={note}>{automation.enabled ? cadenceLabel(automation.cron) : "Paused"}</span>
          </Link>)}
      </Section>
      <Section title="Tasks" href={tasksHref}>
        {data.tasks === null ? <Empty>Tasks are unavailable. Refresh to try again.</Empty> : data.tasks.length === 0 ? <Empty>No tasks for this project.</Empty> :
          data.tasks.slice(0, 8).map((task) => <Link key={task.id} href={tasksHref} className={row}>
            <span className={item}>{task.title}</span><span className={note}>{task.status.replaceAll("_", " ")}</span>
          </Link>)}
      </Section>
      {requestsView ?? <ProjectRequestsPanel repository={repository} requests={data.requests} />}
    </div>
  </div>;
}

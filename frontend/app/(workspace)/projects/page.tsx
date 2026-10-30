import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardLiveRefresh } from "@/components/dashboard/dashboard-live-refresh";
import { backendFetch } from "@/lib/backend-fetch";
import { repositoryWebUrl } from "@/lib/project-links";
import { decodeProjectRequests, projectData } from "./project-data";
import { ProjectRequestsPanel, ProjectWorkspace } from "./project-workspace";

export const metadata: Metadata = { title: "Project - UseAgent" };
export const dynamic = "force-dynamic";

async function read(path: string): Promise<unknown> {
  try {
    const response = await backendFetch(path, { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function Requests({ repository, result }: { repository: string; result: Promise<unknown> }) {
  return <ProjectRequestsPanel repository={repository} requests={decodeProjectRequests(await result)} />;
}

export default async function ProjectPage({ searchParams }: {
  searchParams: Promise<{ repo?: string | string[] }>;
}) {
  const raw = (await searchParams).repo;
  const repository = typeof raw === "string" ? raw.trim() : "";
  if (!repositoryWebUrl(repository)) return <div className="p-8 text-body-2-regular text-text-secondary">Select a project from the sidebar.</div>;
  const encoded = encodeURIComponent(repository);
  const requestResult = read(`/api/projects/repository-requests?repo=${encoded}`);
  const [runs, automations, tasks] = await Promise.all([
    read(`/api/runs?view=summary&limit=100&include_active=1&repo=${encoded}`),
    read("/api/automations"),
    read(`/api/tasks?project=${encoded}`),
  ]);
  return <><DashboardLiveRefresh /><ProjectWorkspace repository={repository}
    data={projectData(repository, { runs, automations, tasks, requests: null })}
    requestsView={<Suspense fallback={<ProjectRequestsPanel repository={repository} requests={null} loading />}>
      <Requests repository={repository} result={requestResult} />
    </Suspense>} /></>;
}

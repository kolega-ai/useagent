import type { Metadata } from "next";
import { backendFetch } from "@/lib/backend-fetch";
import { FirstRunNotice } from "./first-run-notice";
import { NewTaskComposer } from "./new-task-composer";
import { fetchSkills } from "./skills-data";
import { TourLauncher } from "./tour-launcher";
import { RecentTasks, type RecentRun } from "./recent-tasks";

export const metadata: Metadata = {
  title: "New thread",
  description: "Start a direct conversation or a sandbox-backed task with UseAgent.",
};

/** Recent product threads, including automation firings. Null on any
 * failure so the section simply doesn't render (never a broken card), and an
 * unanswered list is never read as "this person has no threads yet". */
async function fetchRecentRuns(): Promise<RecentRun[] | null> {
  try {
    const res = await backendFetch("/api/runs?view=summary&limit=5&include_active=1", { cache: "no-store" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const runs = Array.isArray(data)
      ? (data as RecentRun[])
      : Array.isArray((data as { runs?: RecentRun[] })?.runs)
        ? (data as { runs: RecentRun[] }).runs
        : null;
    return runs;
  } catch {
    return null;
  }
}

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string | string[]; prompt?: string | string[] }>;
}) {
  const params = await searchParams;
  const requestedRepo = params.repo;
  const initialRepository = typeof requestedRepo === "string" ? requestedRepo : null;
  // Deep-link prefill: surfaces like "Discuss PR" open the composer with the
  // prompt already drafted (e.g. the repo + PR number the agent should read).
  const initialPrompt = typeof params.prompt === "string" ? params.prompt : "";
  const [skills, recentRuns] = await Promise.all([fetchSkills(), fetchRecentRuns()]);

  return (
    <div className="flex min-h-full flex-col items-center px-4 sm:px-6">
        <div className="w-full max-w-3xl py-10 sm:py-14">
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-mono-label text-text-tertiary">New thread</p>
            <h1 className="text-display-xs text-text-primary">What do you want done?</h1>
          </div>

          <div className="mt-8">
            <FirstRunNotice />
            <NewTaskComposer
              skills={skills}
              initialRepository={initialRepository}
              initialPrompt={initialPrompt}
            />
          </div>

          {recentRuns && recentRuns.length > 0 ? <RecentTasks runs={recentRuns} /> : null}
          <TourLauncher newUser={recentRuns?.length === 0} />
        </div>
      </div>
  );
}

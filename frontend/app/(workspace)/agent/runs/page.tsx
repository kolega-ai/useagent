import type { Metadata } from "next";
import { fetchRuns, type Run } from "./runs-data";
import { RunsList } from "./runs-list";

export const metadata: Metadata = {
  title: "All threads",
  description: "Live agent runs from the UseAgent orchestrator.",
};

// Always render fresh — the runs list is live data.
export const dynamic = "force-dynamic";

export default async function AgentRunsPage({ searchParams }: {
  searchParams: Promise<{ repo?: string | string[] }>;
}) {
  const repo = (await searchParams).repo;
  const repository = typeof repo === "string" && repo.length <= 512 ? repo : null;
  let initialRuns: Run[] = [];
  let initialError = false;

  try {
    initialRuns = await fetchRuns(undefined, repository);
  } catch {
    initialError = true;
  }

  return (
    <RunsList key={repository ?? "all"} initialRuns={initialRuns} initialError={initialError} repository={repository} />
  );
}

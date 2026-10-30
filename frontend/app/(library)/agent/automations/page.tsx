import type { Metadata } from "next";
import { AutomationsView } from "@/app/agent/schedules/automations-view";

export const metadata: Metadata = {
  title: "Automations",
  description: "Recurring and triggered runs UseAgent starts on its own.",
};

export default async function AutomationsPage({ searchParams }: {
  searchParams: Promise<{ repo?: string | string[]; new?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <AutomationsView repository={typeof params.repo === "string" ? params.repo : null} createOnLoad={params.new === "1"} />
  );
}

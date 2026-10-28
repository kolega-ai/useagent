"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { backendFetch } from "@/lib/backend-fetch";
import { loadRepoList, type RepoListEntry } from "@/lib/repo-list";
import { SettingsCard } from "./settings-rows";

type Project = { id: string; repo_full_name: string | null; daytona_snapshot: string | null };

/** Repository images affect future threads only; the backend pins each thread's choice. */
export function RepositorySnapshots() {
  const [repos, setRepos] = useState<RepoListEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadRepoList(),
      backendFetch("/api/projects?scope=all&limit=500", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("projects unavailable");
        return await response.json() as { projects: Project[] };
      }),
    ]).then(([available, result]) => {
      if (!active) return;
      setRepos(available);
      setProjects(result.projects);
      setDrafts(Object.fromEntries(result.projects.flatMap((project) =>
        project.repo_full_name ? [[project.repo_full_name, project.daytona_snapshot ?? ""]] : [],
      )));
      setLoaded(true);
    }).catch(() => { if (active) setError("Couldn't load repositories. Try reloading settings."); });
    return () => { active = false; };
  }, []);

  async function save(repo: string) {
    const snapshot = (drafts[repo] ?? "").trim();
    setBusy(repo);
    setError(null);
    try {
      let project = projects.find((item) => item.repo_full_name === repo);
      if (!project) {
        const response = await backendFetch("/api/projects", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: repo, repo_full_name: repo }),
        });
        if (!response.ok) throw new Error("project creation failed");
        project = await response.json() as Project;
      }
      const response = await backendFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daytona_snapshot: snapshot || null }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || "Couldn't save snapshot.");
      }
      const updated = await response.json() as Project;
      setProjects((current) => [...current.filter((item) => item.id !== updated.id), updated]);
      setDrafts((current) => ({ ...current, [repo]: updated.daytona_snapshot ?? "" }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save snapshot.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsCard>
      <div className="py-3">
        <p className="text-body-2-medium text-text-primary">Repository snapshots</p>
        <p className="text-caption-1-regular text-text-tertiary">
          Optional Daytona images for new threads. The first selected repository determines the image.
          Leave blank to use the default. The selected Daytona account checks the image when a thread starts.
          Existing threads keep their workspace.
        </p>
      </div>
      {error && <p role="alert" className="py-2 text-caption-1-regular text-text-secondary">{error}</p>}
      {loaded && repos.length === 0 && <p className="py-3 text-caption-1-regular text-text-tertiary">No repositories available.</p>}
      {repos.map((repo) => {
        const value = drafts[repo.full_name] ?? "";
        const saved = projects.find((item) => item.repo_full_name === repo.full_name)?.daytona_snapshot ?? "";
        return (
          <div key={repo.full_name} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <label htmlFor={`snapshot-${repo.full_name}`} className="text-body-2-medium text-text-primary">{repo.full_name}</label>
            <div className="flex min-w-0 items-center gap-2">
              <InputBase fieldClassName="min-w-0 sm:w-72" id={`snapshot-${repo.full_name}`} aria-label={`Daytona snapshot for ${repo.full_name}`}
                placeholder="Default snapshot" value={value} onChange={(event) => setDrafts((current) => ({ ...current, [repo.full_name]: event.target.value }))} />
              <Button type="button" variant="secondary" size="small" disabled={busy !== null || value.trim() === saved}
                onClick={() => void save(repo.full_name)}>{busy === repo.full_name ? "Saving" : "Save"}</Button>
            </div>
          </div>
        );
      })}
    </SettingsCard>
  );
}

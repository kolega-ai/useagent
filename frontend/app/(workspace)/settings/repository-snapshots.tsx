"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { backendFetch } from "@/lib/backend-fetch";
import { loadRepoList, type RepoListEntry } from "@/lib/repo-list";
import { SettingsCard } from "./settings-rows";

const imageFields = [
  { key: "daytona_snapshot", label: "Daytona snapshot", placeholder: "Default snapshot" },
  { key: "cube_snapshot", label: "Cube template", placeholder: "Default template" },
  { key: "box_snapshot", label: "Box snapshot", placeholder: "Default snapshot" },
  { key: "e2b_template", label: "E2B template", placeholder: "Default template" },
  { key: "local_image", label: "Local image", placeholder: "Image reference@sha256:digest" },
] as const;
type ImageField = (typeof imageFields)[number]["key"];
type Project = { id: string; repo_full_name: string | null } & Record<ImageField, string | null>;
type Drafts = Record<string, Partial<Record<ImageField, string>>>;

/** Repository images affect future threads only; the backend pins each thread's choice. */
export function RepositorySnapshots() {
  const [repos, setRepos] = useState<RepoListEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [drafts, setDrafts] = useState<Drafts>({});
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
        project.repo_full_name ? [[project.repo_full_name, Object.fromEntries(imageFields.map(({ key }) => [key, project[key] ?? ""]))]] : [],
      )));
      setLoaded(true);
    }).catch(() => { if (active) setError("Couldn't load repositories. Try reloading settings."); });
    return () => { active = false; };
  }, []);

  async function save(repo: string, field: ImageField) {
    const image = (drafts[repo]?.[field] ?? "").trim();
    const busyKey = `${repo}:${field}`;
    setBusy(busyKey);
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
        body: JSON.stringify({ [field]: image || null }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || "Couldn't save image.");
      }
      const updated = await response.json() as Project;
      setProjects((current) => [...current.filter((item) => item.id !== updated.id), updated]);
      setDrafts((current) => ({ ...current, [repo]: { ...current[repo], [field]: updated[field] ?? "" } }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save image.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsCard>
      <div className="py-3">
        <p className="text-body-2-medium text-text-primary">Repository images</p>
        <p className="text-caption-1-regular text-text-tertiary">
          Set an optional image for each provider. The first selected repository determines the image for a new thread.
          Leave a field blank to use that provider's default. Local images must include a sha256 digest.
          Existing threads keep their workspace.
        </p>
      </div>
      {error && <p role="alert" className="py-2 text-caption-1-regular text-text-secondary">{error}</p>}
      {loaded && repos.length === 0 && <p className="py-3 text-caption-1-regular text-text-tertiary">No repositories available.</p>}
      {repos.map((repo) => (
        <details key={repo.full_name} className="py-3">
          <summary className="cursor-pointer text-body-2-medium text-text-primary">{repo.full_name}</summary>
          <div className="flex flex-col gap-2 pt-2">
          {imageFields.map(({ key, label, placeholder }) => {
            const value = drafts[repo.full_name]?.[key] ?? "";
            const saved = projects.find((item) => item.repo_full_name === repo.full_name)?.[key] ?? "";
            const busyKey = `${repo.full_name}:${key}`;
            return (
              <div key={key} className="flex min-w-0 flex-wrap items-center gap-2">
                <label htmlFor={`image-${key}-${repo.full_name}`} className="text-caption-1-regular text-text-secondary">{label}</label>
                <InputBase fieldClassName="min-w-0 sm:w-72" id={`image-${key}-${repo.full_name}`} aria-label={`${label} for ${repo.full_name}`}
                  placeholder={placeholder} value={value} onChange={(event) => setDrafts((current) => ({ ...current, [repo.full_name]: { ...current[repo.full_name], [key]: event.target.value } }))} />
                <Button type="button" variant="secondary" size="small" disabled={busy !== null || value.trim() === saved}
                  onClick={() => void save(repo.full_name, key)}>{busy === busyKey ? "Saving" : "Save"}</Button>
              </div>
            );
          })}
          </div>
        </details>
      ))}
    </SettingsCard>
  );
}

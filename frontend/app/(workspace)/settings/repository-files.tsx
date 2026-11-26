"use client";

import { useEffect, useRef, useState } from "react";
import { RepoMultiPicker, type RepoItem } from "@/app/(workspace)/agent/new/repo-multi-picker";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { Select, SelectItem } from "@/components/base/select/select";
import { backendFetch } from "@/lib/backend-fetch";
import { loadRepoList } from "@/lib/repo-list";
import { loadRepositoryFileProjects, loadStoredFiles, saveRepositoryFiles, uploadStoredFile,
  type RepositoryFile, type RepositoryFileProject, type StoredFile } from "@/lib/repository-files";
import { SettingsCard } from "./settings-rows";

/** Each stored file's repositories, sorted; a file no repository receives is absent. */
export function repositoriesUsingFiles(projects: readonly RepositoryFileProject[]): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.repo_full_name) continue;
    for (const file of project.workspace_files ?? []) {
      const repos = usage.get(file.name) ?? [];
      if (!repos.includes(project.repo_full_name)) repos.push(project.repo_full_name);
      usage.set(file.name, repos);
    }
  }
  for (const repos of usage.values()) repos.sort();
  return usage;
}

/** Every repository that receives at least one file, sorted, with its files. */
export function repositoriesWithFiles(projects: readonly RepositoryFileProject[]): { repo: string; files: RepositoryFile[] }[] {
  return projects
    .filter((project): project is RepositoryFileProject & { repo_full_name: string } =>
      Boolean(project.repo_full_name) && (project.workspace_files?.length ?? 0) > 0)
    .map((project) => ({ repo: project.repo_full_name, files: project.workspace_files ?? [] }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

export interface RepositoryFilesPanelProps {
  stored: readonly StoredFile[];
  projects: readonly RepositoryFileProject[];
  repos: RepoItem[];
  busy: boolean;
  error: string | null;
  /** Resolves true once the file is stored. */
  onStore: (name: string, file: File) => Promise<boolean>;
  onSaveMapping: (repo: string, files: RepositoryFile[]) => Promise<void>;
  onRemoveStored: (name: string) => Promise<void>;
  onDiscover: (repo: RepoItem) => void;
}

/** Stored files with the repositories that use them, every repository's files, and the form to add one. */
export function RepositoryFilesPanel({ stored, projects, repos, busy, error, onStore, onSaveMapping, onRemoveStored, onDiscover }: RepositoryFilesPanelProps) {
  const [repo, setRepo] = useState("");
  const [fileName, setFileName] = useState("");
  const [upload, setUpload] = useState<File | null>(null);
  const [selected, setSelected] = useState("");
  const [path, setPath] = useState(".env");
  const input = useRef<HTMLInputElement>(null);
  const usage = repositoriesUsingFiles(projects);
  const mapped = repositoriesWithFiles(projects);
  const mapping = projects.find((project) => project.repo_full_name === repo)?.workspace_files ?? [];

  async function store() {
    if (!upload) return;
    const name = fileName.trim();
    if (!(await onStore(name, upload))) return;
    setSelected(name); setFileName(""); setUpload(null);
    if (input.current) input.current.value = "";
  }

  async function removeStored(name: string) {
    await onRemoveStored(name);
    if (selected === name) setSelected("");
  }

  return (
    <SettingsCard>
      <div className="py-3">
        <p className="text-body-2-medium text-text-primary">Repository files</p>
        <p className="text-caption-1-regular text-text-tertiary">Store a file encrypted, then choose where it goes after a repository is prepared. New tasks receive the configured files; automations select the files they need.</p>
      </div>
      <div className="flex flex-col gap-2 py-3">
        <p className="text-caption-1-medium text-text-secondary">Store or replace a file</p>
        <div className="flex flex-wrap items-center gap-2">
          <InputBase aria-label="Stored file name" placeholder="FILE_NAME" value={fileName} onChange={(event) => setFileName(event.target.value.toUpperCase())} />
          <input ref={input} type="file" className="sr-only" aria-label="Choose a file to store" onChange={(event) => setUpload(event.target.files?.[0] ?? null)} />
          <Button type="button" variant="secondary" size="small" onClick={() => input.current?.click()}>Choose file</Button>
          <span className="text-caption-1-regular text-text-secondary">{upload?.name ?? "No file selected"}</span>
          <Button type="button" variant="secondary" size="small" disabled={busy || !upload || !/^[A-Z][A-Z0-9_]*$/.test(fileName)} onClick={() => void store()}>Store file</Button>
        </div>
        {stored.map((item) => {
          const users = usage.get(item.name) ?? [];
          return (
            <div key={item.name} className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="text-caption-1-regular text-text-secondary">{item.name}</span>
                <span className="break-all text-caption-1-regular text-text-tertiary">
                  {users.length > 0 ? `Used by ${users.join(", ")}` : "Not used by any repository"}
                </span>
              </div>
              <Button type="button" variant="ghost" size="xs" disabled={busy || users.length > 0}
                onClick={() => void removeStored(item.name)}>Remove</Button>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 py-3">
        <p className="text-caption-1-medium text-text-secondary">Files in repositories</p>
        {mapped.length === 0
          ? <p className="text-caption-1-regular text-text-tertiary">No repository receives a file yet.</p>
          : mapped.map((entry) => (
            <div key={entry.repo} className="flex flex-col gap-1">
              <p className="break-all text-caption-1-medium text-text-primary">{entry.repo}</p>
              {entry.files.map((file) => (
                <div key={file.path} className="flex items-center justify-between gap-2">
                  <span className="break-all text-caption-1-regular text-text-secondary">{file.name} → {file.path}</span>
                  <Button type="button" variant="ghost" size="xs" disabled={busy} aria-label={`Remove ${file.name} from ${entry.repo}`}
                    onClick={() => void onSaveMapping(entry.repo, entry.files.filter((item) => item.path !== file.path))}>Remove</Button>
                </div>
              ))}
            </div>
          ))}
      </div>
      <div className="flex flex-col gap-2 py-3">
        <p className="text-caption-1-medium text-text-secondary">Add a file to a repository</p>
        <RepoMultiPicker single repos={repos} value={repo ? [repo] : []} emptyLabel="Choose repository"
          onChange={(items) => setRepo(items[0] ?? "")} onDiscover={onDiscover} />
        {repo && (
          <div className="flex flex-wrap items-center gap-2">
            <Select size="sm" aria-label="Stored file" selectedKey={selected || null} onSelectionChange={(key) => setSelected(String(key))}>
              {stored.map((item) => <SelectItem key={item.name} id={item.name}>{item.name}</SelectItem>)}
            </Select>
            <InputBase aria-label="Path in repository" placeholder=".env" value={path} onChange={(event) => setPath(event.target.value)} />
            <Button type="button" variant="secondary" size="small" disabled={busy || !selected || !path.trim()}
              onClick={() => void onSaveMapping(repo, [...mapping.filter((file) => file.path !== path.trim()), { name: selected, path: path.trim() }])}>Save mapping</Button>
          </div>
        )}
      </div>
      {error && <p role="alert" className="py-2 text-caption-1-regular text-text-error-primary">{error}</p>}
    </SettingsCard>
  );
}

export function RepositoryFiles() {
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [projects, setProjects] = useState<RepositoryFileProject[]>([]);
  const [stored, setStored] = useState<StoredFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([loadRepoList(), loadRepositoryFileProjects(), loadStoredFiles()]).then(([available, rows, files]) => {
      if (!active) return;
      setRepos(available.map((item) => ({ full_name: item.full_name, name: item.name ?? item.full_name.split("/").at(-1) ?? item.full_name,
        default_branch: item.default_branch ?? "main", private: item.private })));
      setProjects(rows);
      setStored(files);
    }).catch(() => { if (active) setError("Couldn't load repository files."); });
    return () => { active = false; };
  }, []);

  async function onStore(name: string, file: File): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      await uploadStoredFile(name, file);
      setStored(await loadStoredFiles());
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't store the file.");
      return false;
    } finally { setBusy(false); }
  }

  async function onSaveMapping(repo: string, files: RepositoryFile[]) {
    setBusy(true); setError(null);
    try {
      let project = projects.find((item) => item.repo_full_name === repo);
      if (!project) {
        const response = await backendFetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: repo, repo_full_name: repo }) });
        if (!response.ok) throw new Error("Couldn't create repository settings.");
        project = await response.json() as RepositoryFileProject;
      }
      const saved = await saveRepositoryFiles(project.id, files);
      setProjects((current) => [...current.filter((item) => item.id !== saved.id), saved]);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save repository files."); }
    finally { setBusy(false); }
  }

  async function onRemoveStored(name: string) {
    setBusy(true); setError(null);
    try {
      const response = await backendFetch(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Couldn't remove the stored file.");
      setStored((current) => current.filter((item) => item.name !== name));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't remove the stored file."); }
    finally { setBusy(false); }
  }

  return (
    <RepositoryFilesPanel stored={stored} projects={projects} repos={repos} busy={busy} error={error}
      onStore={onStore} onSaveMapping={onSaveMapping} onRemoveStored={onRemoveStored}
      onDiscover={(item) => setRepos((current) => current.some((entry) => entry.full_name === item.full_name) ? current : [...current, item])} />
  );
}

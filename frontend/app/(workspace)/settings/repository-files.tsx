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

export function RepositoryFiles() {
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [projects, setProjects] = useState<RepositoryFileProject[]>([]);
  const [stored, setStored] = useState<StoredFile[]>([]);
  const [repo, setRepo] = useState("");
  const [fileName, setFileName] = useState("");
  const [upload, setUpload] = useState<File | null>(null);
  const [selected, setSelected] = useState("");
  const [path, setPath] = useState(".env");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const mapping = projects.find((project) => project.repo_full_name === repo)?.workspace_files ?? [];

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

  async function saveUpload() {
    if (!upload) return;
    setBusy(true); setError(null);
    try {
      await uploadStoredFile(fileName.trim(), upload);
      setStored(await loadStoredFiles());
      setSelected(fileName.trim()); setFileName(""); setUpload(null);
      if (input.current) input.current.value = "";
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't store the file."); }
    finally { setBusy(false); }
  }

  async function saveMapping(files: RepositoryFile[]) {
    if (!repo) return;
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

  async function removeStored(name: string) {
    setBusy(true); setError(null);
    try {
      const response = await backendFetch(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Couldn't remove the stored file.");
      setStored((current) => current.filter((item) => item.name !== name));
      if (selected === name) setSelected("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't remove the stored file."); }
    finally { setBusy(false); }
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
          <Button type="button" variant="secondary" size="small" disabled={busy || !upload || !/^[A-Z][A-Z0-9_]*$/.test(fileName)} onClick={() => void saveUpload()}>Store file</Button>
        </div>
        {stored.map((item) => (
          <div key={item.name} className="flex items-center justify-between gap-2">
            <span className="text-caption-1-regular text-text-secondary">{item.name}</span>
            <Button type="button" variant="ghost" size="xs" disabled={busy || projects.some((project) => project.workspace_files?.some((file) => file.name === item.name))}
              onClick={() => void removeStored(item.name)}>Remove</Button>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 py-3">
        <p className="text-caption-1-medium text-text-secondary">Add a file to a repository</p>
        <RepoMultiPicker repos={repos} value={repo ? [repo] : []} emptyLabel="Choose repository"
          onChange={(items) => setRepo(items.at(-1) ?? "")}
          onDiscover={(item) => setRepos((current) => current.some((entry) => entry.full_name === item.full_name) ? current : [...current, item])} />
        {repo && <>
          <p className="break-all text-caption-1-regular text-text-secondary">{repo}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Select size="sm" aria-label="Stored file" selectedKey={selected || null} onSelectionChange={(key) => setSelected(String(key))}>
              {stored.map((item) => <SelectItem key={item.name} id={item.name}>{item.name}</SelectItem>)}
            </Select>
            <InputBase aria-label="Path in repository" placeholder=".env" value={path} onChange={(event) => setPath(event.target.value)} />
            <Button type="button" variant="secondary" size="small" disabled={busy || !selected || !path.trim()}
              onClick={() => void saveMapping([...mapping.filter((file) => file.path !== path.trim()), { name: selected, path: path.trim() }])}>Save mapping</Button>
          </div>
          {mapping.map((file) => (
            <div key={file.path} className="flex items-center justify-between gap-2">
              <span className="break-all text-caption-1-regular text-text-secondary">{file.name} → {file.path}</span>
              <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void saveMapping(mapping.filter((item) => item.path !== file.path))}>Remove</Button>
            </div>
          ))}
        </>}
      </div>
      {error && <p role="alert" className="py-2 text-caption-1-regular text-text-error-primary">{error}</p>}
    </SettingsCard>
  );
}

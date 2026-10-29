import { backendFetch } from "@/lib/backend-fetch";

export interface RepositoryFile { name: string; path: string }
export interface RepositoryFileProject { id: string; repo_full_name: string | null; workspace_files?: RepositoryFile[] }
export interface StoredFile { name: string; kind: string }

export async function loadRepositoryFileProjects(): Promise<RepositoryFileProject[]> {
  const response = await backendFetch("/api/projects?scope=all&limit=500", { cache: "no-store" });
  if (!response.ok) throw new Error("Couldn't load repository settings.");
  return ((await response.json()) as { projects: RepositoryFileProject[] }).projects;
}

export async function loadStoredFiles(): Promise<StoredFile[]> {
  const response = await backendFetch("/api/secrets", { cache: "no-store" });
  if (!response.ok) throw new Error("Couldn't load stored files.");
  return (((await response.json()) as { secrets: StoredFile[] }).secrets ?? []).filter((item) => item.kind === "workspace_file");
}

export async function uploadStoredFile(name: string, file: File): Promise<void> {
  const body = new FormData();
  body.set("file", file);
  const response = await backendFetch(`/api/secrets/files/${encodeURIComponent(name)}`, { method: "PUT", body });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? "Couldn't store the file.");
  }
}

export async function saveRepositoryFiles(id: string, files: RepositoryFile[]): Promise<RepositoryFileProject> {
  const response = await backendFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_files: files }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? "Couldn't save repository files.");
  }
  return await response.json() as RepositoryFileProject;
}

// GitLab.com API boundary. Tokens never appear in URLs, diagnostics or results.
import { createHash } from "node:crypto";
import { normalizeGitLabRepository, GITLAB_REPOSITORY_PREFIX } from "../resources/gitlab-resolver";
import { gitlabExcludedGroups } from "../env";

const API = "https://gitlab.com/api/v4";
const TIMEOUT_MS = 12_000;

export class GitLabApiError extends Error {
  constructor(readonly status: number) { super(`GitLab API returned HTTP ${status}`); this.name = "GitLabApiError"; }
}
export interface GitLabRequestOptions {
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface GitLabProject {
  readonly id: number;
  readonly path_with_namespace: string;
  readonly name: string;
  readonly default_branch: string | null;
  readonly visibility: string;
}

interface DiscoveredProject {
  readonly full_name: string;
  readonly name: string;
  readonly private: boolean;
  readonly default_branch: string;
}

const projectCache = new Map<string, { readonly at: number; readonly projects: readonly DiscoveredProject[] }>();
const pendingProjects = new Map<string, Promise<readonly DiscoveredProject[]>>();
let projectCacheGeneration = 0;
const PROJECT_CACHE_TTL_MS = 60_000;
const PROJECT_CACHE_MAX_ENTRIES = 100;

/** Test and connection-lifecycle seam; values never contain credentials. */
export function clearGitLabProjectCache(): void {
  projectCacheGeneration++;
  projectCache.clear();
  pendingProjects.clear();
}

function projectCacheKey(token: string, search: string | undefined, excludedGroups: readonly string[]): string {
  const identity = createHash("sha256").update(token).digest("hex");
  return JSON.stringify([identity, search ?? "", [...excludedGroups].toSorted()]);
}

function cachedProjects(key: string): readonly DiscoveredProject[] | null {
  const hit = projectCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= PROJECT_CACHE_TTL_MS) { projectCache.delete(key); return null; }
  return hit.projects;
}

async function gitLabResponse<T>(token: string, path: string, options: GitLabRequestOptions = {}): Promise<{ value: T; totalPages: number | null; nextPage: number | null }> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitLab API path");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(`${API}${path}`, {
      method: options.method ?? "GET",
      headers: { "PRIVATE-TOKEN": token, Accept: "application/json", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "error", signal: controller.signal,
    });
    if (!response.ok) throw new GitLabApiError(response.status);
    const total = Number(response.headers.get("x-total-pages"));
    const next = Number(response.headers.get("x-next-page"));
    return { value: await response.json() as T,
      totalPages: Number.isSafeInteger(total) && total > 0 ? total : null,
      nextPage: Number.isSafeInteger(next) && next > 0 ? next : null };
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

export async function gitLabRequest<T>(token: string, path: string, options?: GitLabRequestOptions): Promise<T> {
  return (await gitLabResponse<T>(token, path, options)).value;
}

function validProject(value: GitLabProject): boolean {
  return Number.isSafeInteger(value.id) && value.id > 0 &&
    normalizeGitLabRepository(value.path_with_namespace) === value.path_with_namespace &&
    typeof value.name === "string" && ["private", "internal", "public"].includes(value.visibility);
}

export async function gitLabProject(token: string, repository: string): Promise<GitLabProject> {
  if (normalizeGitLabRepository(repository) !== repository) throw new Error("Invalid GitLab project path");
  const project = await gitLabRequest<GitLabProject>(token, `/projects/${encodeURIComponent(repository)}`);
  if (!validProject(project) || project.path_with_namespace !== repository) {
    throw new Error("GitLab returned a different project identity");
  }
  return project;
}

/** A bounded catalog; inaccessible and malformed projects are never offered. */
async function fetchGitLabProjects(token: string, search: string | undefined, excludedGroups: readonly string[]): Promise<DiscoveredProject[]> {
  const result: DiscoveredProject[] = [];
  const readPage = (page: number) => {
    const query = new URLSearchParams({ membership: "true", simple: "true", per_page: "100", page: String(page) });
    if (search) { query.set("search", search); query.set("search_namespaces", "true"); }
    return gitLabResponse<GitLabProject[]>(token, `/projects?${query}`);
  };
  const consume = (rows: GitLabProject[]) => {
    if (!Array.isArray(rows)) throw new Error("GitLab returned an invalid project list");
    for (const item of rows) if (validProject(item) && !excludedGroups.some((group) => item.path_with_namespace.toLowerCase().startsWith(`${group}/`))) result.push({
      full_name: `${GITLAB_REPOSITORY_PREFIX}${item.path_with_namespace}`,
      name: item.name, private: item.visibility !== "public", default_branch: item.default_branch || "main",
    });
  };
  const first = await readPage(1);
  consume(first.value);
  const limit = 50; // At most 5,000 projects, with six bounded requests at a time.
  if (first.totalPages) {
    if (first.totalPages > limit) throw new Error("GitLab has more than 5,000 matching projects; refine your search");
    for (let start = 2; start <= first.totalPages; start += 6) {
      const batch = Array.from({ length: Math.min(6, first.totalPages - start + 1) }, (_, index) => readPage(start + index));
      for (const page of await Promise.all(batch)) consume(page.value);
    }
    return result;
  }
  let next = first.nextPage;
  for (let seen = 1; next && seen < limit; seen++) {
    const page = await readPage(next);
    consume(page.value);
    next = page.nextPage;
  }
  if (next) throw new Error("GitLab has more than 5,000 matching projects; refine your search");
  return result;
}

/** Coalesce concurrent picker loads and reuse a complete catalog for search. */
export async function gitLabProjects(token: string, search?: string): Promise<DiscoveredProject[]> {
  const query = search?.trim() || undefined;
  const excludedGroups = gitlabExcludedGroups();
  const fullKey = projectCacheKey(token, undefined, excludedGroups);
  if (query) {
    let full = cachedProjects(fullKey);
    if (!full) {
      try { full = await pendingProjects.get(fullKey) ?? null; } catch { /* Search can still query the provider. */ }
    }
    if (full) {
      const needle = query.toLowerCase();
      return full.filter((project) => project.full_name.toLowerCase().includes(needle) || project.name.toLowerCase().includes(needle));
    }
  }

  const key = projectCacheKey(token, query, excludedGroups);
  const hit = cachedProjects(key);
  if (hit) return [...hit];
  let pending = pendingProjects.get(key);
  if (!pending) {
    const generation = projectCacheGeneration;
    pending = fetchGitLabProjects(token, query, excludedGroups).then((projects) => {
      if (generation === projectCacheGeneration) {
        if (projectCache.size >= PROJECT_CACHE_MAX_ENTRIES) projectCache.delete(projectCache.keys().next().value!);
        projectCache.set(key, { at: Date.now(), projects });
      }
      return projects;
    });
    pendingProjects.set(key, pending);
  }
  try { return [...await pending]; }
  finally { if (pendingProjects.get(key) === pending) pendingProjects.delete(key); }
}

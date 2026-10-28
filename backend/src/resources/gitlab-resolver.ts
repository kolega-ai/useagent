// GitLab.com project identities retain every group and subgroup segment.
import { RunIntakeError, type ResourceReference, type ResourceResolver } from "./types";

export const GITLAB_REPOSITORY_PREFIX = "gitlab.com/";

export function normalizeGitLabRepository(value: string): string | null {
  const path = value.startsWith(GITLAB_REPOSITORY_PREFIX)
    ? value.slice(GITLAB_REPOSITORY_PREFIX.length)
    : value;
  const parts = path.split("/");
  if (path.length > 400 || parts.length < 2 || parts.length > 20 || parts.some((part) =>
    !/^[A-Za-z0-9._-]{1,100}$/u.test(part) || part === "." || part === ".." || part.startsWith("-")
  )) return null;
  return path;
}

export function gitLabStoredRepository(value: string): string | null {
  if (!value.startsWith(GITLAB_REPOSITORY_PREFIX)) return null;
  const normalized = normalizeGitLabRepository(value);
  return normalized ? `${GITLAB_REPOSITORY_PREFIX}${normalized}` : null;
}

function invalid(reference: ResourceReference): never {
  throw new RunIntakeError({
    code: "resource_invalid", provider: "gitlab", reference: reference.raw,
    message: "Invalid or unsupported GitLab project URL.",
    action: "Select a GitLab.com project from the repository picker.",
  });
}

export const gitlabResourceResolver: ResourceResolver = {
  provider: "gitlab",
  supports(reference) {
    try { return new URL(reference.raw).hostname.toLowerCase() === "gitlab.com"; }
    catch { return false; }
  },
  resolve(reference) {
    let url: URL;
    try { url = new URL(reference.raw); } catch { return invalid(reference); }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "gitlab.com" ||
        url.port || url.username || url.password || url.search || url.hash) return invalid(reference);
    const repository = normalizeGitLabRepository(url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, ""));
    if (!repository || repository.split("/").includes("-")) return invalid(reference);
    return { resources: [{
      kind: "code.repository", provider: "gitlab",
      locator: { type: "gitlab.repository", repository, revision: null },
      capabilities: ["content.read", "code.checkout"],
    }] };
  },
};

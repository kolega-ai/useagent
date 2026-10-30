/** A repository's complete identity, including GitLab subgroups, is the key. */
export function projectHref(repository: string): string {
  return `/projects?repo=${encodeURIComponent(repository)}`;
}

/** Only produce provider links from valid repository path segments. */
export function repositoryWebUrl(repository: string): string | null {
  const gitlab = repository.startsWith("gitlab.com/");
  const path = gitlab ? repository.slice("gitlab.com/".length) : repository;
  const parts = path.split("/");
  if (parts.length < 2 || (!gitlab && parts.length !== 2) || parts.length > 20 ||
      parts.some((part) => !/^[A-Za-z0-9._-]{1,100}$/u.test(part) || part === "." || part === "..")) return null;
  return `https://${gitlab ? "gitlab.com" : "github.com"}/${parts.map(encodeURIComponent).join("/")}`;
}

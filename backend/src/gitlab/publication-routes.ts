// Session-authenticated, explicit publication of a frozen GitLab change set.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { artifactStorage } from "../artifacts/storage";
import { db } from "../db/client";
import { githubChangeSets } from "../db/schema";
import { betterAuthTrustedOrigins } from "../env";
import { getGitHubChangeSetForOrg, getGitHubPublicationReceiptForChangeSet } from "../github/publication-repo";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { getRunForOrg } from "../runs/repo";
import { prepareGitLabPublication } from "./publication-prepare";
import { publishGitLabChangeSet } from "./publication-publish";
import { MAX_PATCH_BYTES } from "./publication-capture";
import { GitLabApiError } from "./client";

export const gitlabPublicationRoutes = new Hono<AppEnv>();
gitlabPublicationRoutes.use("*", orgScope);

function trustedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try { return betterAuthTrustedOrigins().includes(new URL(origin).origin); }
  catch { return false; }
}

// Never return arbitrary infrastructure, database or network exceptions to the browser.
const publicErrors = new Set([
  "Thread is unavailable for publication.", "This thread has no retained workspace to publish.",
  "Wait for the thread to finish before preparing a merge request.", "Invalid GitLab project.",
  "This project is not bound to the thread.", "GitLab is not connected for this organization",
  "The GitLab target branch is unavailable.", "GitLab returned an invalid target branch.",
  "Could not capture changes. Check that the repository has changes and its target branch has not moved since checkout.",
  "Changes exceed the 25 MiB publication limit.", "The captured changes could not be read safely.",
  "The GitLab target branch moved. Refresh the workspace before publishing.",
  "A publication must contain between 1 and 200 files.", "The changes contain an unsupported path or file type.",
  "The changes contain an unsupported file mode.", "The changes exceed the publication file-size limit.",
  "The staged file could not be verified.", "The thread started another turn. Prepare the changes again after it finishes.",
  "Publication is unavailable.", "The thread's repository binding is unavailable.", "Publication receipt is unavailable.",
  "The prepared changes expired. Prepare them again before publishing.",
  "The frozen changes failed their integrity check.", "The frozen changes no longer match their review.",
  "The target changed or the publication branch already exists. Prepare the changes again.",
  "The GitLab connection changed. Retry with the current connection.",
  "The publication branch has a different commit. Review it in GitLab.",
  "Multiple matching merge requests require manual review.",
  "GitLab repository operation failed. Check the connection, repository access and branch.",
  "The publication lease expired. Retry after checking its status.",
]);

function publicError(error: unknown, fallback: string): string {
  if (error instanceof GitLabApiError && error.status === 429) return "GitLab's rate limit was reached. Wait a moment and retry.";
  if (error instanceof GitLabApiError) return `GitLab returned HTTP ${error.status}. Check the connection, project permissions and target branch.`;
  if (error instanceof Error && publicErrors.has(error.message)) return error.message;
  return fallback;
}

async function owned(orgId: string, userId: string, id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id)) return null;
  const set = await getGitHubChangeSetForOrg(orgId, id);
  if (!set || set.provider !== "gitlab" || set.userId !== userId) return null;
  const receipt = await getGitHubPublicationReceiptForChangeSet(orgId, id);
  return receipt ? { set, receipt } : null;
}

function projection(value: NonNullable<Awaited<ReturnType<typeof owned>>>) {
  const { set, receipt } = value;
  return { id: set.id, runId: set.runId, repository: set.repoFullName, targetBranch: set.baseRef,
    baseSha: set.baseSha, files: set.manifest.files, expiresAt: set.expiresAt.toISOString(),
    sourceBranch: receipt.headBranch, title: receipt.pullRequestTitle, draft: receipt.draft,
    state: receipt.state, mergeRequestUrl: receipt.pullRequestUrl, error: receipt.lastError };
}

gitlabPublicationRoutes.get("/latest/:runId", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const run = await getRunForOrg(c.get("orgId"), c.req.param("runId"));
  if (!run || run.userId !== userId) return c.json({ error: "not_found" }, 404);
  const [latest] = await db.select({ id: githubChangeSets.id }).from(githubChangeSets).where(and(
    eq(githubChangeSets.orgId, c.get("orgId")), eq(githubChangeSets.userId, userId),
    eq(githubChangeSets.threadId, run.threadId), eq(githubChangeSets.provider, "gitlab"),
  )).orderBy(desc(githubChangeSets.createdAt)).limit(1);
  const value = latest ? await owned(c.get("orgId"), userId, latest.id) : null;
  return c.json({ publication: value ? projection(value) : null });
});

gitlabPublicationRoutes.post("/prepare", bodyLimit({ maxSize: 4096 }), async (c) => {
  if (!trustedOrigin(c.req.raw)) return c.json({ error: "Invalid request origin." }, 403);
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  let body: { runId?: unknown; repository?: unknown; title?: unknown; draft?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid request." }, 400); }
  if (!body || typeof body.runId !== "string" || typeof body.repository !== "string" || typeof body.title !== "string" || typeof body.draft !== "boolean") {
    return c.json({ error: "A thread, project, title and draft choice are required." }, 400);
  }
  try {
    const value = await prepareGitLabPublication({ orgId: c.get("orgId"), userId, runId: body.runId,
      repository: body.repository, title: body.title, draft: body.draft, signal: c.req.raw.signal });
    return c.json({ publication: projection({ set: value.changeSet, receipt: value.receipt }) });
  } catch (error) { return c.json({ error: publicError(error, "Could not prepare changes. Check the title, workspace and GitLab connection.") }, 400); }
});

gitlabPublicationRoutes.get("/:id/patch", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const value = await owned(c.get("orgId"), userId, c.req.param("id"));
  if (!value) return c.json({ error: "not_found" }, 404);
  if (value.set.payloadSizeBytes > MAX_PATCH_BYTES || await artifactStorage().size(value.set.payloadStorageKey) !== value.set.payloadSizeBytes) {
    return c.json({ error: "The frozen changes failed their integrity check." }, 409);
  }
  const bytes = await artifactStorage().read(value.set.payloadStorageKey);
  if (bytes.length !== value.set.payloadSizeBytes || createHash("sha256").update(bytes).digest("hex") !== value.set.payloadSha256) {
    return c.json({ error: "The frozen changes failed their integrity check." }, 409);
  }
  return new Response(bytes, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment; filename=changes.patch",
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
});

gitlabPublicationRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const value = await owned(c.get("orgId"), userId, c.req.param("id"));
  return value ? c.json({ publication: projection(value) }) : c.json({ error: "not_found" }, 404);
});

gitlabPublicationRoutes.post("/:id/publish", bodyLimit({ maxSize: 4096 }), async (c) => {
  if (!trustedOrigin(c.req.raw)) return c.json({ error: "Invalid request origin." }, 403);
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  let body: { approved?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid request." }, 400); }
  if (!body || body.approved !== true) return c.json({ error: "Review and approve the prepared changes first." }, 400);
  if (!(await owned(c.get("orgId"), userId, c.req.param("id")))) return c.json({ error: "not_found" }, 404);
  try {
    await publishGitLabChangeSet({ orgId: c.get("orgId"), userId, changeSetId: c.req.param("id"), signal: c.req.raw.signal });
    const value = await owned(c.get("orgId"), userId, c.req.param("id"));
    return value ? c.json({ publication: projection(value) }) : c.json({ error: "not_found" }, 404);
  } catch (error) { return c.json({ error: publicError(error, "Could not publish changes. Check the publication status before retrying.") }, 400); }
});

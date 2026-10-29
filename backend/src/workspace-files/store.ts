import { and, eq, inArray } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { projects, secrets, workspaceFileVersions } from "../db/schema";
import { parseRepoRef } from "../github/repo-ref";
import { openSecret } from "../secrets/crypto";
import { secretRedactionValues } from "../secrets/redact";
import type { ThreadWorkspaceFile } from "./types";

export class WorkspaceFileError extends Error {
  readonly code = "workspace_file_unavailable" as const;
}

/** Pin only metadata and an immutable encrypted version id on the thread. */
export async function selectThreadWorkspaceFiles(
  orgId: string, repos: readonly string[], selection: readonly string[] | null | undefined, exec: Executor = db,
): Promise<ThreadWorkspaceFile[]> {
  const names = [...new Set(repos.map((entry) => parseRepoRef(entry).repo))];
  if (!names.length) {
    if (selection?.length) throw new WorkspaceFileError("A selected file needs a repository");
    return [];
  }
  const configured = await exec.select({ repo: projects.repoFullName, files: projects.workspaceFiles }).from(projects)
    .where(and(eq(projects.orgId, orgId), inArray(projects.repoFullName, names)));
  const entries = configured.flatMap((row) => (row.files ?? []).map((file) => ({ ...file, repository: row.repo! })));
  const selected = selection == null ? entries : entries.filter((item) => selection.includes(item.name));
  if (selection?.some((name) => !entries.some((item) => item.name === name))) {
    throw new WorkspaceFileError("A selected file is no longer configured for this repository");
  }
  if (!selected.length) return [];
  const secretNames = [...new Set(selected.map((file) => file.name))];
  const rows = await exec.select({ name: secrets.name, kind: secrets.kind, version: secrets.workspaceFileVersionId })
    .from(secrets).where(and(eq(secrets.orgId, orgId), inArray(secrets.name, secretNames)));
  return selected.map((file) => {
    const row = rows.find((item) => item.name === file.name && item.kind === "workspace_file");
    if (!row?.version) throw new WorkspaceFileError(`The configured file ${file.name} is unavailable`);
    return { ...file, versionId: row.version };
  });
}

export interface ResolvedWorkspaceFile extends ThreadWorkspaceFile {
  readonly bytes: Buffer;
  readonly redactionValues: readonly string[];
}

export async function resolveThreadWorkspaceFiles(orgId: string, files: readonly ThreadWorkspaceFile[]): Promise<ResolvedWorkspaceFile[]> {
  if (!files.length) return [];
  const rows = await db.select().from(workspaceFileVersions).where(and(
    eq(workspaceFileVersions.orgId, orgId), inArray(workspaceFileVersions.id, files.map((file) => file.versionId)),
  ));
  return files.map((file) => {
    const row = rows.find((entry) => entry.id === file.versionId && entry.name === file.name);
    if (!row) throw new WorkspaceFileError(`The saved version of ${file.name} is unavailable`);
    let encoded: string;
    try { encoded = openSecret({ ciphertext: row.valueCiphertext, iv: row.iv, tag: row.tag }); }
    catch { throw new WorkspaceFileError(`The saved version of ${file.name} could not be decrypted`); }
    return { ...file, bytes: Buffer.from(encoded, "base64"), redactionValues: secretRedactionValues({ kind: "workspace_file", value: encoded }) };
  });
}

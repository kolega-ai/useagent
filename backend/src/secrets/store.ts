import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/client";
import { secrets, workspaceFileVersions, type SecretKind } from "../db/schema";
import { isReservedSecretName, isValidSecretName, openSecret, sealSecret } from "./crypto";
import { createSecretRedactor, secretRedactionValues, type SecretRedactor } from "./redact";
import { agentSourceControlCredentials, sourceControlCredentialValues } from "../repositories/agent-credentials";
import { resolveThreadWorkspaceFiles } from "../workspace-files/store";
import type { ThreadWorkspaceFile } from "../workspace-files/types";

// ---------------------------------------------------------------------------
// Org-secrets data access (task #100). Values are encrypted at rest (crypto.ts)
// and are WRITE-ONLY at the API boundary: this module exposes name+timestamp
// metadata for listing, an upsert, a delete, and a decrypt-all used ONLY by the
// sandbox env-injection seam (secrets/inject.ts). It never returns a plaintext
// value to an HTTP handler.
// ---------------------------------------------------------------------------

export type SecretRecord = typeof secrets.$inferSelect;

/** Public shape at the API boundary - name, kind, and timestamps, NEVER a value. */
export interface SecretMeta {
  name: string;
  kind: SecretKind;
  createdAt: string;
  updatedAt: string;
}

function toMeta(r: SecretRecord): SecretMeta {
  return {
    name: r.name,
    kind: r.kind,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** List an org's secret names + timestamps (never values), alphabetical by name. */
export async function listSecretMeta(orgId: string): Promise<SecretMeta[]> {
  const rows = await db
    .select()
    .from(secrets)
    .where(eq(secrets.orgId, orgId))
    .orderBy(asc(secrets.name));
  return rows.map(toMeta);
}

/** Upsert a secret value by (org, name): encrypt at rest and, on a name that
 *  already exists, replace the ciphertext + kind + bump updated_at. Returns
 *  metadata only. Callers MUST validate `name` (isValidSecretName) before
 *  calling. `kind` defaults to "env"; "file" materializes to a sandbox file. */
export async function upsertSecret(
  orgId: string,
  name: string,
  value: string,
  kind: SecretKind = "env",
): Promise<SecretMeta> {
  const sealed = sealSecret(value);
  const [row] = await db
    .insert(secrets)
    .values({
      orgId,
      name,
      kind,
      valueCiphertext: sealed.ciphertext,
      iv: sealed.iv,
      tag: sealed.tag,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.name],
      setWhere: kind === "workspace_file" ? eq(secrets.kind, "workspace_file") : ne(secrets.kind, "workspace_file"),
      set: {
        kind,
        valueCiphertext: sealed.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
        updatedAt: new Date(),
      },
    })
    .returning();
  // An upsert always writes (and returns) exactly one row; guard for the type.
  if (!row) throw new Error("A secret with this name has a different type");
  return toMeta(row);
}

/** Store bytes as an immutable encrypted version and point the named file at
 * it atomically. Old threads keep their version after a replacement. */
export async function upsertWorkspaceFile(orgId: string, name: string, bytes: Uint8Array): Promise<SecretMeta> {
  const sealed = sealSecret(Buffer.from(bytes).toString("base64"));
  return db.transaction(async (tx) => {
    const [version] = await tx.insert(workspaceFileVersions).values({
      orgId, name, valueCiphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.tag,
    }).returning({ id: workspaceFileVersions.id });
    if (!version) throw new Error("Could not save the file version");
    const [row] = await tx.insert(secrets).values({
      orgId, name, kind: "workspace_file", valueCiphertext: sealed.ciphertext,
      iv: sealed.iv, tag: sealed.tag, workspaceFileVersionId: version.id,
    }).onConflictDoUpdate({
      target: [secrets.orgId, secrets.name],
      setWhere: eq(secrets.kind, "workspace_file"),
      set: { valueCiphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.tag,
        workspaceFileVersionId: version.id, updatedAt: new Date() },
    }).returning();
    if (!row) throw new Error("A secret with this name has a different type");
    return toMeta(row);
  });
}

/** Delete a secret by name (org-scoped). Returns true when a row was removed; a
 *  cross-org or missing name removes nothing and returns false. */
export async function deleteSecret(orgId: string, name: string): Promise<boolean> {
  const rows = await db
    .delete(secrets)
    .where(and(eq(secrets.orgId, orgId), eq(secrets.name, name)))
    .returning({ name: secrets.name });
  return rows.length > 0;
}

/** One decrypted secret ready for injection - the plaintext value lives ONLY
 *  here (in memory, at run boot), never on disk in the backend. */
export interface DecryptedSecret {
  name: string;
  kind: SecretKind;
  value: string;
}

/** Decrypted secrets ready for sandbox injection: the decrypted list (values
 *  live ONLY here), the names successfully decrypted (for the marker), and any
 *  names that were skipped (undecryptable / malformed). */
export interface DecryptedSecrets {
  secrets: DecryptedSecret[];
  names: string[];
  skipped: string[];
}

/**
 * Decrypt ALL of an org's secrets for boot-time injection. A row that fails to
 * decrypt (tampered ciphertext, key rotation) or whose stored name is somehow
 * malformed is SKIPPED and logged - this function NEVER throws, so one corrupt
 * secret can never fail a run. Values appear only in the returned list; `names`
 * feeds the names-only `secrets.injected` marker.
 */
export async function decryptOrgSecrets(orgId: string): Promise<DecryptedSecrets> {
  const rows = await db
    .select()
    .from(secrets)
    .where(eq(secrets.orgId, orgId))
    .orderBy(asc(secrets.name));

  const out: DecryptedSecrets = { secrets: [], names: [], skipped: [] };
  for (const r of rows) {
    // Names are validated at write time; re-check so a hand-edited row can never
    // inject a malformed env key into the sandbox process.
    if (!isValidSecretName(r.name) || isReservedSecretName(r.name)) {
      out.skipped.push(r.name);
      continue;
    }
    try {
      const value = openSecret({
        ciphertext: r.valueCiphertext,
        iv: r.iv,
        tag: r.tag,
      });
      out.secrets.push({ name: r.name, kind: r.kind, value });
      out.names.push(r.name);
    } catch (err) {
      out.skipped.push(r.name);
      console.warn(
        `[secrets] skipping undecryptable secret "${r.name}" for org ${orgId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}


/** Build a redactor over an org's decrypted secret values, so durable text
 *  derived after the fact (recovery re-probes, learning-lane traces) redacts
 *  exactly what the live capture lane does. A null org (or a decrypt failure)
 *  still yields the baseline redactor that scrubs JWTs and signed capabilities.
 *  When a thread has pinned files, loading them must succeed: replaying with
 *  an incomplete redactor could persist the contents of an older file version. */
export async function orgSecretRedactor(orgId: string | null, files: readonly ThreadWorkspaceFile[] = []): Promise<SecretRedactor> {
  if (files.length) return strictOrgSecretRedactor(orgId, files);
  if (!orgId) return createSecretRedactor([]);
  try {
    const decrypted = await decryptOrgSecrets(orgId);
    const sourceControl = await agentSourceControlCredentials(orgId);
    const selected = await resolveThreadWorkspaceFiles(orgId, files);
    return createSecretRedactor([...decrypted.secrets.filter((secret) => secret.kind !== "workspace_file").flatMap(secretRedactionValues), ...sourceControlCredentialValues(sourceControl),
      ...selected.flatMap((file) => file.redactionValues)]);
  } catch {
    return createSecretRedactor([]);
  }
}

/** Build a complete org-secret redactor for credential-bearing durable writes.
 * Unlike orgSecretRedactor, lookup and per-secret decryption failures propagate
 * so callers can fail closed before dispatching or persisting unredacted input. */
export async function strictOrgSecretRedactor(orgId: string | null, files: readonly ThreadWorkspaceFile[] = []): Promise<SecretRedactor> {
  if (!orgId) return createSecretRedactor([]);
  const decrypted = await decryptOrgSecrets(orgId);
  if (decrypted.skipped.length > 0) {
    throw new Error("org secret redactor unavailable");
  }
  const sourceControl = await agentSourceControlCredentials(orgId);
  const selected = await resolveThreadWorkspaceFiles(orgId, files);
  return createSecretRedactor([...decrypted.secrets.filter((secret) => secret.kind !== "workspace_file").flatMap(secretRedactionValues), ...sourceControlCredentialValues(sourceControl),
    ...selected.flatMap((file) => file.redactionValues)]);
}

/** Decrypt exactly one named secret for a trusted control-plane consumer. This
 * keeps provider-gateway plaintext exposure to the credential it needs instead
 * of materializing the org's full secret catalog. */
export async function decryptOrgSecretByName(
  orgId: string,
  name: string,
): Promise<DecryptedSecret | null> {
  if (!isValidSecretName(name)) return null;
  const [row] = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.orgId, orgId), eq(secrets.name, name)))
    .limit(1);
  if (!row) return null;
  // A byte-oriented workspace file is never a provider credential by name.
  if (row.kind === "workspace_file") return null;
  try {
    return {
      name: row.name,
      kind: row.kind,
      value: openSecret({
        ciphertext: row.valueCiphertext,
        iv: row.iv,
        tag: row.tag,
      }),
    };
  } catch (err) {
    console.warn(
      `[secrets] skipping undecryptable secret "${name}" for org ${orgId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

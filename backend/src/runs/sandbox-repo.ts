import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runs } from "../db/schema";

/** Persist the sandbox a run executed in (thread→sandbox mapping, durable). Returns
 * the updated row id; THROWS if no run row matched (a zero-row UPDATE must not read as
 * success - the control plane would then believe the association was recorded when it
 * was not). Callers await this BEFORE executing so a missing row fails the turn closed. */
export async function setRunSandbox(
  id: string,
  sandboxId: string,
  binding?: { readonly kind: SandboxProviderKind; readonly credential: "env" | "user" },
  snapshot?: string | null,
): Promise<void> {
  const updated = await db
    .update(runs)
    .set({
      sandboxId,
      ...(snapshot !== undefined ? { sandboxSnapshot: snapshot } : {}),
      ...(binding ? { sandboxProvider: binding.kind, sandboxCredential: binding.credential } : {}),
    })
    .where(eq(runs.id, id))
    .returning({ id: runs.id });
  if (updated.length === 0) {
    throw new Error(`setRunSandbox: run ${id} not found (no row updated)`);
  }
}

/** The last recorded allocation, if it used this provider, including the base image (empty string).
 * Legacy rows have no snapshot and keep their historical resolution behaviour. */
export async function getThreadSandboxSnapshot(orgId: string, threadId: string, provider: SandboxProviderKind): Promise<string | null> {
  const [row] = await db.select({ snapshot: runs.sandboxSnapshot, provider: runs.sandboxProvider }).from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.threadId, threadId), isNotNull(runs.sandboxId)))
    .orderBy(desc(runs.threadSeq), desc(runs.createdAt), desc(runs.id)).limit(1);
  return row?.provider === provider ? row.snapshot : null;
}

/** The most recent sandbox id recorded in this thread — the box holding the
 * conversation's workspace and resident engine server. Survives restarts. */
export async function getThreadSandbox(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ sid: runs.sandboxId })
    .from(runs)
    .where(and(eq(runs.threadId, threadId), isNotNull(runs.sandboxId)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return row?.sid ?? null;
}

export async function getThreadSandboxForOrg(
  orgId: string,
  threadId: string,
  exec: Executor = db,
): Promise<string | null> {
  const [row] = await exec
    .select({ sid: runs.sandboxId })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.threadId, threadId),
        isNotNull(runs.sandboxId),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return row?.sid ?? null;
}

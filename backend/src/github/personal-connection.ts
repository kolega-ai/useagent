// Organization-owned GitHub personal tokens use the shared encrypted integration store.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { integrationConnections } from "../db/schema";
import { findConnectedOrgIntegrationRecord } from "../integrations/connection-repo";
import { deleteIntegrationCredential, readIntegrationCredential, upsertIntegrationCredential } from "../integrations/credential-repo";
import { asOrgAdmin } from "../provider-connections/repo";
import { publishOrgChange } from "../runs/org-signals";

export const GITHUB_PERSONAL_CONNECTION_BINDING = "github.com-token-v1";
const FORMAT = "github-personal-access-token-v1";

export async function githubPersonalConnection(orgId: string): Promise<{
  readonly token: string;
  readonly account: string | null;
  readonly connectionId: string;
  readonly revision: string;
} | null> {
  const row = await findConnectedOrgIntegrationRecord({ orgId, provider: "github", runtimeBindingId: GITHUB_PERSONAL_CONNECTION_BINDING });
  if (!row) return null;
  const secret = await readIntegrationCredential({ connectionId: row.id, orgId, provider: "github", externalConnectionId: row.externalConnectionId });
  if (!secret || secret.format !== FORMAT) throw new Error("GitHub connection credential is unavailable");
  return { token: secret.serialized, account: row.externalConnectionName, connectionId: row.id, revision: row.updatedAt.toISOString() };
}

export async function githubPersonalConnectionStatus(orgId: string): Promise<{ connected: boolean; account: string | null }> {
  const row = await findConnectedOrgIntegrationRecord({ orgId, provider: "github", runtimeBindingId: GITHUB_PERSONAL_CONNECTION_BINDING });
  return { connected: Boolean(row), account: row?.externalConnectionName ?? null };
}

export async function connectGithubPersonal(orgId: string, userId: string, value: string): Promise<boolean> {
  const token = value.trim();
  if (!token || token.length > 4096 || /[\x00-\x20\x7f]/u.test(token)) throw new Error("Invalid GitHub token");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let account: { id?: unknown; login?: unknown };
  let scopes: string[];
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "useagent", "X-GitHub-Api-Version": "2022-11-28" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("GitHub token could not be verified");
    account = await response.json() as typeof account;
    scopes = (response.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
  } finally { clearTimeout(timer); }
  if (!Number.isSafeInteger(account.id) || typeof account.login !== "string" || !account.login || account.login.length > 200) {
    throw new Error("GitHub token account is invalid");
  }
  const externalConnectionId = createHash("sha256").update(orgId).digest("hex");
  const outcome = await asOrgAdmin(orgId, userId, () => db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.insert(integrationConnections).values({
      orgId, ownerType: "org", ownerUserId: null, provider: "github", runtimeBindingId: GITHUB_PERSONAL_CONNECTION_BINDING,
      externalConnectionId, externalConnectionName: account.login as string, status: "connected", authMethod: "api_key",
      accountMetadata: { externalAccountId: String(account.id), displayName: account.login as string },
      scopes, createdByUserId: userId, lastVerifiedAt: now,
    }).onConflictDoUpdate({
      target: [integrationConnections.runtimeBindingId, integrationConnections.provider, integrationConnections.externalConnectionId],
      set: { status: "connected", externalConnectionName: account.login as string,
        accountMetadata: { externalAccountId: String(account.id), displayName: account.login as string },
        scopes, lastVerifiedAt: now, revokedAt: null, updatedAt: now },
    }).returning();
    if (!row || row.orgId !== orgId) throw new Error("GitHub connection identity mismatch");
    await upsertIntegrationCredential({ connectionId: row.id, orgId, provider: "github", externalConnectionId }, { format: FORMAT, serialized: token }, tx);
    return row.id;
  }));
  if (outcome) publishOrgChange(orgId, { type: "integration_connection", action: "updated", connectionId: outcome.value, provider: "github" });
  return outcome !== null;
}

export async function disconnectGithubPersonal(orgId: string, userId: string): Promise<boolean> {
  const outcome = await asOrgAdmin(orgId, userId, () => db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.update(integrationConnections).set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.provider, "github"),
        eq(integrationConnections.runtimeBindingId, GITHUB_PERSONAL_CONNECTION_BINDING), eq(integrationConnections.ownerType, "org"))).returning();
    if (row) await deleteIntegrationCredential(row.id, tx);
    return row?.id ?? null;
  }));
  if (outcome?.value) publishOrgChange(orgId, { type: "integration_connection", action: "revoked", connectionId: outcome.value, provider: "github" });
  return outcome !== null;
}

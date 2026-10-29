// Organization-owned GitLab credentials stay encrypted in the integration store.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { integrationConnections } from "../db/schema";
import { findConnectedOrgIntegrationRecord, findLatestOrgIntegrationRecord } from "../integrations/connection-repo";
import { deleteIntegrationCredential, readIntegrationCredential, upsertIntegrationCredential } from "../integrations/credential-repo";
import { asOrgAdmin } from "../provider-connections/repo";
import { gitLabRequest } from "./client";
import { publishOrgChange } from "../runs/org-signals";

export const GITLAB_CONNECTION_BINDING = "gitlab.com-token-v1";
const FORMAT = "gitlab-personal-access-token-v1";

export async function gitLabToken(orgId: string): Promise<string | null> {
  const row = await findConnectedOrgIntegrationRecord({ orgId, provider: "gitlab", runtimeBindingId: GITLAB_CONNECTION_BINDING });
  if (!row) return null;
  const secret = await readIntegrationCredential({ connectionId: row.id, orgId, provider: "gitlab", externalConnectionId: row.externalConnectionId });
  if (!secret || secret.format !== FORMAT) throw new Error("GitLab connection credential is unavailable");
  return secret.serialized;
}

export async function gitLabConnectionStatus(orgId: string): Promise<{ connected: boolean; account: string | null }> {
  const row = await findLatestOrgIntegrationRecord({ orgId, provider: "gitlab", runtimeBindingId: GITLAB_CONNECTION_BINDING });
  return { connected: row?.status === "connected", account: row?.status === "connected" ? row.externalConnectionName : null };
}

export async function connectGitLab(orgId: string, userId: string, token: string): Promise<boolean> {
  const secret = token.trim();
  if (!secret || secret.length > 4096 || /[\x00-\x20\x7f]/u.test(secret)) throw new Error("Invalid GitLab token");
  const [user, personalToken] = await Promise.all([
    gitLabRequest<{ id?: number; username?: string }>(secret, "/user"),
    gitLabRequest<{ active?: boolean; scopes?: string[] }>(secret, "/personal_access_tokens/self"),
  ]);
  if (!Number.isSafeInteger(user.id) || !user.username || user.username.length > 200 ||
      !personalToken.active || !personalToken.scopes?.includes("api")) {
    throw new Error("GitLab requires an active personal or group access token with the api scope");
  }
  const externalConnectionId = createHash("sha256").update(orgId).digest("hex");
  const outcome = await asOrgAdmin(orgId, userId, () => db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.insert(integrationConnections).values({
      orgId, ownerType: "org", ownerUserId: null, provider: "gitlab", runtimeBindingId: GITLAB_CONNECTION_BINDING,
      externalConnectionId, externalConnectionName: user.username, status: "connected", authMethod: "api_key",
      accountMetadata: { externalAccountId: String(user.id), displayName: user.username },
      scopes: personalToken.scopes ?? [], createdByUserId: userId, lastVerifiedAt: now,
    }).onConflictDoUpdate({
      target: [integrationConnections.runtimeBindingId, integrationConnections.provider, integrationConnections.externalConnectionId],
      set: { status: "connected", externalConnectionName: user.username, accountMetadata: {
        externalAccountId: String(user.id), displayName: user.username,
      }, scopes: personalToken.scopes ?? [], lastVerifiedAt: now, revokedAt: null, updatedAt: now },
    }).returning();
    if (!row || row.orgId !== orgId) throw new Error("GitLab connection identity mismatch");
    await upsertIntegrationCredential({ connectionId: row.id, orgId, provider: "gitlab", externalConnectionId }, { format: FORMAT, serialized: secret }, tx);
    return row.id;
  }));
  if (outcome) publishOrgChange(orgId, { type: "integration_connection", action: "updated", connectionId: outcome.value, provider: "gitlab" });
  return outcome !== null;
}

export async function disconnectGitLab(orgId: string, userId: string): Promise<boolean> {
  const outcome = await asOrgAdmin(orgId, userId, () => db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.update(integrationConnections).set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.provider, "gitlab"),
        eq(integrationConnections.runtimeBindingId, GITLAB_CONNECTION_BINDING), eq(integrationConnections.ownerType, "org"))).returning();
    if (row) await deleteIntegrationCredential(row.id, tx);
    return row?.id ?? null;
  }));
  if (outcome?.value) publishOrgChange(orgId, { type: "integration_connection", action: "revoked", connectionId: outcome.value, provider: "gitlab" });
  return outcome !== null;
}

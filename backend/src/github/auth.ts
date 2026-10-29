import {
  devModeEnabled,
  githubAppConfig,
  githubConfig,
  githubTenantOrgId,
  type GithubAppConfig,
  type GithubAuthSource,
} from "../env";
import {
  getInstallationToken,
  getInstallationTokenForId,
  getRepositoryInstallationToken,
  getRepositoryInstallationTokenForId,
  getRepositoryPublicationToken,
  getRepositoryPublicationTokenForId,
} from "./app-auth";
import {
  findConnectedOrgIntegrationRecord,
  findLatestOrgIntegrationRecord,
} from "../integrations/connection-repo";
import {
  GITHUB_NATIVE_RUNTIME_BINDING_ID,
  githubNativeConnectionConfigFromEnv,
} from "../integrations/github-native-backend";
import { githubPersonalConnection } from "./personal-connection";

// ---------------------------------------------------------------------------
// One place that turns configured credentials into concrete bearer tokens.
// Backend-only GitHub calls retain PAT > App > anonymous precedence. Retained
// sandboxes use the separate repo-aware resolver at the bottom of this file.
// ---------------------------------------------------------------------------

export interface GithubAuth {
  /** Bearer for GitHub API calls + private clones: a PAT, a freshly-valid App
   *  installation token, or null when only public access is available. */
  token: string | null;
  /** org/user whose repos to list (may be null in the token-only PAT case). */
  owner: string | null;
  source: GithubAuthSource;
  /** Internal connection identity used to derive opaque catalog references. */
  connectionId?: string | null;
  /** Changes when a personal connection is rotated, invalidating its catalog. */
  revision?: string | null;
}

/** One org-scoped GitHub credential resolved once and passed through every
 * repository operation in a job. Boot jobs and background work must use this
 * instead of re-resolving deployment credentials between list/clone/read calls. */
export interface GithubRepositoryAccess {
  readonly orgId: string;
  readonly token: string;
  readonly owner: string | null;
  readonly source: GithubAuthSource;
  readonly connectionId: string | null;
}

async function resolveTenantGithubAuth(orgId: string): Promise<{
  readonly auth: GithubAuth;
  readonly installationId: number;
  readonly app: GithubAppConfig;
} | null> {
  const record = await findConnectedOrgIntegrationRecord({
    orgId,
    provider: "github",
    runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
  });
  if (!record) {
    const latest = await findLatestOrgIntegrationRecord({
      orgId,
      provider: "github",
      runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
    });
    if (latest?.status === "revoked") {
      throw new Error("GitHub integration has been revoked for this organization");
    }
    return null;
  }
  const connection = githubNativeConnectionConfigFromEnv();
  if (!connection) throw new Error("GitHub tenant integration backend is unavailable");
  const installationId = Number(record.externalConnectionId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("stored GitHub installation id is invalid");
  }
  const app = { appId: connection.appId, privateKey: connection.privateKey, org: null };
  const { token } = await getInstallationTokenForId(installationId, app);
  return {
    auth: {
      token,
      owner: record.externalConnectionName,
      source: "app",
      connectionId: record.id,
    },
    installationId,
    app,
  };
}

/**
 * Resolve one org-authorized GitHub credential for repository work. A revoked
 * tenant connection never falls back to a process-global PAT/App; legacy auth
 * is accepted only when it is explicitly assigned to this exact product org.
 */
export async function resolveGithubRepositoryAccess(
  orgId: string,
): Promise<GithubRepositoryAccess> {
  // `resolveGithubCatalogAuth` is the canonical org boundary: it prefers the
  // tenant connection, rejects a revoked connection before considering legacy
  // credentials, and only permits legacy auth when explicitly assigned to this
  // exact product org.
  const auth = await resolveGithubCatalogAuth(orgId);
  if (!auth.token) throw new Error("GitHub is not connected for this organization");
  return {
    orgId,
    token: auth.token,
    owner: auth.owner,
    source: auth.source,
    connectionId: auth.connectionId ?? null,
  };
}

/**
 * Resolve the active GitHub auth. A configured PAT wins outright; otherwise a
 * configured App mints (or reuses) an installation token; otherwise we're
 * anonymous. The App branch can throw if GitHub rejects the creds — callers that
 * must not fail (the listing) catch it and degrade to an honest error.
 */
export async function resolveGithubAuth(): Promise<GithubAuth> {
  const { token: pat, owner } = githubConfig();
  if (pat) return { token: pat, owner, source: "pat", connectionId: null };

  const app = githubAppConfig();
  if (app) {
    const { token } = await getInstallationToken(app);
    return { token, owner: owner ?? app.org, source: "app", connectionId: null };
  }

  return { token: null, owner, source: "anon", connectionId: null };
}

/**
 * Resolve the credential used by the repository picker and branch browser.
 * An organization-connected personal token takes precedence. Existing App
 * installations keep their catalog and scoped clone behavior.
 */
export async function resolveGithubCatalogAuth(orgId?: string): Promise<GithubAuth> {
  if (orgId) {
    const personal = await githubPersonalConnection(orgId);
    if (personal) return { token: personal.token, owner: personal.account, source: "pat", connectionId: personal.connectionId, revision: personal.revision };
    const tenant = await resolveTenantGithubAuth(orgId);
    if (tenant) return tenant.auth;
    if (githubConfig().token || githubAppConfig()) {
      const legacyTenantOrgId = githubTenantOrgId();
      if (!legacyTenantOrgId) {
        throw new Error(
          "GitHub is connected but not assigned to a product organization; set " +
            "GITHUB_TENANT_ORG_ID to the owning organization id and retry",
        );
      }
      if (legacyTenantOrgId !== orgId) {
        throw new Error("GitHub repository access is not available to this organization");
      }
    }
  }
  const app = githubAppConfig();
  if (!app) return resolveGithubAuth();

  const { owner } = githubConfig();
  const { token } = await getInstallationToken(app);
  return { token, owner: owner ?? app.org, source: "app", connectionId: null };
}

/**
 * Just the bearer token for backend-only GitHub operations. Never use this for
 * a retained sandbox; use {@link resolveGithubSandboxToken} with the exact repo.
 */
export async function resolveGithubToken(): Promise<string | null> {
  return (await resolveGithubAuth()).token;
}

/**
 * Resolve the credential for repository preparation. A connected personal
 * token takes precedence; existing App installations retain their scoped token.
 */
export async function resolveGithubSandboxToken(
  repository: string,
  orgId?: string | null,
): Promise<string | null> {
  if (orgId) {
    const personal = await githubPersonalConnection(orgId);
    if (personal) return personal.token;
    const tenant = await resolveTenantGithubAuth(orgId);
    if (tenant) {
      return (
        await getRepositoryInstallationTokenForId(
          repository,
          tenant.installationId,
          tenant.app,
        )
      ).token;
    }
  }
  const app = githubAppConfig();
  const { token: pat } = githubConfig();
  const production = process.env.NODE_ENV === "production" || !devModeEnabled();
  if (production && (app || pat)) {
    const tenantOrgId = githubTenantOrgId();
    if (!tenantOrgId) {
      throw new Error(
        "GitHub sandbox access is not assigned to a product organization; " +
          "set GITHUB_TENANT_ORG_ID to the owning organization id",
      );
    }
    if (!orgId || orgId !== tenantOrgId) {
      throw new Error("GitHub sandbox access is not available to this organization");
    }
  }

  if (app) {
    return (await getRepositoryInstallationToken(repository, app)).token;
  }

  return pat;
}

/** Resolve a personal token for agent CLI access. App credentials stay on the
 * existing App path; a deployment token must belong to the current product org. */
export async function resolveGithubAgentToken(orgId: string): Promise<string | null> {
  const personal = await githubPersonalConnection(orgId);
  if (personal) return personal.token;
  const latest = await findLatestOrgIntegrationRecord({ orgId, provider: "github", runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID });
  if (latest?.status === "revoked") return null;
  const { token } = githubConfig();
  if (!token) return null;
  const tenant = githubTenantOrgId();
  if (tenant) return tenant === orgId ? token : null;
  return process.env.NODE_ENV !== "production" && devModeEnabled() ? token : null;
}

/** Resolve the write credential used by the existing publication worker. */
export async function resolveGithubPublicationToken(
  repository: string,
  orgId: string,
): Promise<string> {
  const personal = await githubPersonalConnection(orgId);
  if (personal) return personal.token;
  const tenant = await resolveTenantGithubAuth(orgId);
  if (tenant) {
    return (
      await getRepositoryPublicationTokenForId(
        repository,
        tenant.installationId,
        tenant.app,
      )
    ).token;
  }
  const app = githubAppConfig();
  if (app) {
    const tenantOrgId = githubTenantOrgId();
    if (!tenantOrgId || tenantOrgId !== orgId) {
      throw new Error("GitHub publication access is not available to this organization");
    }
    return (await getRepositoryPublicationToken(repository, app)).token;
  }
  const { token: pat } = githubConfig();
  if (pat && (githubTenantOrgId() === orgId || (process.env.NODE_ENV !== "production" && devModeEnabled() && !githubTenantOrgId()))) return pat;
  throw new Error("GitHub publication requires a connected personal token or GitHub App");
}

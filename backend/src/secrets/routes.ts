import { Hono } from "hono";
import { SECRET_KINDS, type SecretKind } from "../db/schema";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { isReservedSecretName, isValidSecretName } from "./crypto";
import { deleteSecret, listSecretMeta, upsertSecret, upsertWorkspaceFile } from "./store";

// ---------------------------------------------------------------------------
// Org Secrets API (task #100). Org-scoped exactly like the knowledge/skills
// routes (orgScope resolves tenancy server-side; a client-supplied org is never
// trusted). Secret VALUES are write-only at this boundary: they can be set
// (PUT) and removed (DELETE) but NEVER read back - there is no value-returning
// endpoint by design. GET returns names + timestamps only.
// ---------------------------------------------------------------------------

export const secretsRoutes = new Hono<AppEnv>();

secretsRoutes.use("*", orgScope);

// List the active org's secret names + timestamps (never values).
secretsRoutes.get("/", async (c) => {
  const items = await listSecretMeta(c.get("orgId"));
  return c.json({ secrets: items });
});

// Files have a separate byte-preserving upload path and are never returned by
// the API. They are delivered only when a repository explicitly selects them.
secretsRoutes.put("/files/:name", orgAdminScope, async (c) => {
  const name = c.req.param("name");
  if (!isValidSecretName(name) || isReservedSecretName(name)) return c.json({ error: "invalid file name" }, 400);
  const maxBytes = 5 * 1024 * 1024;
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes + 65536) return c.json({ error: "file exceeds 5 MB" }, 413);
  let value: unknown;
  try { value = (await c.req.formData()).get("file"); } catch { return c.json({ error: "invalid file upload" }, 400); }
  if (!(value instanceof File)) return c.json({ error: "file is required" }, 400);
  if (value.size > maxBytes) return c.json({ error: "file exceeds 5 MB" }, 413);
  try {
    return c.json(await upsertWorkspaceFile(c.get("orgId"), name, new Uint8Array(await value.arrayBuffer())));
  } catch (error) {
    if (error instanceof Error && error.message === "A secret with this name has a different type") return c.json({ error: error.message }, 409);
    throw error;
  }
});

// Upsert a secret value by name. The name must be an env-var identifier; the
// value is encrypted at rest and the response echoes metadata only.
secretsRoutes.put("/:name", orgAdminScope, async (c) => {
  const name = c.req.param("name");
  if (!isValidSecretName(name)) {
    return c.json(
      { error: "name must match ^[A-Z][A-Z0-9_]*$ (an env-var identifier)" },
      400,
    );
  }
  if (isReservedSecretName(name)) {
    return c.json(
      { error: "name is reserved for sandbox runtime control; choose a different name" },
      400,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const value = typeof body.value === "string" ? body.value : "";
  if (!value) return c.json({ error: "value is required" }, 400);

  // `kind` is optional and defaults to "env"; an explicit unknown value is a
  // client error (matching the skills `kind` check).
  let kind: SecretKind = "env";
  if (body.kind !== undefined) {
    if (
      typeof body.kind !== "string" ||
      !(SECRET_KINDS as readonly string[]).includes(body.kind) || body.kind === "workspace_file"
    ) {
      return c.json({ error: `kind must be one of: ${SECRET_KINDS.join(", ")}` }, 400);
    }
    kind = body.kind as SecretKind;
  }

  try { return c.json(await upsertSecret(c.get("orgId"), name, value, kind)); }
  catch (error) {
    if (error instanceof Error && error.message === "A secret with this name has a different type") return c.json({ error: error.message }, 409);
    throw error;
  }
});

// Delete a secret by name (org-scoped). 404 when the org has no such secret.
secretsRoutes.delete("/:name", orgAdminScope, async (c) => {
  const name = c.req.param("name");
  const removed = await deleteSecret(c.get("orgId"), name);
  if (!removed) return c.json({ error: "secret not found" }, 404);
  return c.json({ deleted: true, name });
});

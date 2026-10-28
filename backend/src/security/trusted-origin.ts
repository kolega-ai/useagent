// Browser-authorized mutations require an explicit configured origin.
import { betterAuthTrustedOrigins } from "../env";

export function hasTrustedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try { return betterAuthTrustedOrigins().includes(new URL(origin).origin); }
  catch { return false; }
}

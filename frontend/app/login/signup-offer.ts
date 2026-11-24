import type { AuthConfig } from "@/lib/auth";

/** Where an invitation link sends a visitor who is not signed in. */
const INVITATION_PATH = "/accept-invitation/";

/**
 * What the sign-in card offers for creating an account. Invitation-only sign-up
 * is offered to someone arriving from their invitation and never as a public
 * link. An invited address is never asked for an invite code or held to the
 * domain list: the server admits it without either, so neither is shown.
 */
export function signupOffer(config: AuthConfig | null, callbackURL: string): AuthConfig["signup"] {
  const open = config?.emailPassword ? config.signup : null;
  if (!open) return null;
  const invited = callbackURL.startsWith(INVITATION_PATH);
  if (open.invitationsOnly && !invited) return null;
  return invited ? { ...open, inviteCode: false, domains: [] } : open;
}

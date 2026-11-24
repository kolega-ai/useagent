import { expect, test } from "bun:test";
import type { AuthConfig } from "@/lib/auth";
import { signupOffer } from "./signup-offer";

const base: AuthConfig = { google: false, emailPassword: true, allowDevOrg: false, invitationEmail: true, signup: null };
const open = (signup: NonNullable<AuthConfig["signup"]>): AuthConfig => ({ ...base, signup });
const INVITED = "/accept-invitation/inv_123";

test("invitations-only offers no public sign-up link", () => {
  const config = open({ inviteCode: false, domains: [], invitationsOnly: true });
  expect(signupOffer(config, "/")).toBeNull();
  expect(signupOffer(config, "/agent/new")).toBeNull();
});

test("someone arriving from their invitation is offered sign-up without a code or domain rule", () => {
  expect(signupOffer(open({ inviteCode: false, domains: [], invitationsOnly: true }), INVITED)).toEqual({
    inviteCode: false,
    domains: [],
    invitationsOnly: true,
  });
  // On a code-and-domain deployment the server admits an invited address without either.
  expect(signupOffer(open({ inviteCode: true, domains: ["acme.com"], invitationsOnly: false }), INVITED)).toEqual({
    inviteCode: false,
    domains: [],
    invitationsOnly: false,
  });
});

test("open sign-up is unchanged for everyone else, and a closed deployment offers nothing", () => {
  const coded = open({ inviteCode: true, domains: ["acme.com"], invitationsOnly: false });
  expect(signupOffer(coded, "/")).toEqual(coded.signup);
  expect(signupOffer(base, INVITED)).toBeNull();
  expect(signupOffer({ ...coded, emailPassword: false }, INVITED)).toBeNull();
  expect(signupOffer(null, "/")).toBeNull();
});

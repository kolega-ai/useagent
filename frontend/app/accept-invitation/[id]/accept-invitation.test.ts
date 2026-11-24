import { describe, expect, test } from "bun:test";
import { invitationProblem } from "./invitation-problem";

describe("invitation problems in plain words", () => {
  test("names the recipient mismatch, the expiry, membership, sign-in and connection cases", () => {
    expect(invitationProblem(403, "You are not the recipient of the invitation")).toContain(
      "different email address",
    );
    expect(invitationProblem(400, "Invitation not found")).toContain("expired or was cancelled");
    expect(invitationProblem(404, null)).toContain("expired or was cancelled");
    expect(invitationProblem(400, "User is already a member of this organization")).toContain(
      "already a member",
    );
    expect(invitationProblem(401, null)).toBe("Sign in to accept this invitation.");
    expect(invitationProblem(0, null)).toContain("Check your connection");
  });

  test("passes an unknown server message through, with a fallback when there is none", () => {
    expect(invitationProblem(500, "Something odd")).toBe("Something odd");
    expect(invitationProblem(500, null)).toBe("This invitation cannot be accepted right now.");
  });
});

import { invitedAs, slackSendersNotice } from "./accept-invitation";

test("the accept page says plainly which Slack identities joining would authorise", () => {
  expect(slackSendersNotice(undefined)).toBeNull();
  expect(slackSendersNotice([])).toBeNull();
  const one = slackSendersNotice([{ id: "r1", name: "Priya", teamId: "T1" }]);
  expect(one).toContain("Priya (Slack workspace T1)");
  expect(one).toContain("do not join");
  expect(
    slackSendersNotice([
      { id: "r1", name: "A", teamId: "T1" },
      { id: "r2", name: "B", teamId: "T2" },
    ]),
  ).toContain("these people");
});

describe("the role an invitation names", () => {
  test("a project member's invitation names the projects it opens", () => {
    expect(invitedAs({ role: "project_member", projects: ["billing"] })).toBe("a project member of billing");
    expect(invitedAs({ role: "project_member", projects: ["api", "billing", "web"] })).toBe("a project member of api, billing and web");
    expect(invitedAs({ role: "project_member" })).toBe("a project member");
  });

  test("every other role keeps its words, and anything unknown is a member", () => {
    expect([invitedAs({ role: "admin" }), invitedAs({ role: "owner" }), invitedAs({ role: "member" }), invitedAs({ role: "x" })])
      .toEqual(["an admin", "an owner", "a member", "a member"]);
  });
});

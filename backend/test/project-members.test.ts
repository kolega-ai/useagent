import { describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createOrgSession, fetchApi, joinOrg, json, testProjectId, uid, userIdOf, type OrgSession } from "./helpers";
import { member, invitation } from "../src/db/auth-schema";
import { db } from "../src/db/client";
import { invitationProjects, projectMembers, runs, schedules } from "../src/db/schema";
import { organizationLimitReached } from "../src/auth/organization-limit";
import { executeAutomationToolLocal } from "../src/knowledge/gateway/automation-tools";
import { withOrgLock } from "../src/org-lock";
import { prepareGitLabPublication } from "../src/gitlab/publication-prepare";
import { ProjectAccessError } from "../src/projects/access";
import { grantInvitationProjects } from "../src/projects/members";
import { ensureProject } from "../src/projects/repo";
import { createChildSession } from "../src/runs/child-sessions";
import { createRun } from "../src/runs/repo";
import { ensureEligiblePublicRootThreadRelationship } from "../src/runs/thread-relationship-repo";

// A project member reaches only the projects they were added to. The request
// gate refuses every other route, the lists it lets through hold only their
// projects' work, every write (automations, new threads, replies) is checked
// at the effect, and an admin's change to their projects is made in the
// organisation's turn and pauses their automations in a project taken away.

interface Workspace {
  owner: OrgSession;
  first: string;
  second: string;
  memberSession: OrgSession;
  memberId: string;
}

/** A workspace with two projects and a project member of the first. */
async function workspace(label: string): Promise<Workspace> {
  const owner = await createOrgSession(label);
  const first = await testProjectId(owner.cookies, "first");
  const second = await testProjectId(owner.cookies, "second");
  const memberSession = await joinOrg(owner, `${label}-pm`);
  const memberId = await userIdOf(memberSession);
  await db.update(member).set({ role: "project_member" })
    .where(and(eq(member.organizationId, owner.orgId), eq(member.userId, memberId)));
  await db.insert(projectMembers).values({ projectId: first, orgId: owner.orgId, userId: memberId });
  return { owner, first, second, memberSession, memberId };
}

const automationBody = (projectId: string) => ({ name: `A ${uid("a")}`, cron: "0 9 * * *", prompt: "Report.", engine: "mock", projectId });

async function thread(orgId: string, projectId: string, userId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({ id, threadId: id, parentRunId: null, prompt: "p", model: "mock", engine: "mock", orgId, userId, memoryScope: "org", repos: [], projectId });
  return id;
}

describe("project members", () => {
  test("the gate refuses every route outside their projects' work", async () => {
    const w = await workspace("pm-gate");
    for (const path of ["/api/dashboard", "/api/secrets", "/api/team/project-members", "/api/bots", "/api/memory/browse", "/api/api-keys"]) {
      const res = await fetchApi(path, { cookies: w.memberSession.cookies });
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect((await fetchApi("/api/dashboard", { cookies: w.owner.cookies })).status).not.toBe(403);
  });

  test("lists hold only their projects: projects, automations and threads", async () => {
    const w = await workspace("pm-lists");
    const mine = await json<{ id: string }>("/api/automations", { method: "POST", cookies: w.owner.cookies, body: automationBody(w.first) });
    const theirs = await json<{ id: string }>("/api/automations", { method: "POST", cookies: w.owner.cookies, body: automationBody(w.second) });
    const inFirst = await thread(w.owner.orgId, w.first);
    const inSecond = await thread(w.owner.orgId, w.second);

    const projects = await json<{ projects: { id: string }[] }>("/api/projects", { cookies: w.memberSession.cookies });
    expect(projects.body.projects.map((p) => p.id)).toEqual([w.first]);
    const automations = await json<{ automations: { id: string }[] }>("/api/automations", { cookies: w.memberSession.cookies });
    expect(automations.body.automations.map((a) => a.id)).toEqual([mine.body.id]);
    const runs = await json<{ runs: { id: string }[] }>("/api/runs?view=summary&all=1", { cookies: w.memberSession.cookies });
    expect(runs.body.runs.map((r) => r.id)).toContain(inFirst);
    expect(runs.body.runs.map((r) => r.id)).not.toContain(inSecond);
    expect((await fetchApi("/api/runs", { cookies: w.memberSession.cookies })).status).toBe(403); // only the summary view

    // One run, one automation: only inside their projects.
    expect((await fetchApi(`/api/runs/${inFirst}`, { cookies: w.memberSession.cookies })).status).toBe(200);
    expect((await fetchApi(`/api/runs/${inSecond}`, { cookies: w.memberSession.cookies })).status).toBe(403);
    expect((await fetchApi(`/api/automations/${theirs.body.id}/history`, { cookies: w.memberSession.cookies })).status).toBe(403);
    // The owner still sees everything.
    const all = await json<{ automations: { id: string }[] }>("/api/automations", { cookies: w.owner.cookies });
    expect(all.body.automations.map((a) => a.id).sort()).toEqual([mine.body.id, theirs.body.id].sort());
  });

  test("automations are made and changed only in their projects", async () => {
    const w = await workspace("pm-auto");
    const elsewhere = await json<{ error: string }>("/api/automations", { method: "POST", cookies: w.memberSession.cookies, body: automationBody(w.second) });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error).toBe("project_access_denied");
    const made = await json<{ id: string }>("/api/automations", { method: "POST", cookies: w.memberSession.cookies, body: automationBody(w.first) });
    expect(made.status).toBe(201);
    const moved = await json<{ error: string }>(`/api/automations/${made.body.id}`, {
      method: "PATCH", cookies: w.memberSession.cookies, body: { projectId: w.second },
    });
    expect(moved.status).toBe(403);
    const owners = await json<{ id: string }>("/api/automations", { method: "POST", cookies: w.owner.cookies, body: automationBody(w.second) });
    const touched = await fetchApi(`/api/automations/${owners.body.id}`, { method: "PATCH", cookies: w.memberSession.cookies, body: { enabled: false } });
    expect(touched.status).toBe(403);
  });

  test("a new thread needs one of their projects, and a reply its thread's", async () => {
    const w = await workspace("pm-threads");
    const bare = await json<{ error?: string }>("/api/runs", { method: "POST", cookies: w.memberSession.cookies, body: { prompt: "Hi", engine: "mock" } });
    expect(bare.status).toBe(403);
    expect(bare.body.error).toBe("project_access_denied");
    const elsewhere = await thread(w.owner.orgId, w.second, await userIdOf(w.owner));
    const reply = await json<{ error?: string }>("/api/runs", {
      method: "POST", cookies: w.memberSession.cookies, body: { prompt: "Continue", engine: "mock", parent_run_id: elsewhere },
    });
    expect(reply.status).toBe(403);
    const own = await thread(w.owner.orgId, w.first, w.memberId);
    const ownReply = await fetchApi("/api/runs", { method: "POST", cookies: w.memberSession.cookies, body: { prompt: "Continue", engine: "mock", parent_run_id: own } });
    expect(ownReply.status).toBe(201);

    // The thread view's composer sends to the thread's messages route.
    const message = (threadId: string) => fetchApi(`/api/threads/${threadId}/messages`, {
      method: "POST", cookies: w.memberSession.cookies, headers: { "idempotency-key": uid("msg") }, body: { text: "And the docs." },
    });
    await ensureEligiblePublicRootThreadRelationship({ orgId: w.owner.orgId, threadId: elsewhere });
    await ensureEligiblePublicRootThreadRelationship({ orgId: w.owner.orgId, threadId: own });
    expect((await message(elsewhere)).status).toBe(403);
    expect((await message(own)).status).toBe(201);
  });

  test("their agent's child thread stays in the parent's project", async () => {
    const w = await workspace("pm-child");
    const parentId = await thread(w.owner.orgId, w.first, w.memberId);
    const child = await createChildSession({
      orgId: w.owner.orgId, actorId: w.memberId, parentRunId: parentId, threadId: parentId,
      prompt: "Check the tests.", engine: "mock", model: "mock", repos: [], memoryScope: "org", idempotencyKey: uid("child"),
    });
    if (child.status === "conflict") throw new Error("child conflict");
    const [row] = await db.select({ projectId: runs.projectId, threadId: runs.threadId }).from(runs).where(eq(runs.id, child.child.id));
    expect(row).toEqual({ projectId: w.first, threadId: child.child.id });
  });

  test("someone removed from the workspace stays confined to the projects they had", async () => {
    const w = await workspace("pm-removed");
    await db.delete(member).where(and(eq(member.organizationId, w.owner.orgId), eq(member.userId, w.memberId)));
    // Work still started as them (an automation of theirs, its agent's child threads) stays in their projects.
    const child = (parentId: string) => createChildSession({
      orgId: w.owner.orgId, actorId: w.memberId, parentRunId: parentId, threadId: parentId,
      prompt: "Go on.", engine: "mock", model: "mock", repos: [], memoryScope: "org", idempotencyKey: uid("child"),
    });
    await expect(child(await thread(w.owner.orgId, w.second, w.memberId))).rejects.toBeInstanceOf(ProjectAccessError);
    expect((await child(await thread(w.owner.orgId, w.first, w.memberId))).status).toBe("created");
  });

  test("the repository routes a thread uses answer only for their projects", async () => {
    const w = await workspace("pm-repos");
    const tag = uid("r");
    const mine = await ensureProject(w.owner.orgId, `gitlab.com/group/mine-${tag}`, { repoFullName: `gitlab.com/group/mine-${tag}` });
    await ensureProject(w.owner.orgId, `gitlab.com/group/other-${tag}`, { repoFullName: `gitlab.com/group/other-${tag}` });
    await ensureProject(w.owner.orgId, `acme/other-${tag}`, { repoFullName: `acme/other-${tag}` });
    await db.insert(projectMembers).values({ projectId: mine.id, orgId: w.owner.orgId, userId: w.memberId });
    const refused = async (path: string) => {
      const res = await json<{ error?: string }>(path, { cookies: w.memberSession.cookies });
      return res.status === 403 && res.body.error === "project_member_forbidden";
    };
    expect(await refused(`/api/repos/acme/other-${tag}/tree`)).toBe(true);
    expect(await refused(`/api/gitlab/projects/${encodeURIComponent(`group/other-${tag}`)}/branches`)).toBe(true);
    expect(await refused(`/api/gitlab/projects/${encodeURIComponent(`group/mine-${tag}`)}/branches`)).toBe(false);
    const elsewhere = await thread(w.owner.orgId, w.second, await userIdOf(w.owner));
    const own = await thread(w.owner.orgId, w.first, w.memberId);
    expect(await refused(`/api/desktop-proxy/${elsewhere}/ready`)).toBe(true);
    expect(await refused(`/api/desktop-proxy/${own}/ready`)).toBe(false);
    expect(await refused(`/api/gitlab/publications/latest/${elsewhere}`)).toBe(true);
    expect(await refused("/api/sandbox-minutes")).toBe(false);

    // The GitLab picker offers only their projects' repositories; the owner sees all of them.
    const token = `glpat-${tag}`;
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ id: 21, username: "fixture-owner" });
      if (url.endsWith("/personal_access_tokens/self")) return Response.json({ active: true, scopes: ["api"] });
      if (url.includes("/projects?")) {
        return Response.json([`mine-${tag}`, `other-${tag}`].map((name, i) => ({ id: i + 1, path_with_namespace: `group/${name}`, name, visibility: "private", default_branch: "main" })));
      }
      return new Response("not found", { status: 404 });
    });
    try {
      expect((await fetchApi("/api/gitlab/connection", { method: "PUT", cookies: w.owner.cookies, body: { token } })).status).toBe(200);
      const search = (session: OrgSession) => json<{ repos: { full_name: string }[] }>(`/api/gitlab/projects?search=${tag}`, { cookies: session.cookies });
      expect((await search(w.memberSession)).body.repos.map((repo) => repo.full_name)).toEqual([`gitlab.com/group/mine-${tag}`]);
      expect((await search(w.owner)).body.repos.map((repo) => repo.full_name).sort()).toEqual([`gitlab.com/group/mine-${tag}`, `gitlab.com/group/other-${tag}`]);
    } finally { fetcher.mockRestore(); }
  });

  test("a merge request is prepared only from a thread in a project they still reach", async () => {
    const w = await workspace("pm-publish");
    const lost = await thread(w.owner.orgId, w.second, w.memberId);
    const prepare = (runId: string) => prepareGitLabPublication({
      orgId: w.owner.orgId, userId: w.memberId, runId, repository: "gitlab.com/group/repo", title: "Fix", draft: true, signal: new AbortController().signal,
    });
    await expect(prepare(lost)).rejects.toThrow("Thread is unavailable for publication.");
    // In their own project it gets past the check (this thread has no workspace to publish).
    await expect(prepare(await thread(w.owner.orgId, w.first, w.memberId))).rejects.toThrow("This thread has no retained workspace to publish.");
  });

  test("an admin sets their projects; a project taken away pauses their automations there", async () => {
    const w = await workspace("pm-set");
    const made = await json<{ id: string }>("/api/automations", { method: "POST", cookies: w.memberSession.cookies, body: automationBody(w.first) });
    await db.update(schedules).set({ enabled: true }).where(eq(schedules.id, made.body.id));

    const both = await json<{ added: number }>(`/api/team/members/${w.memberId}/projects`, {
      method: "PUT", cookies: w.owner.cookies, body: { projectIds: [w.first, w.second] },
    });
    expect(both.body).toMatchObject({ added: 1, removed: 0, paused_automations: 0 });
    const onlySecond = await json<{ paused_automations: number }>(`/api/team/members/${w.memberId}/projects`, {
      method: "PUT", cookies: w.owner.cookies, body: { projectIds: [w.second] },
    });
    expect(onlySecond.body).toMatchObject({ removed: 1, paused_automations: 1 });
    const [stored] = await db.select({ enabled: schedules.enabled }).from(schedules).where(eq(schedules.id, made.body.id));
    expect(stored?.enabled).toBe(false);
    const projects = await json<{ projects: { id: string }[] }>("/api/projects", { cookies: w.memberSession.cookies });
    expect(projects.body.projects.map((p) => p.id)).toEqual([w.second]);
    // Their automation in the project they lost can no longer be run.
    expect((await fetchApi(`/api/automations/${made.body.id}/run-now`, { method: "POST", cookies: w.memberSession.cookies })).status).toBe(403);

    // With no projects left, every list they reach is empty (not an error).
    await thread(w.owner.orgId, w.second, w.memberId);
    const none = await json<{ removed: number }>(`/api/team/members/${w.memberId}/projects`, {
      method: "PUT", cookies: w.owner.cookies, body: { projectIds: [] },
    });
    expect(none.body).toMatchObject({ removed: 1 });
    for (const [path, key] of [["/api/runs?view=summary&all=1", "runs"], ["/api/automations", "automations"], ["/api/projects", "projects"]] as const) {
      const listed = await json<Record<string, unknown[]>>(path, { cookies: w.memberSession.cookies });
      expect([path, listed.status, listed.body[key]]).toEqual([path, 200, []]);
    }

    // A workspace member is not a project member, and a project member cannot change anyone's projects.
    const colleague = await joinOrg(w.owner, "pm-set-colleague");
    const notConfined = await fetchApi(`/api/team/members/${await userIdOf(colleague)}/projects`, {
      method: "PUT", cookies: w.owner.cookies, body: { projectIds: [w.first] },
    });
    expect(notConfined.status).toBe(409);
    expect((await fetchApi(`/api/team/members/${w.memberId}/projects`, {
      method: "PUT", cookies: colleague.cookies, body: { projectIds: [w.first] },
    })).status).toBe(403);
  });

  test("an admin demoted while their change waits for the organisation's turn gets nothing done", async () => {
    const w = await workspace("pm-demote");
    const admin = await joinOrg(w.owner, "pm-demote-admin");
    const adminId = await userIdOf(admin);
    const setRole = (role: string) =>
      db.update(member).set({ role }).where(and(eq(member.organizationId, w.owner.orgId), eq(member.userId, adminId)));
    await setRole("admin");
    let release!: () => void;
    const turn = withOrgLock(w.owner.orgId, () => new Promise<void>((resolve) => { release = resolve; }));
    const changing = fetchApi(`/api/team/members/${w.memberId}/projects`, { method: "PUT", cookies: admin.cookies, body: { projectIds: [w.second] } });
    await setRole("member");
    release();
    await turn;
    expect((await changing).status).toBe(403);
    const rows = await db.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, w.memberId));
    expect(rows.map((row) => row.projectId)).toEqual([w.first]);
  });

  test("adding and removing from a project page", async () => {
    const w = await workspace("pm-page");
    const list = async () => (await json<{ members: { user_id: string }[] }>(`/api/projects/${w.second}/members`, { cookies: w.owner.cookies })).body.members;
    expect(await list()).toEqual([]);
    const added = await fetchApi(`/api/projects/${w.second}/members`, { method: "POST", cookies: w.owner.cookies, body: { email: w.memberSession.email } });
    expect(added.status).toBe(201);
    expect((await list()).map((m) => m.user_id)).toEqual([w.memberId]);
    const stranger = await fetchApi(`/api/projects/${w.second}/members`, { method: "POST", cookies: w.owner.cookies, body: { email: `${uid("nobody")}@example.com` } });
    expect(stranger.status).toBe(404);
    expect((await fetchApi(`/api/projects/${w.second}/members/${w.memberId}`, { method: "DELETE", cookies: w.owner.cookies })).status).toBe(200);
    expect(await list()).toEqual([]);
    // The project member reads the members of their own project only.
    expect((await fetchApi(`/api/projects/${w.first}/members`, { cookies: w.memberSession.cookies })).status).toBe(200);
    expect((await fetchApi(`/api/projects/${w.second}/members`, { cookies: w.memberSession.cookies })).status).toBe(403);
  });

  test("an invitation names its projects, and accepting it grants them", async () => {
    const w = await workspace("pm-invite");
    const email = `${uid("invitee")}@example.com`;
    const invite = (body: Record<string, unknown>) =>
      json<{ id?: string; message?: string }>("/api/auth/organization/invite-member", { method: "POST", cookies: w.owner.cookies, body: { email, ...body } });
    expect((await invite({ role: "project_member" })).status).toBe(400);
    expect((await invite({ role: "member", projectIds: [w.first] })).status).toBe(400);
    const made = await invite({ role: "project_member", projectIds: [w.first] });
    expect(made.status).toBe(200);
    const named = await db.select({ projectId: invitationProjects.projectId }).from(invitationProjects).where(eq(invitationProjects.invitationId, made.body.id!));
    expect(named.map((row) => row.projectId)).toEqual([w.first]);

    // Acceptance grants them to a project member (the library adds the membership).
    const invitee = await createOrgSession("pm-invitee");
    const inviteeId = await userIdOf(invitee);
    await db.insert(member).values({ id: uid("member"), organizationId: w.owner.orgId, userId: inviteeId, role: "project_member", createdAt: new Date() });
    expect(await grantInvitationProjects(w.owner.orgId, made.body.id!, inviteeId, null)).toBe(1);
    const granted = await db.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, inviteeId));
    expect(granted.map((row) => row.projectId)).toEqual([w.first]);
    const [row] = await db.select({ role: invitation.role }).from(invitation).where(eq(invitation.id, made.body.id!));
    expect(row?.role).toBe("project_member");
  });

  test("someone who is only a project member makes no workspace of their own", async () => {
    const w = await workspace("pm-org");
    // Their own sign-up workspace from the helper is removed: only the project membership remains.
    await db.delete(member).where(and(eq(member.userId, w.memberId), eq(member.role, "owner")));
    // A wide allowance, so only being confined to projects can refuse them.
    const wide = { ORG_CREATE_LIMIT_PER_USER: "10" };
    expect(await organizationLimitReached({ id: w.memberId, email: w.memberSession.email }, wide)).toBe(true);
    expect(await organizationLimitReached({ id: await userIdOf(w.owner), email: w.owner.email }, wide)).toBe(false);
  });

  test("their agent's automation tools see only their projects' automations", async () => {
    const w = await workspace("pm-agent");
    const mine = await json<{ id: string }>("/api/automations", { method: "POST", cookies: w.memberSession.cookies, body: automationBody(w.first) });
    const theirs = await json<{ id: string }>("/api/automations", { method: "POST", cookies: w.owner.cookies, body: automationBody(w.second) });
    const runId = await thread(w.owner.orgId, w.first, w.memberId);
    const claims = { orgId: w.owner.orgId, userId: w.memberId, threadId: runId, runId, scope: "run" as const, exp: Date.now() + 60_000 };
    const listed = await executeAutomationToolLocal(claims, "automation_list", {});
    const ids = JSON.stringify(listed.structuredContent ?? listed);
    expect(ids).toContain(mine.body.id);
    expect(ids).not.toContain(theirs.body.id);
    expect((await executeAutomationToolLocal(claims, "automation_get", { id: theirs.body.id })).isError).toBe(true);
  });
});

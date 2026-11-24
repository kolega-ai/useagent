import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { createOrgSession, joinOrg, json, testProjectId, uid, userIdOf } from "./helpers";
import { db } from "../src/db/client";
import { projects, runs, schedules } from "../src/db/schema";
import { executeAutomationToolLocal } from "../src/knowledge/gateway/automation-tools";
import { ensureProject } from "../src/projects/repo";
import { createRun } from "../src/runs/repo";
import { AutomationProjectError, resolveAutomationProject } from "../src/schedules/project";
import type { ApiSchedule } from "../src/schedules/repo";

// Every automation belongs to a project: the service refuses a save that names
// none, its runs land in it whether or not it works in a repository, a reply
// keeps its thread's project, an agent's automation takes its run's, the list
// filters by project and says what the viewer may do, and the migration gives
// every automation naming a repository that repository's project.

type Listed = ApiSchedule & { access?: { change: boolean; stop: boolean; reason: string | null } };
const body = (extra: Record<string, unknown> = {}) => ({ name: `Digest ${uid("a")}`, cron: "0 9 * * *", prompt: "Summarise.", engine: "mock", ...extra });

async function create(cookies: string, extra: Record<string, unknown>) {
  return json<ApiSchedule & { error?: string }>("/api/automations", { method: "POST", cookies, body: body(extra) });
}

describe("automations belong to a project", () => {
  test("a save names a project of its own workspace or is refused", async () => {
    const s = await createOrgSession("auto-project-required");
    const none = await create(s.cookies, {});
    expect(none.status).toBe(400);
    expect(none.body.error).toBe("Choose a project for this automation.");

    const other = await createOrgSession("auto-project-foreign");
    const foreign = await create(s.cookies, { projectId: await testProjectId(other.cookies) });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("That project does not exist in this workspace.");

    const projectId = await testProjectId(s.cookies);
    const made = await create(s.cookies, { projectId });
    expect(made.status).toBe(201);
    expect(made.body.project_id).toBe(projectId);
    expect(made.body.project).toEqual({ id: projectId, key: "test-project", name: "test-project", repo: null });

    // A patch that moves it re-checks; a pause alone does not touch placement.
    const moved = await json<{ error?: string }>(`/api/automations/${made.body.id}`, {
      method: "PATCH", cookies: s.cookies, body: { projectId: await testProjectId(other.cookies) },
    });
    expect(moved.status).toBe(400);
    const paused = await json<ApiSchedule>(`/api/automations/${made.body.id}`, { method: "PATCH", cookies: s.cookies, body: { enabled: false } });
    expect(paused.status).toBe(200);
    expect(paused.body.project_id).toBe(projectId);
  });

  test("an existing project is named by its repository without asking the provider", async () => {
    const s = await createOrgSession("auto-project-by-repo");
    const repo = `gitlab.com/acme/${uid("known")}`;
    const known = await ensureProject(s.orgId, repo, { repoFullName: repo });
    // No source-control connection exists here: only the existing project can answer.
    const made = await create(s.cookies, { project: repo });
    expect(made.status).toBe(201);
    expect(made.body.project).toMatchObject({ id: known.id, repo });
    expect((await create(s.cookies, { project: `acme/${uid("unknown")}` })).status).toBe(400);
  });

  test("a project's repository is the only one its automations may work in", async () => {
    const s = await createOrgSession("auto-project-repo");
    const bare = await ensureProject(s.orgId, `bare-${uid("p")}`);
    const repoProject = await ensureProject(s.orgId, `acme/${uid("repo")}`, { repoFullName: `acme/${uid("repo")}` });
    const base = { orgId: s.orgId, codePolicy: null };
    await expect(resolveAutomationProject({ ...base, body: { projectId: bare.id }, repos: ["acme/elsewhere"] }))
      .rejects.toThrow(AutomationProjectError);
    await expect(resolveAutomationProject({ ...base, body: { projectId: repoProject.id }, repos: ["acme/elsewhere:main"] }))
      .rejects.toThrow(`works only in ${repoProject.repoFullName}`);
    const own = await resolveAutomationProject({ ...base, body: { projectId: repoProject.id }, repos: [`${repoProject.repoFullName}:main`] });
    expect(own.id).toBe(repoProject.id);
    // With no explicit project, the repository names it; with nothing, the current one stays.
    expect((await resolveAutomationProject({ ...base, body: {}, repos: [`${repoProject.repoFullName}:dev`] })).id).toBe(repoProject.id);
    expect((await resolveAutomationProject({ ...base, body: {}, repos: [], currentProjectId: bare.id })).id).toBe(bare.id);
  });

  test("the list filters by project and says what each viewer may do", async () => {
    const owner = await createOrgSession("auto-project-list");
    const teammate = await joinOrg(owner, "auto-project-list-mate");
    const first = await testProjectId(owner.cookies, "first");
    const second = await testProjectId(owner.cookies, "second");
    const mine = (await create(owner.cookies, { projectId: first })).body.id;
    const elsewhere = (await create(owner.cookies, { projectId: second })).body.id;
    const theirs = (await create(teammate.cookies, { projectId: first })).body.id;

    const list = async (cookies: string, project?: string) =>
      (await json<{ automations: Listed[] }>(`/api/automations${project ? `?project=${encodeURIComponent(project)}` : ""}`, { cookies })).body.automations;
    expect((await list(owner.cookies, first)).map((item) => item.id).sort()).toEqual([mine, theirs].sort());
    expect((await list(owner.cookies, "second")).map((item) => item.id)).toEqual([elsewhere]); // by key
    expect(await list(owner.cookies, "no-such-project")).toEqual([]);

    const asOwner = new Map((await list(owner.cookies)).map((item) => [item.id, item.access]));
    expect(asOwner.get(mine)).toEqual({ change: true, stop: true, reason: null });
    expect(asOwner.get(theirs)).toMatchObject({ change: false, stop: true });
    expect(asOwner.get(theirs)?.reason).toEndWith("Only they can change it or run it now. You can pause or delete it.");
    const asTeammate = new Map((await list(teammate.cookies)).map((item) => [item.id, item.access]));
    expect(asTeammate.get(theirs)).toEqual({ change: true, stop: true, reason: null });
    expect(asTeammate.get(mine)).toMatchObject({ change: false, stop: false });
    expect(asTeammate.get(mine)?.reason).toStartWith("Runs as ");
    expect(asTeammate.get(mine)?.reason).not.toContain("pause");
  });

  test("a run an automation starts lands in its project, with no repository", async () => {
    const s = await createOrgSession("auto-project-run");
    const projectId = await testProjectId(s.cookies);
    const made = await create(s.cookies, { projectId });
    const fired = await json<{ run_id: string }>(`/api/automations/${made.body.id}/run-now`, { method: "POST", cookies: s.cookies });
    expect(fired.status).toBe(201);
    const [run] = await db.select({ projectId: runs.projectId, repos: runs.repos }).from(runs).where(eq(runs.id, fired.body.run_id));
    expect(run).toEqual({ projectId, repos: [] });
  });

  test("a reply keeps its thread's project whatever repository it names", async () => {
    const s = await createOrgSession("auto-project-reply");
    const projectId = await testProjectId(s.cookies);
    const root = crypto.randomUUID();
    const reply = crypto.randomUUID();
    const base = { prompt: "p", model: "mock", engine: "mock" as const, orgId: s.orgId, userId: null, memoryScope: "org" as const };
    await createRun({ ...base, id: root, threadId: root, parentRunId: null, repos: [], projectId });
    await createRun({ ...base, id: reply, threadId: root, parentRunId: root, repos: [`acme/${uid("other")}`] });
    const rows = await db.select({ id: runs.id, projectId: runs.projectId }).from(runs).where(eq(runs.threadId, root));
    expect(rows.map((row) => row.projectId)).toEqual([projectId, projectId]);
  });

  test("an agent's automation lands in its run's project unless it names one", async () => {
    const s = await createOrgSession("auto-project-agent");
    const projectId = await testProjectId(s.cookies);
    const runId = crypto.randomUUID();
    const userId = await userIdOf(s);
    await createRun({ id: runId, threadId: runId, parentRunId: null, prompt: "p", model: "mock", engine: "mock", orgId: s.orgId, userId,
      memoryScope: "org", repos: [], projectId });
    const name = `Agent made ${uid("a")}`;
    const result = await executeAutomationToolLocal(
      { orgId: s.orgId, userId, threadId: runId, runId, scope: "run", exp: Date.now() + 60_000 },
      "automation_create",
      { name, cron: "0 9 * * *", prompt: "Check the queue." },
    );
    expect(result.isError).toBeFalsy();
    const [saved] = await db.select({ projectId: schedules.projectId }).from(schedules)
      .where(and(eq(schedules.orgId, s.orgId), eq(schedules.name, name)));
    expect(saved?.projectId).toBe(projectId);
  });

  test("the migration gives every automation naming a repository that repository's project", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const tag = uid("mig").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const existing = await ensureProject(orgId, `acme/existing-${tag}`, { repoFullName: `acme/existing-${tag}` });
    const legacy = (repos: string[]) => ({ orgId, name: `legacy ${tag}`, cron: "0 9 * * *", timezone: "UTC", prompt: "p", engine: "mock" as const, repos });
    const [fresh, known, bare] = await db.insert(schedules).values([
      legacy([`acme/fresh-${tag}:main`]),
      legacy([`acme/existing-${tag}`]),
      legacy([]),
    ]).returning({ id: schedules.id });

    const statements = readFileSync(new URL("../drizzle/0123_automation_projects.sql", import.meta.url), "utf8").split("--> statement-breakpoint");
    for (const statement of statements) await db.execute(sql.raw(statement));

    const placed = new Map((await db.select({ id: schedules.id, projectId: schedules.projectId }).from(schedules).where(eq(schedules.orgId, orgId)))
      .map((row) => [row.id, row.projectId]));
    const [made] = await db.select().from(projects).where(and(eq(projects.orgId, orgId), eq(projects.repoFullName, `acme/fresh-${tag}`)));
    expect(made).toMatchObject({ key: `acme/fresh-${tag}`, displayName: `fresh-${tag}` });
    expect(placed.get(fresh!.id)).toBe(made!.id);
    expect(placed.get(known!.id)).toBe(existing.id);
    expect(placed.get(bare!.id)).toBeNull();
    expect(await db.select().from(projects).where(eq(projects.orgId, orgId))).toHaveLength(2);
  });
});

// The project an automation belongs to. Every automation saved has one: its
// runs land in it, and any repository work it does stays inside it. The rule
// lives here, under the automation service, so every door that saves an
// automation (the automations API, a bot's routines, an agent's automation
// tools) gets it.
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { type AutomationCodePolicy, projects } from "../db/schema";
import { parseRepoRef } from "../github/repo-ref";
import { ensureProject, type ProjectRecord } from "../projects/repo";
import { createRunResourceAuthorization } from "../resources/authorization";
import { explicitRepositoryResources, resolveRunIntake, RunIntakeError } from "../resources/run-intake";

/** A project that cannot be the automation's, with a message for the person. */
export class AutomationProjectError extends Error {}

export const PROJECT_REQUIRED = "Choose a project for this automation.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An existing project of the org by id, or by repository (or key). Never creates one. */
export async function findOrgProject(orgId: string, ref: string): Promise<ProjectRecord | null> {
  const value = ref.trim();
  if (!value) return null;
  const by = UUID.test(value) ? eq(projects.id, value) : eq(projects.repoFullName, parseRepoRef(value).repo);
  const [row] = await db.select().from(projects).where(and(eq(projects.orgId, orgId), by)).limit(1);
  if (row || UUID.test(value)) return row ?? null;
  const [byKey] = await db.select().from(projects).where(and(eq(projects.orgId, orgId), eq(projects.key, value))).limit(1);
  return byKey ?? null;
}

/** A repository the org can reach becomes its project, made as run acceptance makes one. */
async function repositoryProject(orgId: string, repository: string, authorize: boolean): Promise<ProjectRecord> {
  const repo = parseRepoRef(repository).repo;
  if (authorize) {
    try {
      await resolveRunIntake({ source: "automation", text: "", explicitResources: explicitRepositoryResources([repo]) },
        { authorize: createRunResourceAuthorization(orgId) });
    } catch (error) {
      if (error instanceof RunIntakeError) throw new AutomationProjectError(error.message);
      throw error;
    }
  }
  return ensureProject(orgId, repo, { repoFullName: repo });
}

/**
 * The project an automation saved with these fields belongs to. An explicit
 * `projectId` (an existing project) or `project` (a repository, resolved and
 * authorized like a run's) wins; otherwise the automation's repository names
 * it; otherwise it keeps the project it has. Its repositories and repository
 * work must then be the project's own.
 */
export async function resolveAutomationProject(input: {
  readonly orgId: string;
  readonly body: Record<string, unknown>;
  /** Already authorized repositories (parseRepos). */
  readonly repos: readonly string[];
  readonly codePolicy: AutomationCodePolicy | null;
  readonly currentProjectId?: string | null;
}): Promise<ProjectRecord> {
  const { orgId, body } = input;
  let project: ProjectRecord | null = null;
  if (typeof body.projectId === "string" && body.projectId.trim()) {
    const id = body.projectId.trim();
    project = UUID.test(id) ? await findOrgProject(orgId, id) : null;
    if (!project) throw new AutomationProjectError("That project does not exist in this workspace.");
  } else if (typeof body.project === "string" && body.project.trim()) {
    // An existing project of the workspace, else a repository it can reach.
    project = (await findOrgProject(orgId, body.project.trim())) ?? (await repositoryProject(orgId, body.project.trim(), true));
  } else if (input.repos[0]) {
    project = await repositoryProject(orgId, input.repos[0], false);
  } else if (input.codePolicy) {
    project = await repositoryProject(orgId, input.codePolicy.repository, true);
  } else if (input.currentProjectId) {
    project = await findOrgProject(orgId, input.currentProjectId);
  }
  if (!project) throw new AutomationProjectError(PROJECT_REQUIRED);

  const own = project.repoFullName;
  const foreign = input.repos.map((entry) => parseRepoRef(entry).repo).find((repo) => repo !== own);
  if (foreign || (input.codePolicy && input.codePolicy.repository !== own)) {
    throw new AutomationProjectError(own
      ? `An automation in ${project.displayName} works only in ${own}.`
      : `${project.displayName} has no repository, so its automations cannot work in one.`);
  }
  return project;
}

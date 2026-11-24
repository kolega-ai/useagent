// The request gate for project members (middleware/org.ts asks it once who is
// asking is known). Deny by default: a project member reaches only the routes
// listed here, and a route about one run, thread, artifact, automation or
// approval answers only when that work is in a project they reach. The lists
// it lets through are filtered by their handlers with the scope the gate
// leaves on the request (c.get("projectScope")). Owners, admins and members
// never come here.
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { artifacts, gatewayApprovalRequests, githubChangeSets, projects, runs, schedules } from "../db/schema";
import { parseRepoRef } from "../github/repo-ref";
import { GITLAB_REPOSITORY_PREFIX } from "../resources/gitlab-resolver";
import { type ProjectScope, scopeReaches } from "./access";

type Check = (orgId: string, scope: ProjectScope, match: RegExpMatchArray, url: URL) => Promise<boolean>;
interface Rule {
  readonly methods: readonly string[] | "any";
  readonly pattern: RegExp;
  readonly check?: Check;
}

async function threadReach(orgId: string, scope: ProjectScope, threadId: string | null | undefined): Promise<boolean> {
  if (!threadId) return false;
  // A thread's project is its root run's: every reply carries the same one.
  const [root] = await db.select({ projectId: runs.projectId }).from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, threadId))).limit(1);
  return Boolean(root) && scopeReaches(scope, root!.projectId);
}

async function runReach(orgId: string, scope: ProjectScope, runId: string | null | undefined): Promise<boolean> {
  if (!runId) return false;
  const [run] = await db.select({ projectId: runs.projectId }).from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, decodeURIComponent(runId)))).limit(1);
  return Boolean(run) && scopeReaches(scope, run!.projectId);
}

async function repoReach(orgId: string, scope: ProjectScope, repository: string | null): Promise<boolean> {
  if (!repository) return false;
  const [project] = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.repoFullName, parseRepoRef(repository).repo))).limit(1);
  return Boolean(project) && scopeReaches(scope, project!.id);
}

const automationReach: Check = async (orgId, scope, match) => {
  const [automation] = await db.select({ projectId: schedules.projectId }).from(schedules)
    .where(and(eq(schedules.orgId, orgId), eq(schedules.id, match[1]!))).limit(1);
  return Boolean(automation) && scopeReaches(scope, automation!.projectId);
};

const AUTOMATIONS = "(?:automations|schedules)";

const RULES: readonly Rule[] = [
  { methods: ["GET"], pattern: /^\/api\/team\/workspaces$/ },
  // Projects and repositories: lists filtered to their projects.
  { methods: ["GET"], pattern: /^\/api\/projects$/ },
  { methods: ["GET"], pattern: /^\/api\/repos$/ },
  { methods: ["GET"], pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/(?:branches|tree)$/, check: (o, s, m) => repoReach(o, s, `${m[1]}/${m[2]}`) },
  { methods: ["GET"], pattern: /^\/api\/gitlab\/projects$/ },
  {
    methods: ["GET"],
    pattern: /^\/api\/gitlab\/projects\/([^/]+)\/branches$/,
    check: (o, s, m) => repoReach(o, s, `${GITLAB_REPOSITORY_PREFIX}${decodeURIComponent(m[1]!)}`),
  },
  { methods: ["GET"], pattern: /^\/api\/projects\/repository-requests$/, check: (o, s, _m, u) => repoReach(o, s, u.searchParams.get("repo")) },
  { methods: ["GET"], pattern: /^\/api\/projects\/([^/]+)\/members$/, check: async (_o, s, m) => scopeReaches(s, m[1]) },
  // Automations: the list is filtered; every change is checked by the automation service.
  { methods: ["GET", "POST"], pattern: new RegExp(`^/api/${AUTOMATIONS}$`) },
  { methods: ["GET"], pattern: new RegExp(`^/api/${AUTOMATIONS}/preview$`) },
  { methods: ["PATCH", "DELETE"], pattern: new RegExp(`^/api/${AUTOMATIONS}/([^/]+)$`), check: automationReach },
  { methods: ["POST"], pattern: new RegExp(`^/api/${AUTOMATIONS}/([^/]+)/run-now$`), check: automationReach },
  { methods: ["GET"], pattern: new RegExp(`^/api/${AUTOMATIONS}/([^/]+)/history$`), check: automationReach },
  // Threads and runs: the list is filtered, a new thread is checked at acceptance,
  // and everything about one run answers only inside their projects.
  { methods: ["GET", "POST"], pattern: /^\/api\/runs$/ },
  { methods: ["GET"], pattern: /^\/api\/runs\/changes$/ },
  { methods: "any", pattern: /^\/api\/runs\/([^/]+)(?:\/.*)?$/, check: (o, s, m) => runReach(o, s, m[1]) },
  { methods: ["GET"], pattern: /^\/api\/threads\/relationships$/ },
  { methods: "any", pattern: /^\/api\/threads\/([^/]+)\/(?:messages|relationship|children|continue-native-child)$/, check: (o, s, m) => threadReach(o, s, decodeURIComponent(m[1]!)) },
  { methods: ["GET"], pattern: /^\/api\/artifacts$/, check: (o, s, _m, u) => threadReach(o, s, u.searchParams.get("thread_id")) },
  { methods: ["GET"], pattern: /^\/api\/artifacts\/runs\/([^/]+)\/archive$/, check: (o, s, m) => runReach(o, s, m[1]) },
  {
    methods: ["GET", "POST"],
    pattern: /^\/api\/artifacts\/([^/]+)(?:\/.*)?$/,
    check: async (orgId, scope, match) => {
      const [artifact] = await db.select({ threadId: artifacts.threadId }).from(artifacts)
        .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, decodeURIComponent(match[1]!)))).limit(1);
      return threadReach(orgId, scope, artifact?.threadId);
    },
  },
  {
    methods: ["GET"],
    pattern: /^\/api\/gateway\/approvals\/requests$/,
    check: (orgId, scope, _m, url) => url.searchParams.get("runId")
      ? runReach(orgId, scope, url.searchParams.get("runId"))
      : threadReach(orgId, scope, url.searchParams.get("threadId")),
  },
  {
    methods: ["POST"],
    pattern: /^\/api\/gateway\/approvals\/requests\/([^/]+)\/(?:approve|deny)$/,
    check: async (orgId, scope, match) => {
      const [request] = await db.select({ threadId: gatewayApprovalRequests.threadId }).from(gatewayApprovalRequests)
        .where(and(eq(gatewayApprovalRequests.orgId, orgId), eq(gatewayApprovalRequests.id, decodeURIComponent(match[1]!)))).limit(1);
      return threadReach(orgId, scope, request?.threadId);
    },
  },
  // Merge requests from their own threads (the routes check the author; prepare checks the run's project).
  { methods: ["GET"], pattern: /^\/api\/gitlab\/publications\/latest\/([^/]+)$/, check: (o, s, m) => runReach(o, s, m[1]) },
  { methods: ["POST"], pattern: /^\/api\/gitlab\/publications\/prepare$/ },
  {
    methods: ["GET", "POST"],
    pattern: /^\/api\/gitlab\/publications\/([^/]+)(?:\/patch|\/publish)?$/,
    check: async (orgId, scope, match) => {
      const [changeSet] = await db.select({ threadId: githubChangeSets.threadId }).from(githubChangeSets)
        .where(and(eq(githubChangeSets.orgId, orgId), eq(githubChangeSets.id, decodeURIComponent(match[1]!)))).limit(1);
      return threadReach(orgId, scope, changeSet?.threadId);
    },
  },
  // The desktop of a thread's sandbox.
  { methods: "any", pattern: /^\/api\/desktop-proxy\/([^/]+)(?:\/.*)?$/, check: (o, s, m) => threadReach(o, s, decodeURIComponent(m[1]!)) },
  // Their own uploads (the upload routes check the owner), their own sandbox minutes, and catalogs the composer reads.
  { methods: ["GET"], pattern: /^\/api\/sandbox-minutes$/ },
  { methods: ["POST"], pattern: /^\/api\/uploads$/ },
  { methods: ["GET", "DELETE"], pattern: /^\/api\/uploads\/[^/]+(?:\/content)?$/ },
  { methods: ["GET"], pattern: /^\/api\/capabilities$/ },
  { methods: ["GET"], pattern: /^\/api\/commands$/ },
  { methods: ["GET"], pattern: /^\/api\/skills$/ },
  { methods: "any", pattern: /^\/api\/sandbox-preference$/ },
];

/** Whether a project member may make this request. Unknown routes are refused. */
export async function projectMemberMayRequest(orgId: string, scope: ProjectScope, method: string, url: URL): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  for (const rule of RULES) {
    const match = path.match(rule.pattern);
    if (!match) continue;
    if (rule.methods !== "any" && !rule.methods.includes(method.toUpperCase())) continue;
    return rule.check ? rule.check(orgId, scope, match, url) : true;
  }
  return false;
}

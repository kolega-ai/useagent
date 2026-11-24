import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects";

// Project membership. A workspace member whose role is "project_member" reaches
// only the projects listed for them here (projects/access.ts); owners, admins
// and members reach every project and need no rows. An invitation with the
// project-member role names the projects it grants, copied into project_members
// when it is accepted. user_id and invitation_id reference the auth tables
// (drizzle/0124_project_members.sql); a row outlives nothing it points at.
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("idx_project_members_org_user").on(t.orgId, t.userId),
  ],
);

export const invitationProjects = pgTable(
  "invitation_projects",
  {
    invitationId: text("invitation_id").notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.invitationId, t.projectId] })],
);

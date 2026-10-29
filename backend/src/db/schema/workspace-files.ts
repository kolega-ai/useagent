import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Immutable encrypted file versions let a retained or recreated thread keep
// its original file even when the named file is replaced for new threads.
export const workspaceFileVersions = pgTable("workspace_file_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  valueCiphertext: text("value_ciphertext").notNull(),
  iv: text("iv").notNull(),
  tag: text("tag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("idx_workspace_file_versions_org_name").on(t.orgId, t.name)]);

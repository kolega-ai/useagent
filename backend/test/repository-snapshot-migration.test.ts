import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const adminUrl = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

test("the previous deployment upgrades without changing existing projects or sandbox bindings", async () => {
  const migrations = `${import.meta.dir}/../drizzle`;
  const partial = await mkdtemp(join(tmpdir(), "useagent-snapshot-migration-"));
  const name = `useagent_snapshot_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const admin = postgres(adminUrl, { max: 1 });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  let client: ReturnType<typeof postgres> | null = null;
  try {
    const journal = JSON.parse(await Bun.file(`${migrations}/meta/_journal.json`).text()) as {
      entries: Array<{ tag: string; when: number; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    const index = journal.entries.findIndex((entry) => entry.tag === "0115_repository_snapshots");
    expect(index).toBeGreaterThan(0);
    expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
    const entries = journal.entries.slice(0, index);
    await mkdir(join(partial, "meta"), { recursive: true });
    await Bun.write(join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) await Bun.write(join(partial, `${entry.tag}.sql`), Bun.file(`${migrations}/${entry.tag}.sql`));
    await admin.unsafe(`create database "${name}"`);
    client = postgres(url.toString(), { max: 1, connection: { "useagent.backend_time_zone": "UTC" } });
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: partial });
    await client.unsafe(`insert into projects (org_id, key, display_name, repo_full_name) values ('legacy-org', 'a/b', 'B', 'a/b')`);
    await client.unsafe(`insert into runs (id, org_id, prompt, model, engine, status, thread_id, sandbox_id, sandbox_provider) values ('legacy', 'legacy-org', 'task', 'mock', 'mock', 'completed', 'legacy', 'retained', 'daytona')`);
    await migrate(db, { migrationsFolder: migrations });
    const projects = await client.unsafe(`select key, repo_full_name, daytona_snapshot, cube_snapshot, box_snapshot, e2b_template, local_image from projects where org_id = 'legacy-org'`);
    const runs = await client.unsafe(`select sandbox_id, sandbox_provider, repository_snapshot, sandbox_snapshot, repository_cube_snapshot, repository_box_snapshot, repository_e2b_template, repository_local_image from runs where id = 'legacy'`);
    expect([...projects]).toEqual([{ key: "a/b", repo_full_name: "a/b", daytona_snapshot: null, cube_snapshot: null, box_snapshot: null, e2b_template: null, local_image: null }]);
    expect([...runs]).toEqual([{ sandbox_id: "retained", sandbox_provider: "daytona", repository_snapshot: null, sandbox_snapshot: null, repository_cube_snapshot: null, repository_box_snapshot: null, repository_e2b_template: null, repository_local_image: null }]);
  } finally {
    if (client) await client.end();
    await admin.unsafe(`drop database if exists "${name}"`).catch(() => {});
    await admin.end();
    await rm(partial, { recursive: true, force: true });
  }
}, 60_000);

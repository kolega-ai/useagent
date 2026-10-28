import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { claimDue, markDead, markForRetry, resetStuck, type OutboxTable } from "../src/db/outbox";
import "./helpers";

test("an outbox claim has a new fence after recovery and stale workers cannot settle it", async () => {
  const table: OutboxTable = { table: "test_outbox_claim_fence", key: "id", stateColumn: "state", attemptColumn: "attempt_count",
    pending: "pending", claimed: "processing", dead: "dead", claimTokenColumn: "claim_token" };
  await db.execute(sql`create table test_outbox_claim_fence (id text primary key, state text not null default 'pending',
    attempt_count integer not null default 0, max_attempts integer not null default 3, next_attempt_at timestamptz not null default now(),
    last_error text, updated_at timestamptz not null default now(), claim_token uuid)`);
  try {
    await db.execute(sql`insert into test_outbox_claim_fence (id) values ('one')`);
    const [first] = await claimDue(table, 1);
    expect(first?.id).toBe("one");
    const oldToken = String(first?.claim_token);
    expect(oldToken).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await resetStuck(table)).toBe(1);
    const [second] = await claimDue(table, 1);
    const newToken = String(second?.claim_token);
    expect(newToken).not.toBe(oldToken);
    await markForRetry(table, "one", new Date(), "stale", oldToken);
    await markDead(table, "one", "stale", undefined, oldToken);
    let [row] = await db.execute(sql`select state, attempt_count from test_outbox_claim_fence where id = 'one'`);
    expect(row).toMatchObject({ state: "processing", attempt_count: 0 });
    await markDead(table, "one", "current", undefined, newToken);
    [row] = await db.execute(sql`select state, attempt_count from test_outbox_claim_fence where id = 'one'`);
    expect(row).toMatchObject({ state: "dead", attempt_count: 1 });
  } finally { await db.execute(sql`drop table test_outbox_claim_fence`); }
});

import { sql, type SQLWrapper } from "drizzle-orm";

import { runs } from "../db/schema";
import { AUTOMATION_RUN_ORIGIN } from "./origin";

/** Product-created automation runs are visible; unknown and internal origins
 * stay private. Accept an alias for the compact summary's raw SQL query. */
export function publicRunCondition(origin: SQLWrapper = runs.origin) {
  return sql`(${origin} is null or ${origin} = ${AUTOMATION_RUN_ORIGIN})`;
}

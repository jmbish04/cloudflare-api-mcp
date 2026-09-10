/**
 * Drizzle client for the CI/CD D1 database.
 *
 * The binding is always passed in, never imported, so every query in
 * `lib/cicd-state.ts` and `lib/patterns.ts` stays testable against a local D1.
 */

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import * as schema from './schema'

export type Db = DrizzleD1Database<typeof schema>

export function getDb(binding: D1Database): Db {
  return drizzle(binding, { schema })
}

export { schema }

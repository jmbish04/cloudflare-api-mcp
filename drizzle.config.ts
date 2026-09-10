import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit config for the CI/CD D1 database.
 *
 * `out` is the same `migrations/` directory wrangler applies, and drizzle-kit
 * writes flat `NNNN_name.sql` files there, so the default D1 discovery glob
 * (`migrations/*.sql`) picks them up with no `migrations_pattern` needed.
 * Generate with `pnpm run db:generate`, apply with `pnpm run db:migrate`.
 */
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema.ts',
  out: './migrations'
})

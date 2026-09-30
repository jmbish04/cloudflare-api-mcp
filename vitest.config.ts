import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // wrangler.jsonc's `main` is src/worker.ts, which re-exports Astro's
      // handler; that imports `virtual:astro-cloudflare:*` modules only the Astro
      // build can resolve, and the pool loads `main` for every test file. The
      // RPC entrypoint module is the part of the entry these tests can load, and
      // loading it here proves it resolves in workerd without Astro.
      main: './src/rpc/cloudflare-ops.ts',
      miniflare: {
        bindings: {
          UPSTREAM_MCP_URL: 'https://mcp.cloudflare.com/mcp'
        },
        // Override the (remote) CICD_DB binding with a local, in-memory D1 so the
        // lease tests exercise real SQL without touching the production database.
        d1Databases: { CICD_DB: 'test-cicd-db' }
      }
    })
  ],
  test: {
    globals: true,
    include: ['tests/**/*.test.ts']
  }
})

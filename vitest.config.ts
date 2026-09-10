import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
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

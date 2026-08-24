import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          UPSTREAM_MCP_URL: 'https://mcp.cloudflare.com/mcp'
        }
      }
    })
  ],
  test: {
    globals: true,
    include: ['tests/**/*.test.ts']
  }
})

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Vite's `?raw` imports (used to load the D1 migration into a test database).
declare module '*.sql?raw' {
  const content: string
  export default content
}

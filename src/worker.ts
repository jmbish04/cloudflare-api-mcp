/**
 * The Worker entry — Astro's handler plus a named RPC entrypoint.
 *
 * @astrojs/cloudflare 14 builds with @cloudflare/vite-plugin and takes the entry
 * from `main` in wrangler.jsonc, defaulting to its own
 * `@astrojs/cloudflare/entrypoints/server` (a default export with `fetch` and
 * nothing else). This file keeps that exact default export, so request serving
 * is unchanged, and adds `CloudflareOps` beside it so a service binding with
 * `entrypoint: "CloudflareOps"` can reach it. The build still emits
 * `dist/server/entry.mjs`, which is what `pnpm run deploy` passes to wrangler.
 */

export { default } from '@astrojs/cloudflare/entrypoints/server'
export { CloudflareOps } from './rpc/cloudflare-ops'

import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  output: 'server',
  trailingSlash: 'never',
  // OAuth /token + /register receive cross-origin form POSTs from Claude; Astro's
  // default checkOrigin CSRF guard rejects them. The endpoints are public OAuth
  // routes, so origin-checking them is wrong. ponytail: global, only knob Astro exposes.
  security: { checkOrigin: false },
  adapter: cloudflare({
    imageService: 'passthrough'
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()]
  }
})

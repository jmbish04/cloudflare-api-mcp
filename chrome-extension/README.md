# Cloudflare UI & Worker Error Watcher

A Chrome extension that watches `*.hacolby.workers.dev` and `*.hacolby.app` for React,
Astro island and library errors, stores them locally, and posts them to this repo's
Worker at `/api/logs`.

## Loading it

The popup is built; the rest of the extension is not. **Build first, then load `dist/`.**

```bash
cd chrome-extension
pnpm install
pnpm run build
```

Then in Chrome: `chrome://extensions` → Developer mode → Load unpacked →
`chrome-extension/dist`.

`dist/` is gitignored. Loading the `chrome-extension/` folder itself does not work —
there is no popup HTML there to load.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | the popup, built by Vite into `dist/popup/` — React 19, Tailwind v4, ReUI |
| `manifest.json` | hand-written, copied into `dist/` unchanged |
| `background/service-worker.js` | hand-written MV3 service worker, copied unchanged |
| `content/` | the two content scripts, copied unchanged |
| `scripts/copy-static.mjs` | copies the four unbuilt parts above into `dist/` |
| `scripts/ui-guard.mjs` | fails the build on the frontend standard's checkable rules |
| `scripts/selfcheck-report.mjs` | pins the clipboard markdown against the pre-ReUI output |

Only `src/` is built. Never hand-edit anything under `dist/` — the next build overwrites it.

## Checks

```bash
pnpm run ui-guard     # 0 violations expected
pnpm run selfcheck    # the clipboard report must not drift
pnpm run typecheck
pnpm run build        # runs ui-guard and selfcheck first
```

To prove `selfcheck` can fail, change a template string in `src/popup/report.ts` and run
it again. It should go red, naming which formatter drifted.

## Frontend

Built on ReUI, following `.agents/ecosystem/AGENTS-frontend.md`: ReUI and shadcn
primitives only, semantic tokens only, the default ReUI theme dark by default with a
header toggle. The components under `src/components/reui/` and `src/components/ui/` are
the same copies `colby-chrome-ext` and `core-chrome-logs` ship, so the three extensions
read as one product.

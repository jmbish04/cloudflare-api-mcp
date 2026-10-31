/**
 * Copies the parts of the unpacked extension that are not built — the manifest, the
 * icons, the MV3 service worker and the two content scripts — from this folder into
 * `dist/`, beside the popup Vite just emitted. `dist/` is what you load unpacked.
 *
 * These files are hand-written sources, not build output; nothing here rewrites them.
 */
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");

const STATIC = ["manifest.json", "icons", "background", "content"];

await mkdir(dist, { recursive: true });

for (const entry of STATIC) {
  const from = join(root, entry);
  await access(from); // throws, loudly, if a required part of the extension is missing
  await cp(from, join(dist, entry), { recursive: true });
  console.log(`copied ${entry} -> dist/${entry}`);
}

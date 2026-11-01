/**
 * Pins the clipboard markdown against the pre-ReUI implementation.
 *
 * The copy blocks are the point of this extension — they get pasted into a coding
 * agent — so the UI rebuild must not change a byte of them. `reference` below is the
 * formatter set copied verbatim from the popup.js that shipped on main before the
 * rebuild. The check runs both over the same fixture and compares.
 *
 * Run: node scripts/selfcheck-report.mjs
 * Prove it can fail: change a template string in src/popup/report.ts and run it again.
 */
import assert from "node:assert/strict";
import {
  extractWorkerInfo,
  groupLogsByWorker,
  formatErrorMarkdown,
  formatWorkerMarkdown,
  formatAllErrorsMarkdown,
} from "../src/popup/report.ts";

// --- reference: verbatim from the old chrome-extension/popup/popup.js -------------
const reference = (() => {
  function extractWorkerInfo(urlStr) {
    try {
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname;
      let workerName = hostname
        .replace(/\.hacolby\.workers\.dev$/i, "")
        .replace(/\.hacolby\.app$/i, "");
      return { workerName: workerName || hostname, hostname: hostname, pathname: parsed.pathname };
    } catch {
      return { workerName: urlStr || "unknown-worker", hostname: urlStr || "unknown-host", pathname: "" };
    }
  }
  function groupLogsByWorker(logs) {
    const groups = {};
    for (const log of logs) {
      const { hostname, workerName } = extractWorkerInfo(log.url);
      const key = hostname;
      if (!groups[key]) groups[key] = { hostname, workerName, logs: [] };
      groups[key].logs.push(log);
    }
    return Object.values(groups);
  }
  function formatErrorMarkdown(log, idx) {
    const timeStr = new Date(log.timestamp || Date.now()).toISOString();
    const category = log.category || "console-error";
    let md = `#### Error ${idx + 1} [${category}]\n`;
    md += `- **Timestamp:** ${timeStr}\n`;
    md += `- **Page URL:** ${log.url}\n`;
    md += `- **Message:** ${log.message}\n`;
    if (log.metadata && Object.keys(log.metadata).length > 0) {
      md += `- **Metadata:** \`${JSON.stringify(log.metadata)}\`\n`;
    }
    if (log.stack) {
      md += `\n**Stack Trace:**\n\`\`\`text\n${log.stack}\n\`\`\`\n`;
    } else {
      md += `\n*No stack trace available*\n`;
    }
    return md;
  }
  function formatWorkerMarkdown(group) {
    let md = `## Cloudflare Worker Errors: ${group.workerName}\n`;
    md += `- **Host:** ${group.hostname}\n`;
    md += `- **Total Errors:** ${group.logs.length}\n`;
    md += `- **Report Generated:** ${new Date().toISOString()}\n\n`;
    group.logs.forEach((log, i) => {
      md += formatErrorMarkdown(log, i) + "\n---\n\n";
    });
    return md;
  }
  function formatAllErrorsMarkdown(logs) {
    const groups = groupLogsByWorker(logs);
    let md = `# Cloudflare Worker Console Errors Report for AI Coding Agent\n\n`;
    md += `> Paste this report to your coding agent to fix runtime and build errors across Cloudflare Workers.\n\n`;
    md += `- **Total Monitored Errors:** ${logs.length}\n`;
    md += `- **Total Affected Workers:** ${groups.length}\n`;
    md += `- **Timestamp:** ${new Date().toISOString()}\n\n`;
    groups.forEach((group) => {
      md += `============================================================\n`;
      md += formatWorkerMarkdown(group);
    });
    return md;
  }
  return { extractWorkerInfo, groupLogsByWorker, formatErrorMarkdown, formatWorkerMarkdown, formatAllErrorsMarkdown };
})();

// --- fixture: the awkward rows, not the happy path -------------------------------
const FIXTURE = [
  {
    id: "a", url: "https://colby-maestro.hacolby.workers.dev/overview",
    message: "TypeError: x is not a function", stack: "at f (a.js:1:1)\nat g (b.js:2:2)",
    category: "react", metadata: { component: "Overview" }, timestamp: 1_700_000_000_000, posted: true,
  },
  // no stack, no metadata, no category: every optional branch off at once
  { id: "b", url: "https://colby-maestro.hacolby.workers.dev/settings", message: "Plain console error", timestamp: 1_700_000_001_000 },
  // empty metadata object must NOT produce a Metadata line
  { id: "c", url: "https://agents.hacolby.app/", message: "Astro island hydration failure", stack: null, category: "astro-island", metadata: {}, timestamp: 1_700_000_002_000 },
  // a url the URL constructor rejects, so extractWorkerInfo takes its catch branch
  { id: "d", url: "not a url at all", message: "Unicode: café — ünïcode ✓", category: "ui-library", stack: "boom", timestamp: 1_700_000_003_000 },
  // backticks and braces in the message, which a template string could mangle
  { id: "e", url: "http://localhost:4321/x", message: "Error in `${foo}` at {bar}", category: "unhandled-promise", stack: "```\nnested fence\n```", timestamp: 1_700_000_004_000 },
];

// Both formatWorkerMarkdown and formatAllErrorsMarkdown stamp Date.now(). Freeze it so
// the two implementations are compared on content, not on the millisecond they ran.
const FROZEN = new Date("2026-10-30T12:00:00.000Z");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    return args.length === 0 ? new RealDate(FROZEN) : new RealDate(...args);
  }
  static now() { return FROZEN.getTime(); }
};

let checks = 0;
const eq = (actual, expected, what) => {
  assert.equal(actual, expected, `${what} drifted from the pre-ReUI output`);
  checks += 1;
};

for (const [i, log] of FIXTURE.entries()) {
  eq(formatErrorMarkdown(log, i), reference.formatErrorMarkdown(log, i), `formatErrorMarkdown[${i}]`);
  eq(
    JSON.stringify(extractWorkerInfo(log.url)),
    JSON.stringify(reference.extractWorkerInfo(log.url)),
    `extractWorkerInfo[${i}]`
  );
}

const groups = groupLogsByWorker(FIXTURE);
const refGroups = reference.groupLogsByWorker(FIXTURE);
eq(JSON.stringify(groups), JSON.stringify(refGroups), "groupLogsByWorker");
eq(String(groups.length), "4", "group count (two logs share one host, three do not)");

for (const [i, group] of groups.entries()) {
  eq(formatWorkerMarkdown(group), reference.formatWorkerMarkdown(refGroups[i]), `formatWorkerMarkdown[${i}]`);
}

eq(formatAllErrorsMarkdown(FIXTURE), reference.formatAllErrorsMarkdown(FIXTURE), "formatAllErrorsMarkdown");
eq(formatAllErrorsMarkdown([]), reference.formatAllErrorsMarkdown([]), "formatAllErrorsMarkdown (empty)");

globalThis.Date = RealDate;
console.log(`selfcheck-report: ${checks} assertions, all matching the pre-ReUI output`);

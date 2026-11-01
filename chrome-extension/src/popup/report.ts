/**
 * The markdown the popup puts on the clipboard, for pasting into a coding agent.
 *
 * Byte-for-byte the same output as the pre-ReUI popup.js produced. `scripts/
 * selfcheck-report.mjs` pins that against a copy of the old implementation, so a drift
 * here goes red rather than quietly changing what lands in the agent's context.
 */

/** One captured error, as the content script sends it and the service worker stores it. */
export interface CapturedLog {
  id?: string;
  url: string;
  message: string;
  stack?: string | null;
  level?: string;
  /** react | astro-island | ui-library | unhandled | unhandled-promise | console.error | test */
  category?: string;
  metadata?: Record<string, unknown> | null;
  timestamp?: number;
  /** true once the service worker's POST to /api/logs succeeded. */
  posted?: boolean;
  postResult?: unknown;
}

export interface WorkerGroup {
  hostname: string;
  workerName: string;
  logs: CapturedLog[];
}

export function extractWorkerInfo(urlStr: string): {
  workerName: string;
  hostname: string;
  pathname: string;
} {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;
    const workerName = hostname
      .replace(/\.hacolby\.workers\.dev$/i, "")
      .replace(/\.hacolby\.app$/i, "");

    return { workerName: workerName || hostname, hostname, pathname: parsed.pathname };
  } catch {
    return {
      workerName: urlStr || "unknown-worker",
      hostname: urlStr || "unknown-host",
      pathname: "",
    };
  }
}

export function groupLogsByWorker(logs: CapturedLog[]): WorkerGroup[] {
  const groups: Record<string, WorkerGroup> = {};
  for (const log of logs) {
    const { hostname, workerName } = extractWorkerInfo(log.url);
    const key = hostname;
    if (!groups[key]) {
      groups[key] = { hostname, workerName, logs: [] };
    }
    groups[key].logs.push(log);
  }
  return Object.values(groups);
}

export function formatErrorMarkdown(log: CapturedLog, idx: number): string {
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

export function formatWorkerMarkdown(group: WorkerGroup): string {
  let md = `## Cloudflare Worker Errors: ${group.workerName}\n`;
  md += `- **Host:** ${group.hostname}\n`;
  md += `- **Total Errors:** ${group.logs.length}\n`;
  md += `- **Report Generated:** ${new Date().toISOString()}\n\n`;

  group.logs.forEach((log, i) => {
    md += formatErrorMarkdown(log, i) + "\n---\n\n";
  });

  return md;
}

export function formatAllErrorsMarkdown(logs: CapturedLog[]): string {
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

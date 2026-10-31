/**
 * The popup's half of the extension settings.
 *
 * The keys and their meanings are the service worker's — it seeds them on install and
 * reads them on every capture. This module only reads and writes them; it never invents
 * a default for the API key, because publishing one in the UI bundle would put a
 * credential in the repo.
 */
export interface WatcherSettings {
  apiUrl: string;
  apiKey: string;
  autoPost: boolean;
}

export const DEFAULT_API_URL = "https://cloudflare-api-mcp.hacolby.workers.dev";

export async function getSettings(): Promise<WatcherSettings> {
  const data = await chrome.storage.local.get(["apiUrl", "apiKey", "autoPost"]);
  return {
    apiUrl: data.apiUrl || DEFAULT_API_URL,
    apiKey: data.apiKey || "",
    autoPost: data.autoPost !== false,
  };
}

export async function saveSettings(settings: WatcherSettings): Promise<void> {
  await chrome.storage.local.set({
    apiUrl: settings.apiUrl,
    apiKey: settings.apiKey,
    autoPost: settings.autoPost,
  });
}

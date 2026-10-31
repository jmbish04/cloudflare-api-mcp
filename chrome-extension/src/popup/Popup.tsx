import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Eraser,
  ListX,
  Save,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { AppHeader } from "../components/app-header";
import { Alert, AlertDescription, AlertTitle } from "../components/reui/alert";
import { Badge } from "../components/reui/badge";
import { EmptyState } from "../components/reui/empty-state";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/reui/frame";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  formatAllErrorsMarkdown,
  formatErrorMarkdown,
  formatWorkerMarkdown,
  groupLogsByWorker,
  type CapturedLog,
  type WorkerGroup,
} from "./report";
import { DEFAULT_API_URL, getSettings, saveSettings, type WatcherSettings } from "./settings";

type ConnStatus = { kind: "ok" | "error" | "pending"; message: string } | null;

/** Which badge a captured error's category earns. Same mapping the pre-ReUI popup used. */
function categoryVariant(category: string) {
  if (category === "react") return "destructive-light" as const;
  if (category === "astro-island") return "warning-light" as const;
  return "info-light" as const;
}

/**
 * One captured stack trace.
 *
 * ReUI's CodeBlock would also fit and was considered; it pulls Shiki plus about 3,400
 * lines of highlighting machinery into a 380px popup that shows one monospace trace
 * with no language to highlight.
 */
function TraceBlock({ content }: { content: string }) {
  return (
    <Frame variant="inverse" spacing="dense">
      <FramePanel className="bg-muted/40 p-2">
        <pre className="max-h-40 overflow-auto font-mono text-[10px] leading-relaxed whitespace-pre text-muted-foreground select-text">
          {content}
        </pre>
      </FramePanel>
    </Frame>
  );
}

function ErrorRow({ log, index }: { log: CapturedLog; index: number }) {
  const [copied, setCopied] = useState(false);
  const category = log.category || "error";

  const handleCopy = () => {
    navigator.clipboard.writeText(formatErrorMarkdown(log, index));
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  return (
    <div className="space-y-1.5 border-t border-border px-2.5 py-2 first:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <Badge variant={categoryVariant(category)} size="xs" radius="full">
            {category}
          </Badge>
          {log.posted ? (
            <Badge variant="success-light" size="xs" radius="full">
              Synced to D1
            </Badge>
          ) : (
            <Badge variant="outline" size="xs" radius="full">
              Local only
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="font-mono text-[10px] text-muted-foreground">
            {new Date(log.timestamp || Date.now()).toLocaleTimeString()}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            aria-label="Copy this error as markdown"
            title="Copy this error as markdown"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </Button>
        </div>
      </div>

      <p className="font-mono text-[11px] leading-relaxed text-foreground">{log.message}</p>
      <p className="truncate font-mono text-[10px] text-muted-foreground">{log.url}</p>

      {log.stack && <TraceBlock content={log.stack} />}
    </div>
  );
}

function WorkerCard({ group }: { group: WorkerGroup }) {
  const [copied, setCopied] = useState(false);

  const handleCopyWorker = () => {
    navigator.clipboard.writeText(formatWorkerMarkdown(group));
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  return (
    <Frame variant="default" spacing="dense">
      <FrameHeader className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <FrameTitle className="flex items-center gap-1.5 text-xs">
              <Zap className="size-3.5 shrink-0 text-warning" />
              <span className="truncate">{group.workerName}</span>
              <Badge variant="destructive-light" size="xs" radius="full">
                {group.logs.length} {group.logs.length === 1 ? "error" : "errors"}
              </Badge>
            </FrameTitle>
            <FrameDescription className="truncate text-[10px]">{group.hostname}</FrameDescription>
          </div>

          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleCopyWorker}
            className="shrink-0"
            title={`Copy all ${group.logs.length} errors for ${group.workerName}`}
          >
            {copied ? <Check className="mr-1 size-3" /> : <Copy className="mr-1 size-3" />}
            <span>Copy</span>
          </Button>
        </div>
      </FrameHeader>

      <FramePanel className="bg-card/40 p-0">
        {group.logs.map((log, idx) => (
          <ErrorRow key={log.id ?? `${group.hostname}-${idx}`} log={log} index={idx} />
        ))}
      </FramePanel>
    </Frame>
  );
}

export default function Popup() {
  const [logs, setLogs] = useState<CapturedLog[]>([]);
  const [settings, setSettings] = useState<WatcherSettings>({
    apiUrl: DEFAULT_API_URL,
    apiKey: "",
    autoPost: true,
  });
  const [copiedAll, setCopiedAll] = useState(false);
  const [savedSettings, setSavedSettings] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnStatus>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    const [stored, current] = await Promise.all([
      chrome.storage.local.get(["recentLogs"]),
      getSettings(),
    ]);
    setLogs(stored.recentLogs || []);
    setSettings(current);
  }, []);

  useEffect(() => {
    void loadState();

    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.recentLogs || changes.errorCount) void loadState();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [loadState]);

  const handleCopyAll = () => {
    if (logs.length === 0) return;
    navigator.clipboard.writeText(formatAllErrorsMarkdown(logs));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2200);
  };

  const handleClear = async () => {
    if (!confirm("Clear all recorded error logs?")) return;
    await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
    await loadState();
  };

  const handleTestError = async () => {
    setTestError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setTestError("No active tab found.");
        return;
      }

      await chrome.tabs.sendMessage(tab.id, {
        type: "TRIGGER_TEST_ERROR",
        customMessage: `[TEST ERROR] Simulated React / Astro island render failure on ${
          tab.url || "current tab"
        }`,
      });

      setTimeout(() => void loadState(), 500);
    } catch {
      setTestError(
        "Could not inject a test error into the active tab. Open a page matching *.hacolby.workers.dev or *.hacolby.app first."
      );
    }
  };

  const handleSaveSettings = async () => {
    await saveSettings(settings);
    setSavedSettings(true);
    setTimeout(() => setSavedSettings(false), 2200);
  };

  const handleTestConnection = async () => {
    setConnStatus({ kind: "pending", message: "Testing connection..." });
    const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    if (response?.success) {
      setConnStatus({ kind: "ok", message: "Connected to the Cloudflare Worker API." });
    } else {
      setConnStatus({
        kind: "error",
        message: `Failed: ${response?.error || "Worker unreachable"}`,
      });
    }
  };

  const groups = groupLogsByWorker(logs);

  return (
    <div className="flex min-h-[520px] w-95 flex-col bg-background text-foreground select-none">
      <AppHeader
        icon={<Cloud />}
        title="CF Error Watcher"
        subtitle="*.hacolby.workers.dev & *.hacolby.app"
        tag="ReUI"
        actions={
          <Badge variant="success-light" size="xs" radius="full">
            Active
          </Badge>
        }
      />

      <Tabs defaultValue="errors" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-2">
          <TabsList>
            <TabsTrigger value="errors" className="gap-1.5">
              <AlertTriangle className="size-3.5" />
              <span>Errors</span>
              <Badge variant={logs.length > 0 ? "destructive-light" : "outline"} size="xs" radius="full">
                {logs.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-1.5">
              <Cloud className="size-3.5" />
              <span>Sync</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="errors" className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant={logs.length > 0 ? "default" : "secondary"}
              size="sm"
              onClick={handleCopyAll}
              disabled={logs.length === 0}
              className="flex-1 gap-1.5 font-semibold"
              title="Copy every worker error as one formatted block for a coding agent"
            >
              {copiedAll ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              <span>{copiedAll ? "Copied" : `Copy all (${logs.length})`}</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTestError}
              className="gap-1"
              title="Simulate an error on the current page"
            >
              <Zap className="size-3.5" />
              <span>Test</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={handleClear}
              aria-label="Clear error logs"
              title="Clear error logs"
            >
              <Eraser className="size-3.5" />
            </Button>
          </div>

          {testError && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>Test error not injected</AlertTitle>
              <AlertDescription>{testError}</AlertDescription>
            </Alert>
          )}

          {groups.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck className="size-6 text-success" />}
              title="All workers healthy"
              description="No errors on *.hacolby.workers.dev or *.hacolby.app. React crashes, Astro island hydration failures and unhandled exceptions land here."
            />
          ) : (
            <div className="space-y-2.5">
              {groups.map((group) => (
                <WorkerCard key={group.hostname} group={group} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="settings" className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
          <Frame variant="default" spacing="dense">
            <FrameHeader className="px-3 py-2.5">
              <FrameTitle className="text-xs">Worker D1 sync</FrameTitle>
              <FrameDescription className="text-[11px]">
                Where captured errors are posted, and the credential they are posted with.
              </FrameDescription>
            </FrameHeader>

            <FramePanel className="space-y-3 p-3">
              <div className="space-y-1.5">
                <label htmlFor="api-url" className="text-xs font-semibold">
                  Worker API URL
                </label>
                <Input
                  id="api-url"
                  type="url"
                  value={settings.apiUrl}
                  onChange={(e) => setSettings({ ...settings, apiUrl: e.target.value })}
                  placeholder={DEFAULT_API_URL}
                  className="bg-card text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="api-key" className="text-xs font-semibold">
                  Worker API key
                </label>
                <Input
                  id="api-key"
                  type="password"
                  value={settings.apiKey}
                  onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                  placeholder="WORKER_API_KEY"
                  autoComplete="off"
                  className="bg-card text-xs"
                />
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <div>
                  <div className="text-xs font-semibold">Auto-post to Cloudflare D1</div>
                  <div className="text-[11px] text-muted-foreground">
                    Off keeps every capture local to this browser
                  </div>
                </div>
                <Switch
                  checked={settings.autoPost}
                  onCheckedChange={(autoPost) => setSettings({ ...settings, autoPost })}
                />
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleTestConnection}
                  className="flex-1"
                >
                  Test health
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={handleSaveSettings}
                  className="flex-1 gap-1"
                >
                  <Save className="size-3.5" />
                  <span>Save</span>
                </Button>
              </div>
            </FramePanel>
          </Frame>

          {savedSettings && (
            <Alert variant="success">
              <CheckCircle2 />
              <AlertTitle>Configuration saved</AlertTitle>
            </Alert>
          )}

          {connStatus && (
            <Alert
              variant={
                connStatus.kind === "ok"
                  ? "success"
                  : connStatus.kind === "error"
                    ? "destructive"
                    : "info"
              }
            >
              {connStatus.kind === "ok" ? (
                <CheckCircle2 />
              ) : connStatus.kind === "error" ? (
                <ListX />
              ) : (
                <Cloud />
              )}
              <AlertTitle>{connStatus.message}</AlertTitle>
            </Alert>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

import * as React from 'react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Frame, FramePanel } from './reui/frame'
import { NoiseTexture } from './blocks/auth-4/components/noise-texture'
import {
  ArrowRight,
  CheckCircle2,
  Copy,
  KeyRound,
  Layers,
  Lock,
  Server,
  ShieldCheck,
  Zap
} from 'lucide-react'

export function LandingPage() {
  const [copied, setCopied] = React.useState(false)
  const mcpUrl = typeof window !== 'undefined' ? `${window.location.origin}/mcp` : '/mcp'

  const handleCopy = () => {
    if (typeof navigator !== 'undefined') {
      navigator.clipboard.writeText(mcpUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="relative min-h-screen w-full flex flex-col items-center justify-center p-4 sm:p-8 overflow-hidden">
      {/* Background Texture & Ambient Glow */}
      <NoiseTexture className="opacity-30" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] bg-[#f38020]/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-1/4 w-[400px] h-[250px] bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Main Container */}
      <div className="relative z-10 w-full max-w-4xl mx-auto space-y-12 py-10">
        {/* Header Branding */}
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/60 backdrop-blur-md px-4 py-1.5 text-xs font-medium text-muted-foreground shadow-sm">
            <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-foreground font-semibold">Cloudflare MCP Gateway</span>
            <span className="inline-block h-1 w-1 rounded-full bg-border" />
            <span className="text-primary font-mono font-medium">OAuth 2.1 Ready</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-foreground max-w-3xl">
            The Universal Cloudflare Bridge for{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary via-amber-400 to-orange-500">
              Claude & AI Agents
            </span>
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl">
            A high-performance Model Context Protocol gateway exposing ~2,500 Cloudflare API
            endpoints with secure 1-year OAuth token issuance and Secret Store credentials.
          </p>

          {/* Action Row */}
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <a href="/authorize">
              <Button
                size="lg"
                className="gap-2 shadow-lg shadow-primary/20 hover:shadow-primary/30"
              >
                <KeyRound className="h-4 w-4" />
                Authorize Claude
                <ArrowRight className="h-4 w-4" />
              </Button>
            </a>

            <Button
              variant="outline"
              size="lg"
              onClick={handleCopy}
              className="gap-2 font-mono text-xs border-border/80 bg-card/40 backdrop-blur-sm"
            >
              {copied ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span>Copied MCP Endpoint!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Copy /mcp URL</span>
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Feature Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-border/60 bg-card/40 backdrop-blur-sm shadow-sm hover:border-primary/40 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2 text-primary mb-1">
                <Layers className="h-5 w-5" />
                <Badge variant="outline" className="text-[10px] uppercase font-mono">
                  All Products
                </Badge>
              </div>
              <CardTitle className="text-lg">2,500+ API Endpoints</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-xs leading-relaxed">
                Full access to DNS, Workers, D1 SQL, KV, R2, AI Gateway, Zero Trust, and Security
                rules within Claude Code & Desktop.
              </CardDescription>
            </CardContent>
          </Card>

          <Card className="border-border/60 bg-card/40 backdrop-blur-sm shadow-sm hover:border-primary/40 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2 text-primary mb-1">
                <ShieldCheck className="h-5 w-5" />
                <Badge variant="outline" className="text-[10px] uppercase font-mono">
                  Security
                </Badge>
              </div>
              <CardTitle className="text-lg">1-Year OAuth Grants</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-xs leading-relaxed">
                Authenticate once via the ReUI portal using your Worker API Key and enjoy persistent
                1-year access without expiring tokens.
              </CardDescription>
            </CardContent>
          </Card>

          <Card className="border-border/60 bg-card/40 backdrop-blur-sm shadow-sm hover:border-primary/40 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2 text-primary mb-1">
                <Zap className="h-5 w-5" />
                <Badge variant="outline" className="text-[10px] uppercase font-mono">
                  Edge Runtime
                </Badge>
              </div>
              <CardTitle className="text-lg">Sub-10ms Edge Proxy</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-xs leading-relaxed">
                Runs on Cloudflare’s 300+ city global network with native Secret Store bindings and
                isolated HTTP connection pooling.
              </CardDescription>
            </CardContent>
          </Card>
        </div>

        {/* Quick Connection Guide */}
        <Frame className="border-border/60 bg-card/30 backdrop-blur-md">
          <FramePanel className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">
                  Claude Desktop Configuration
                </h3>
              </div>
              <Badge variant="secondary" className="font-mono text-[10px]">
                claude_desktop_config.json
              </Badge>
            </div>

            <div className="rounded-lg border border-border/80 bg-black/60 p-4 font-mono text-xs text-muted-foreground overflow-x-auto">
              <pre className="text-emerald-400">
                {`{
  "mcpServers": {
    "cloudflare": {
      "url": "${mcpUrl}"
    }
  }
}`}
              </pre>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
              <span className="flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-primary" />
                Protected with Cloudflare Secret Store
              </span>
              <a
                href="/authorize"
                className="text-primary hover:underline font-medium inline-flex items-center gap-1"
              >
                Go to OAuth Login
                <ArrowRight className="h-3 w-3" />
              </a>
            </div>
          </FramePanel>
        </Frame>

        {/* Footer */}
        <footer className="text-center text-xs text-muted-foreground space-y-1">
          <p>
            © {new Date().getFullYear()} Colby Ecosystem • Built with Astro, ReUI & Cloudflare
            Workers
          </p>
        </footer>
      </div>
    </div>
  )
}

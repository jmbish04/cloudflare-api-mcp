import * as React from 'react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Badge } from './ui/badge'
import { Alert, AlertDescription } from './ui/alert'
import { Shield, Key, Eye, EyeOff, AlertCircle, CheckCircle2 } from 'lucide-react'

interface LoginFormProps {
  clientName: string
  state: string
  error?: string
}

export function LoginForm({ clientName, state, error: initialError }: LoginFormProps) {
  const [showPassword, setShowPassword] = React.useState(false)
  const [apiKey, setApiKey] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  return (
    <div className="w-full max-w-[440px] space-y-6">
      {/* Top Branding Pill */}
      <div className="flex items-center justify-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur-md px-3.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm">
          <Shield className="h-3.5 w-3.5 text-primary" />
          <span>Cloudflare MCP Gateway</span>
          <span className="inline-block h-1 w-1 rounded-full bg-border" />
          <span className="text-primary font-mono">OAuth 2.1</span>
        </div>
      </div>

      <Card className="border-border/80 bg-card/80 shadow-2xl backdrop-blur-xl transition-all duration-200">
        <CardHeader className="space-y-2 pb-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 border border-primary/20 text-primary mb-1 shadow-inner">
            <Key className="h-6 w-6" />
          </div>
          <CardTitle className="text-xl font-bold tracking-tight text-foreground">
            Authorize Claude Access
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground max-w-xs mx-auto">
            Grant persistent <span className="font-semibold text-foreground">1-Year</span> Model
            Context Protocol access for{' '}
            <Badge variant="secondary" className="font-mono text-[11px] px-2 py-0.5 mt-0.5">
              {clientName}
            </Badge>
          </CardDescription>
        </CardHeader>

        <form method="POST" action="/authorize" onSubmit={() => setIsSubmitting(true)}>
          <CardContent className="space-y-4">
            {initialError && (
              <Alert variant="destructive" className="py-2.5 px-3.5 text-xs border-destructive/50">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="ml-2 font-medium">{initialError}</AlertDescription>
              </Alert>
            )}

            <input type="hidden" name="state" value={state} />

            <div className="space-y-2 text-left">
              <Label htmlFor="apiKey" className="text-xs font-medium text-foreground/90">
                Worker API Key
              </Label>
              <div className="relative">
                <Input
                  id="apiKey"
                  name="apiKey"
                  type={showPassword ? 'text' : 'password'}
                  required
                  placeholder="Paste your Secret Store API Key..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="pr-10 bg-input/50 border-border text-xs font-mono placeholder:font-sans focus-visible:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                Authorized via Cloudflare Secret Store (
                <code className="font-mono text-[10px]">WORKER_API_KEY</code>).
              </p>
            </div>

            <div className="rounded-lg border border-border/50 bg-muted/40 p-3 text-left space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                <span>Requested Permissions</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Full access to ~2,500 Cloudflare API operations via authenticated MCP tool calls.
              </p>
            </div>
          </CardContent>

          <CardFooter className="pt-2">
            <Button
              type="submit"
              disabled={isSubmitting || !apiKey.trim()}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-medium py-2 text-xs shadow-md transition-all disabled:opacity-50"
            >
              {isSubmitting ? 'Authenticating...' : 'Authorize 1-Year Access'}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <p className="text-center text-[11px] text-muted-foreground">
        Secure OAuth 2.1 Bridge • Colby Ecosystem
      </p>
    </div>
  )
}

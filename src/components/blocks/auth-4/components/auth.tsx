'use client'

import * as React from 'react'
import { Frame, FrameDescription, FramePanel, FrameTitle } from '@/components/reui/frame'

import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { Shield, Eye, EyeOff, CheckCircle2, AlertCircle } from 'lucide-react'

export interface AuthProps {
  clientName?: string
  state?: string
  error?: string
}

export function Auth({ clientName = 'Claude MCP Client', state = '', error }: AuthProps) {
  const [showPassword, setShowPassword] = React.useState(false)
  const [apiKey, setApiKey] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  return (
    <div className="relative flex min-h-svh w-full min-w-full flex-col">
      <div className="flex w-full min-w-full flex-1 items-center justify-center px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
        <div className="mx-auto flex w-full max-w-[28rem] flex-col gap-4">
          <Frame spacing="lg" className="w-full">
            <FramePanel className="space-y-8 px-8 py-9 sm:space-y-8 sm:px-10 sm:py-10">
              <div className="flex flex-col items-center gap-4 pt-1 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 border border-primary/20 text-primary">
                  <Shield className="h-6 w-6" />
                </div>

                <div className="flex max-w-xs flex-col gap-1.5">
                  <FrameTitle className="text-2xl tracking-tight sm:text-[1.75rem]">
                    Authorize Connection
                  </FrameTitle>
                  <FrameDescription className="text-sm text-pretty">
                    Grant{' '}
                    <span className="font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                      {clientName}
                    </span>{' '}
                    access to your Cloudflare account.
                  </FrameDescription>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3.5 text-sm text-destructive-foreground">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="flex-1 leading-snug">{error}</div>
                </div>
              )}

              <form
                method="POST"
                action="/authorize"
                onSubmit={() => setIsSubmitting(true)}
                className="flex flex-col gap-5"
              >
                <input type="hidden" name="state" value={state} />

                <FieldGroup className="gap-4">
                  <Field className="gap-2">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <FieldLabel htmlFor="auth-4-apiKey">Worker API Key</FieldLabel>
                      <span className="text-muted-foreground font-mono text-[11px]">
                        WORKER_API_KEY
                      </span>
                    </div>

                    <InputGroup className="w-full">
                      <InputGroupInput
                        id="auth-4-apiKey"
                        name="apiKey"
                        type={showPassword ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setApiKey(e.target.value)
                        }
                        placeholder="Paste your Secret Store API key"
                        autoComplete="current-password"
                        required
                        autoFocus
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          type="button"
                          aria-label={showPassword ? 'Hide API key' : 'Show API key'}
                          onClick={() => setShowPassword((val) => !val)}
                        >
                          {showPassword ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                </FieldGroup>

                {/* Scope / Grant Details */}
                <div className="rounded-lg border border-border/60 bg-muted/40 p-3.5 text-xs text-muted-foreground space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      Token Validity
                    </span>
                    <span className="font-mono text-foreground font-semibold">
                      1 Year (365 days)
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-border/40">
                    <span>Security Level</span>
                    <span className="text-emerald-400 font-medium">Full Access Proxy</span>
                  </div>
                </div>

                <Button type="submit" className="w-full" disabled={isSubmitting || !apiKey.trim()}>
                  {isSubmitting ? 'Authorizing...' : 'Authorize 1-Year Access'}
                </Button>
              </form>
            </FramePanel>
          </Frame>

          <p className="text-muted-foreground text-center text-xs">
            Protected by Cloudflare Secret Store and OAuth 2.1 PKCE
          </p>
        </div>
      </div>
    </div>
  )
}

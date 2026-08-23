import * as React from 'react'
import { Page as ReUIAuth4Page } from './blocks/auth-4/page'

export interface AuthorizePageProps {
  clientName?: string
  state?: string
  error?: string
}

/**
 * Full React Authorize Page Component using ReUI auth-4 block & Shadcn UI.
 * Encapsulates all layout, background texture, branding, form interactions,
 * and error states in pure React.
 */
export function AuthorizePage({
  clientName = 'Claude MCP Client',
  state = '',
  error
}: AuthorizePageProps) {
  return <ReUIAuth4Page clientName={clientName} state={state} error={error} />
}

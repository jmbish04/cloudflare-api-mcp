import { describe, expect, it } from 'vitest'
import { injectAccountId } from '../src/pages/mcp'

const ACCT = 'b3304b14848de15c72c24a14b0cd187d'
const call = (args: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: args } })

describe('injectAccountId', () => {
  it('adds account_id to an execute call that lacks it', () => {
    const out = JSON.parse(injectAccountId(call({ code: 'x' }), ACCT))
    expect(out.params.arguments.account_id).toBe(ACCT)
  })

  it('never overwrites an existing account_id', () => {
    const out = JSON.parse(injectAccountId(call({ code: 'x', account_id: 'keep' }), ACCT))
    expect(out.params.arguments.account_id).toBe('keep')
  })

  it('leaves non-execute tool calls untouched', () => {
    const body = JSON.stringify({ method: 'tools/call', params: { name: 'search', arguments: {} } })
    expect(JSON.parse(injectAccountId(body, ACCT)).params.arguments.account_id).toBeUndefined()
  })

  it('handles batch arrays', () => {
    const out = JSON.parse(injectAccountId(`[${call({ code: 'a' })},${call({ code: 'b' })}]`, ACCT))
    expect(out.every((m: any) => m.params.arguments.account_id === ACCT)).toBe(true)
  })

  it('passes through unparseable bodies unchanged', () => {
    expect(injectAccountId('not json', ACCT)).toBe('not json')
  })
})

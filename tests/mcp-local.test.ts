import { describe, expect, it } from 'vitest'
import {
  detectLocalToolCall,
  isLocalTool,
  isToolsListRequest,
  LOCAL_TOOLS,
  localToolDescriptors,
  mergeLocalToolsIntoList
} from '../src/lib/mcp-local'

describe('local tool registry', () => {
  it('exposes every documented tool with a schema and a description', () => {
    for (const t of LOCAL_TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/)
      expect(t.description.length).toBeGreaterThan(40)
      expect(t.inputSchema).toHaveProperty('properties')
    }
    const names = LOCAL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('workers_cicd_get')
    expect(names).toContain('workers_builds_list')
    expect(names).toContain('build_patterns_create')
  })

  it('tells coding agents to contribute a pattern after fixing an unknown failure', () => {
    const create = LOCAL_TOOLS.find((t) => t.name === 'build_patterns_create')!
    expect(create.description).toMatch(/submit a reusable pattern/i)
    expect(create.description).toMatch(/do not claim "verified"/i)
  })
})

describe('dispatch detection', () => {
  it('recognises a local tool call', () => {
    const rpc = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'workers_cicd_get', arguments: { worker_name: 'w' } }
    }
    const hit = detectLocalToolCall(rpc)!
    expect(hit.name).toBe('workers_cicd_get')
    expect(hit.id).toBe(7)
    expect(hit.args).toEqual({ worker_name: 'w' })
  })

  it('leaves upstream tool calls alone', () => {
    expect(detectLocalToolCall({ method: 'tools/call', params: { name: 'execute' } })).toBeNull()
    expect(isLocalTool('search')).toBe(false)
  })

  it('finds a local call inside a JSON-RPC batch', () => {
    const batch = [
      { method: 'tools/call', params: { name: 'execute' } },
      { method: 'tools/call', id: 2, params: { name: 'workers_builds_list', arguments: {} } }
    ]
    expect(detectLocalToolCall(batch)!.name).toBe('workers_builds_list')
  })

  it('detects tools/list, single and batched', () => {
    expect(isToolsListRequest({ method: 'tools/list' })).toBe(true)
    expect(isToolsListRequest([{ method: 'initialize' }, { method: 'tools/list' }])).toBe(true)
    expect(isToolsListRequest({ method: 'tools/call' })).toBe(false)
  })
})

describe('mergeLocalToolsIntoList', () => {
  it('appends local tools to the upstream list without dropping any', () => {
    const upstream = {
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'search' }, { name: 'execute' }] }
    }
    const merged = mergeLocalToolsIntoList(upstream) as {
      result: { tools: Array<{ name: string }> }
    }
    const names = merged.result.tools.map((t) => t.name)
    expect(names).toContain('search')
    expect(names).toContain('execute')
    expect(names).toContain('workers_cicd_pause')
    expect(names).toHaveLength(2 + localToolDescriptors().length)
  })

  it('never duplicates a tool the upstream already advertises', () => {
    const upstream = { result: { tools: [{ name: 'workers_cicd_get' }] } }
    const merged = mergeLocalToolsIntoList(upstream) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(merged.result.tools.filter((t) => t.name === 'workers_cicd_get')).toHaveLength(1)
  })

  it('passes an unexpected shape through untouched rather than erroring', () => {
    const weird = { jsonrpc: '2.0', error: { code: -32000 } }
    expect(mergeLocalToolsIntoList(weird)).toEqual(weird)
  })
})

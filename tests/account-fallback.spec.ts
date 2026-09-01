import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Context, Model, OAuthCredential, Provider, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai'
import { isOpenAICodexTerminalQuotaError, withOpenAICodexAccountFallback } from '../src/account-fallback.ts'
import type { OpenAICodexAccountFallbackEvent } from '../src/account-fallback.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function usage(output = 0): Usage {
  return { input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: output + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function credential(accountId: string): OAuthCredential {
  return { type: 'oauth', access: `access-${accountId}`, refresh: `refresh-${accountId}`, expires: Date.now() + 600_000, accountId }
}

async function storedAccounts(count = 2): Promise<OpenAICodexCredentialStore> {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-fallback-'))
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  for (let index = 1; index <= count; index += 1) {
    await store.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential(`account-${String(index)}`)))
  }
  await store.activate('account-1')
  return store
}

function model(): Model<'openai-codex-responses'> {
  return { provider: OPENAI_CODEX_PROVIDER, id: 'gpt-test', name: 'GPT Test', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000, input: ['text'] }
}

function message(text: string, stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage {
  return { role: 'assistant', content: text === '' ? [] : [{ type: 'text', text }], api: 'openai-codex-responses', provider: OPENAI_CODEX_PROVIDER, model: 'gpt-test', usage: usage(text.length), stopReason, ...errorMessage === undefined ? {} : { errorMessage }, timestamp: Date.now() }
}

function provider(implementation: (context: Context, options?: SimpleStreamOptions) => ReturnType<typeof createAssistantMessageEventStream>): Provider {
  return { id: OPENAI_CODEX_PROVIDER, name: 'test', auth: { apiKey: { name: 'test', resolve: async () => undefined } }, getModels: () => [model()], stream: (_model, requestContext, options) => implementation(requestContext, options as SimpleStreamOptions | undefined), streamSimple: (_model, requestContext, options) => implementation(requestContext, options) }
}

function terminal(text: string, errorMessage?: string) {
  const stream = createAssistantMessageEventStream()
  const result = message(text, errorMessage === undefined ? 'stop' : 'error', errorMessage)
  stream.push({ type: 'start', partial: message('', 'stop') })
  if (text !== '') {
    stream.push({ type: 'text_start', contentIndex: 0, partial: result })
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: result })
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: result })
  }
  if (errorMessage === undefined) stream.push({ type: 'done', reason: 'stop', message: result })
  else stream.push({ type: 'error', reason: 'error', error: result })
  stream.end(result)
  return stream
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

async function resolveSavedAccess(store: OpenAICodexCredentialStore, accountId: string): Promise<string | undefined> {
  const saved = await store.forAccount(accountId).read(OPENAI_CODEX_PROVIDER)
  return saved?.type === 'oauth' ? saved.access : undefined
}

const context: Context = { messages: [{ role: 'user', content: 'Write Alpha Beta.', timestamp: 1 }] }

describe('automatic OpenAI Codex account fallback', () => {
  it.each(['usage_limit_reached', 'usage_not_included', 'insufficient_quota', '{"error":{"code":"usage_limit_reached"}}'])('accepts an allowlisted machine code: %s', detail => {
    expect(isOpenAICodexTerminalQuotaError(detail)).toBe(true)
  })

  it.each(['HTTP 429 rate limit', 'rate_limit_exceeded', 'usage limit reached', 'credits depleted', 'message mentions insufficient_quota here', '{"error":{"code":"server_error"}}'])('rejects transient or prose-only errors: %s', detail => {
    expect(isOpenAICodexTerminalQuotaError(detail)).toBe(false)
  })

  it('retries the unchanged context, strips an exact repeated prefix, and audits the switch', async () => {
    const store = await storedAccounts()
    const calls: Array<{ access?: string; context: Context }> = []
    const events: OpenAICodexAccountFallbackEvent[] = []
    const source = provider((requestContext, options) => {
      calls.push({ ...options?.apiKey === undefined ? {} : { access: options.apiKey }, context: requestContext })
      return options?.apiKey === 'access-account-1'
        ? terminal('Alpha ', 'usage_limit_reached')
        : terminal('Alpha Beta')
    })
    const wrapped = withOpenAICodexAccountFallback(source, store, resolveSavedAccess, () => true, event => { events.push(event) })

    const output = await collect(wrapped.streamSimple(model(), context, { apiKey: 'access-account-1', sessionId: 'session-1' }))

    expect(output.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe('Alpha Beta')
    expect(output.filter(event => event.type === 'start')).toHaveLength(1)
    expect(output.at(-1)?.type).toBe('done')
    expect(calls.map(call => call.access)).toEqual(['access-account-1', 'access-account-2'])
    expect(calls[1]?.context).toBe(context)
    expect(events).toContainEqual(expect.objectContaining({ type: 'switched', sessionId: 'session-1', fromAccountId: 'account-1', toAccountId: 'account-2', reasonCode: 'usage_limit_reached' }))
    expect(JSON.stringify(events)).not.toContain('access-account')
  })

  it('does nothing when disabled, for generic 429, or after a tool call starts', async () => {
    const store = await storedAccounts()
    const calls = vi.fn()
    const quota = provider((_requestContext, options) => { calls(options?.apiKey); return terminal('', 'usage_limit_reached') })
    await collect(withOpenAICodexAccountFallback(quota, store, resolveSavedAccess, () => false).streamSimple(model(), context, { apiKey: 'access-account-1' }))
    expect(calls).toHaveBeenCalledOnce()

    const transient = provider((_requestContext, options) => { calls(options?.apiKey); return terminal('', 'HTTP 429 rate limit') })
    await collect(withOpenAICodexAccountFallback(transient, store, resolveSavedAccess).streamSimple(model(), context, { apiKey: 'access-account-1' }))

    const tool = provider(() => {
      const stream = createAssistantMessageEventStream()
      const failed = { ...message('', 'error', 'usage_limit_reached'), content: [{ type: 'toolCall' as const, id: 'call-1', name: 'write', arguments: {} }] }
      stream.push({ type: 'start', partial: message('', 'stop') })
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial: failed })
      stream.push({ type: 'error', reason: 'error', error: failed })
      stream.end(failed)
      return stream
    })
    await collect(withOpenAICodexAccountFallback(tool, store, resolveSavedAccess).streamSimple(model(), context, { apiKey: 'access-account-1' }))
    expect(calls).toHaveBeenCalledTimes(2)
    expect((await store.snapshot())?.activeAccountId).toBe('account-1')
  })

  it('preflights candidates before activation and skips a failed refresh', async () => {
    const store = await storedAccounts(3)
    const calls: string[] = []
    const source = provider((_requestContext, options) => {
      calls.push(options?.apiKey ?? 'missing')
      return options?.apiKey === 'access-account-3' ? terminal('ok') : terminal('', 'usage_limit_reached')
    })
    const resolver = vi.fn(async (saved: OpenAICodexCredentialStore, accountId: string) => {
      if (accountId === 'account-2') throw new Error('refresh failed with access-secret')
      return resolveSavedAccess(saved, accountId)
    })
    const wrapped = withOpenAICodexAccountFallback(source, store, resolver)

    expect((await collect(wrapped.streamSimple(model(), context, { apiKey: 'access-account-1' }))).at(-1)?.type).toBe('done')
    expect(calls).toEqual(['access-account-1', 'access-account-3'])
    expect((await store.snapshot())?.activeAccountId).toBe('account-3')
  })

  it('conditionally rolls back startup failure and never overwrites a concurrent manual switch', async () => {
    const store = await storedAccounts(3)
    let throwOnSecond = true
    const source = provider((_requestContext, options) => {
      if (options?.apiKey === 'access-account-1') return terminal('', 'usage_limit_reached')
      if (throwOnSecond) throw new Error('startup failed')
      return terminal('ok')
    })
    const wrapped = withOpenAICodexAccountFallback(source, store, resolveSavedAccess)
    expect((await collect(wrapped.streamSimple(model(), context, { apiKey: 'access-account-1' }))).at(-1)?.type).toBe('error')
    expect((await store.snapshot())?.activeAccountId).toBe('account-1')

    throwOnSecond = false
    const racingResolver = async (saved: OpenAICodexCredentialStore, accountId: string) => {
      const access = await resolveSavedAccess(saved, accountId)
      await saved.activate('account-3')
      return access
    }
    await collect(withOpenAICodexAccountFallback(source, store, racingResolver).streamSimple(model(), context, { apiKey: 'access-account-1' }))
    expect((await store.snapshot())?.activeAccountId).toBe('account-3')
  })

  it('attempts every pinned account once and restores the original after exhaustion', async () => {
    const store = await storedAccounts(3)
    const calls: string[] = []
    const source = provider((_requestContext, options) => { calls.push(options?.apiKey ?? 'missing'); return terminal('', 'insufficient_quota') })
    const output = await collect(withOpenAICodexAccountFallback(source, store, resolveSavedAccess).streamSimple(model(), context, { apiKey: 'access-account-1' }))
    expect(calls).toEqual(['access-account-1', 'access-account-2', 'access-account-3'])
    expect(output.at(-1)).toMatchObject({ type: 'error', error: { errorMessage: 'insufficient_quota' } })
    expect((await store.snapshot())?.activeAccountId).toBe('account-1')
  })
})

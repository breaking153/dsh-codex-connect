/** Opt-in, quota-only OpenAI Codex account fallback for one pi-ai stream. */

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, Provider, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai'
import type { OpenAICodexCredentialStore } from './store.ts'

const TERMINAL_QUOTA_CODES = new Set(['usage_limit_reached', 'usage_not_included', 'insufficient_quota'])
const DEDUPLICATION_LIMIT = 4_096

export interface OpenAICodexAccountFallbackEvent {
  type: 'candidate-rejected' | 'switched' | 'rollback' | 'completed' | 'exhausted' | 'superseded'
  sessionId: string | undefined
  fromAccountId: string
  toAccountId?: string
  reasonCode: string
  attempt: number
  rollbackApplied?: boolean
  timestamp: number
}

export type OpenAICodexFallbackAccessResolver = (
  credentials: OpenAICodexCredentialStore,
  accountId: string,
) => Promise<string | undefined>

/** Accept only a machine-code allowlist, never a generic status or prose match. */
export function openAICodexTerminalQuotaCode(detail: string): string | undefined {
  const trimmed = detail.trim()
  if (TERMINAL_QUOTA_CODES.has(trimmed)) return trimmed
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const error = (parsed as Record<string, unknown>)['error']
    if (typeof error !== 'object' || error === null || Array.isArray(error)) return undefined
    const record = error as Record<string, unknown>
    for (const key of ['code', 'type']) {
      const code = record[key]
      if (typeof code === 'string' && TERMINAL_QUOTA_CODES.has(code)) return code
    }
  } catch {
    // Flattened friendly text is intentionally not a fallback signal.
  }
  return undefined
}

export function isOpenAICodexTerminalQuotaError(detail: string): boolean {
  return openAICodexTerminalQuotaCode(detail) !== undefined
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function addUsage(left: Usage, right: Usage): Usage {
  const optional = (key: 'cacheWrite1h' | 'reasoning'): number | undefined => {
    const a = left[key]
    const b = right[key]
    return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  }
  const cacheWrite1h = optional('cacheWrite1h')
  const reasoning = optional('reasoning')
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...cacheWrite1h === undefined ? {} : { cacheWrite1h },
    ...reasoning === undefined ? {} : { reasoning },
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  }
}

function visibleText(message: AssistantMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function combinedMessage(previous: AssistantMessage | undefined, current: AssistantMessage, content = current.content): AssistantMessage {
  return previous === undefined
    ? { ...current, content }
    : { ...current, content: [...previous.content, ...content], usage: addUsage(previous.usage, current.usage) }
}

function terminalMessage(event: Extract<AssistantMessageEvent, { type: 'done' | 'error' }>): AssistantMessage {
  return event.type === 'done' ? event.message : event.error
}

function hasToolCall(message: AssistantMessage): boolean {
  return message.content.some(block => block.type === 'toolCall')
}

function longestSuffixPrefix(prefix: string, candidate: string): number {
  const limit = Math.min(prefix.length, candidate.length)
  for (let length = limit; length > 0; length -= 1) {
    if (prefix.endsWith(candidate.slice(0, length))) return length
  }
  return 0
}

function canStillMatchSuffix(prefix: string, candidate: string): boolean {
  if (candidate.length === 0) return true
  for (let start = 0; start < prefix.length; start += 1) {
    const available = prefix.length - start
    if (candidate.length <= available && prefix.slice(start, start + candidate.length) === candidate) return true
  }
  return false
}

class ExactPrefixDeduplicator {
  private readonly prefix: string
  private buffered = ''
  private decided = false

  constructor(previousText: string) {
    this.prefix = previousText.slice(-DEDUPLICATION_LIMIT)
  }

  write(delta: string): string {
    if (this.decided || this.prefix.length === 0) return delta
    this.buffered += delta
    if (this.buffered.length < DEDUPLICATION_LIMIT && canStillMatchSuffix(this.prefix, this.buffered)) return ''
    return this.release()
  }

  finish(): string {
    return this.decided ? '' : this.release()
  }

  private release(): string {
    this.decided = true
    const output = this.buffered.slice(longestSuffixPrefix(this.prefix, this.buffered))
    this.buffered = ''
    return output
  }
}

function withCombinedPartial(previous: AssistantMessage | undefined, partial: AssistantMessage, firstTextIndex: number | undefined, firstText: string): AssistantMessage {
  const content = partial.content.map((block, index) => index === firstTextIndex && block.type === 'text' ? { ...block, text: firstText } : block)
  return combinedMessage(previous, partial, content)
}

function remapEvent(
  event: Exclude<AssistantMessageEvent, { type: 'start' | 'done' | 'error' }>,
  offset: number,
  previous: AssistantMessage | undefined,
  firstTextIndex: number | undefined,
  firstText: string,
): Exclude<AssistantMessageEvent, { type: 'start' | 'done' | 'error' }> {
  return { ...event, contentIndex: event.contentIndex + offset, partial: withCombinedPartial(previous, event.partial, firstTextIndex, firstText) }
}

function setupFailure(model: Model<Api>, error: unknown): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'error', errorMessage: error instanceof Error ? error.message : 'OpenAI Codex fallback setup failed', timestamp: Date.now() }
}

function orderedCandidates(accountIds: readonly string[], activeAccountId: string): string[] {
  const activeIndex = accountIds.indexOf(activeAccountId)
  if (activeIndex < 0) return []
  return [...accountIds.slice(activeIndex + 1), ...accountIds.slice(0, activeIndex)]
}

/** Wrap one provider with bounded, quota-only, no-hidden-input account fallback. */
export function withOpenAICodexAccountFallback(
  provider: Provider,
  credentials: OpenAICodexCredentialStore,
  resolveAccessToken: OpenAICodexFallbackAccessResolver,
  enabled: () => boolean = () => true,
  notify?: (event: OpenAICodexAccountFallbackEvent) => void,
): Provider {
  const sourceStream = provider.streamSimple
  return {
    ...provider,
    streamSimple(model, originalContext: Context, options?: SimpleStreamOptions) {
      if (!enabled()) return sourceStream.call(provider, model, originalContext, options)
      const output = createAssistantMessageEventStream()
      const emit = (event: Omit<OpenAICodexAccountFallbackEvent, 'timestamp'>): void => {
        try { notify?.({ ...event, timestamp: Date.now() }) } catch { /* audit observers cannot break a request */ }
      }

      const pump = async (): Promise<void> => {
        const snapshot = await credentials.snapshot()
        const initialAccess = options?.apiKey
        const initialAccountId = initialAccess === undefined ? undefined : await credentials.accountIdForAccessToken(initialAccess)
        if (snapshot === undefined || initialAccountId === undefined || snapshot.activeAccountId !== initialAccountId) {
          const direct = sourceStream.call(provider, model, originalContext, options)
          for await (const event of direct) output.push(event)
          const result = await direct.result()
          output.end(result)
          return
        }

        const candidates = orderedCandidates(snapshot.accountIds, initialAccountId)
        const attempted = new Set([initialAccountId])
        let previous: AssistantMessage | undefined
        let currentAccountId = initialAccountId
        let access = initialAccess
        let fallbackActive = false
        let attempt = 1
        let firstQuotaCode: string | undefined
        let firstQuotaError: string | undefined

        const rollback = async (reasonCode: string): Promise<void> => {
          if (!fallbackActive) return
          const result = await credentials.activateIfActive(currentAccountId, initialAccountId)
          emit({ type: 'rollback', sessionId: options?.sessionId, fromAccountId: currentAccountId, toAccountId: initialAccountId, reasonCode, attempt, rollbackApplied: result.activated })
          fallbackActive = false
        }

        while (true) {
          const offset = previous?.content.length ?? 0
          const deduplicator = new ExactPrefixDeduplicator(previous === undefined ? '' : visibleText(previous))
          const openBlocks = new Map<number, 'text' | 'thinking' | 'toolCall'>()
          let firstTextIndex: number | undefined
          let firstText = ''
          let sawTerminal = false
          let retry = false
          let inner
          try {
            inner = sourceStream.call(provider, model, originalContext, { ...options, ...access === undefined ? {} : { apiKey: access } })
          } catch (error) {
            await rollback('replacement_start_failed')
            throw error
          }

          try {
            for await (const event of inner) {
              if (event.type === 'start') {
                if (previous === undefined) output.push(event)
                continue
              }
              if (event.type === 'done' || event.type === 'error') {
                sawTerminal = true
                const released = deduplicator.finish()
                const raw = terminalMessage(event)
                if (released !== '' && firstTextIndex !== undefined) {
                  firstText += released
                  output.push({ type: 'text_delta', contentIndex: firstTextIndex + offset, delta: released, partial: withCombinedPartial(previous, raw, firstTextIndex, firstText) })
                }
                const currentContent = raw.content.map((block, index) => index === firstTextIndex && block.type === 'text' ? { ...block, text: firstText } : block)
                let combined = combinedMessage(previous, raw, currentContent)
                const quotaCode = event.type === 'error' && event.reason === 'error' ? openAICodexTerminalQuotaCode(event.error.errorMessage ?? '') : undefined
                const safeToRetry = quotaCode !== undefined && options?.signal?.aborted !== true && !hasToolCall(raw) && ![...openBlocks.values()].includes('toolCall')

                if (safeToRetry) {
                  firstQuotaCode ??= quotaCode
                  firstQuotaError ??= event.type === 'error' ? event.error.errorMessage : undefined
                  let selected = false
                  for (const candidate of candidates) {
                    if (attempted.has(candidate)) continue
                    attempted.add(candidate)
                    attempt += 1
                    let candidateAccess: string | undefined
                    try {
                      candidateAccess = await resolveAccessToken(credentials, candidate)
                    } catch {
                      emit({ type: 'candidate-rejected', sessionId: options?.sessionId, fromAccountId: currentAccountId, toAccountId: candidate, reasonCode: 'credential_preflight_failed', attempt })
                      continue
                    }
                    if (candidateAccess === undefined || await credentials.accountIdForAccessToken(candidateAccess) !== candidate) {
                      emit({ type: 'candidate-rejected', sessionId: options?.sessionId, fromAccountId: currentAccountId, toAccountId: candidate, reasonCode: 'credential_preflight_failed', attempt })
                      continue
                    }
                    const activation = await credentials.activateIfActive(currentAccountId, candidate)
                    if (!activation.activated) {
                      emit({ type: 'superseded', sessionId: options?.sessionId, fromAccountId: currentAccountId, toAccountId: candidate, reasonCode: quotaCode, attempt })
                      if (firstQuotaError !== undefined) combined = { ...combined, errorMessage: firstQuotaError }
                      output.push({ type: 'error', reason: 'error', error: combined })
                      output.end(combined)
                      return
                    }
                    for (const [index, type] of openBlocks) {
                      const block = currentContent[index]
                      if (type === 'text' && block?.type === 'text') output.push({ type: 'text_end', contentIndex: index + offset, content: block.text, partial: combined })
                      if (type === 'thinking' && block?.type === 'thinking') output.push({ type: 'thinking_end', contentIndex: index + offset, content: block.thinking, partial: combined })
                    }
                    emit({ type: 'switched', sessionId: options?.sessionId, fromAccountId: currentAccountId, toAccountId: candidate, reasonCode: quotaCode, attempt })
                    previous = combined
                    currentAccountId = candidate
                    access = candidateAccess
                    fallbackActive = true
                    selected = true
                    retry = true
                    break
                  }
                  if (selected) break
                  await rollback('all_accounts_exhausted')
                  emit({ type: 'exhausted', sessionId: options?.sessionId, fromAccountId: initialAccountId, reasonCode: firstQuotaCode ?? quotaCode, attempt })
                  if (firstQuotaError !== undefined) combined = { ...combined, errorMessage: firstQuotaError }
                }

                if (event.type === 'done') {
                  if (fallbackActive) emit({ type: 'completed', sessionId: options?.sessionId, fromAccountId: initialAccountId, toAccountId: currentAccountId, reasonCode: firstQuotaCode ?? 'terminal_quota', attempt })
                  output.push({ ...event, message: combined })
                } else {
                  output.push({ ...event, error: combined })
                }
                output.end(combined)
                return
              }

              if (event.type === 'text_start') {
                firstTextIndex ??= event.contentIndex
                if (event.contentIndex === firstTextIndex) firstText = ''
                openBlocks.set(event.contentIndex, 'text')
                output.push(remapEvent(event, offset, previous, firstTextIndex, firstText))
                continue
              }
              if (event.type === 'text_delta') {
                const delta = event.contentIndex === firstTextIndex ? deduplicator.write(event.delta) : event.delta
                if (event.contentIndex === firstTextIndex) firstText += delta
                if (delta !== '') output.push(remapEvent({ ...event, delta }, offset, previous, firstTextIndex, firstText))
                continue
              }
              if (event.type === 'text_end') {
                const released = event.contentIndex === firstTextIndex ? deduplicator.finish() : ''
                if (released !== '') {
                  firstText += released
                  output.push(remapEvent({ type: 'text_delta', contentIndex: event.contentIndex, delta: released, partial: event.partial }, offset, previous, firstTextIndex, firstText))
                }
                openBlocks.delete(event.contentIndex)
                output.push(remapEvent({ ...event, content: event.contentIndex === firstTextIndex ? firstText : event.content }, offset, previous, firstTextIndex, firstText))
                continue
              }
              if (event.type === 'thinking_start') openBlocks.set(event.contentIndex, 'thinking')
              if (event.type === 'thinking_end') openBlocks.delete(event.contentIndex)
              if (event.type === 'toolcall_start') openBlocks.set(event.contentIndex, 'toolCall')
              if (event.type === 'toolcall_end') openBlocks.delete(event.contentIndex)
              output.push(remapEvent(event, offset, previous, firstTextIndex, firstText))
            }
          } catch (error) {
            await rollback('replacement_start_failed')
            throw error
          }
          if (retry) continue
          if (!sawTerminal) {
            await rollback('replacement_start_failed')
            throw new Error('OpenAI Codex account fallback source ended without a terminal event')
          }
        }
      }

      void pump().catch((error: unknown) => {
        const failure = setupFailure(model, error)
        output.push({ type: 'error', reason: 'error', error: failure })
        output.end(failure)
      })
      return output
    },
  }
}

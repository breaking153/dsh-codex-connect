/** Shared, in-memory OAuth UI state. No token or browser storage is used here. */
import type { OpenAICodexUsage } from '../usage.ts'
import {
  OPENAI_CODEX_AUTH_ACCOUNTS_PATH,
  OPENAI_CODEX_AUTH_CANCEL_PATH,
  OPENAI_CODEX_AUTH_LOGIN_PATH,
  OPENAI_CODEX_AUTH_LOGOUT_PATH,
  OPENAI_CODEX_AUTH_STATUS_PATH,
} from '../auth-paths.ts'

export interface AccountSummary {
  accountId: string
  active: boolean
  expires: number
  displayName: string
  email?: string
  profileSource: 'file' | 'oauth' | 'local' | 'generated'
}

export type AccountStatus =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signing-in' }
  | { status: 'reauth-required'; message: string }
  | { status: 'signed-in'; usage: OpenAICodexUsage; quotaError?: string }
  | { status: 'remote-web-origin-not-trusted' }
  | { status: 'error'; message: string }

export interface AccountSnapshot {
  status: AccountStatus
  busy: boolean
  accounts: readonly AccountSummary[]
  loginUrl?: string
}

type AccountServerState = AccountStatus & { accounts?: AccountSummary[] }

class AccountRequestError extends Error {}

async function request<T>(path: string, method = 'GET', signal?: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    credentials: 'same-origin',
    ...signal === undefined ? {} : { signal },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error : `HTTP ${response.status}`
    throw new AccountRequestError(message)
  }
  return value as T
}

/** One account state per browser-plugin instance; subscribers share requests and timers. */
export class OpenAICodexAccountStore {
  private snapshot: AccountSnapshot = { status: { status: 'loading' }, busy: false, accounts: [] }
  private readonly listeners = new Set<() => void>()
  private controller: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private popup: Window | null = null

  getSnapshot = (): AccountSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.listeners.size === 1) void this.refresh()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stopPolling()
    }
  }

  private publish(snapshot: AccountSnapshot): void {
    if (this.disposed) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private failure(error: unknown): AccountStatus {
    return error instanceof AccountRequestError && error.message === 'remote-web-origin-not-trusted'
      ? { status: 'remote-web-origin-not-trusted' }
      : { status: 'error', message: error instanceof Error ? error.message : 'Account request failed' }
  }

  private splitServerState(response: AccountServerState): Pick<AccountSnapshot, 'status' | 'accounts'> {
    const { accounts, ...status } = response
    return {
      status: status as AccountStatus,
      accounts: Array.isArray(accounts) ? accounts : [],
    }
  }

  private async readServerState(signal?: AbortSignal): Promise<Pick<AccountSnapshot, 'status' | 'accounts'>> {
    const response = await request<AccountServerState>(OPENAI_CODEX_AUTH_STATUS_PATH, 'GET', signal)
    return this.splitServerState(response)
  }

  private stopPolling(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.controller = undefined
  }

  private schedule(): void {
    clearTimeout(this.timer)
    const interval = this.snapshot.status.status === 'signing-in' ? 1_000
      : this.snapshot.status.status === 'signed-in' ? 60_000 : undefined
    if (!this.disposed && this.listeners.size > 0 && interval !== undefined) {
      this.timer = setTimeout(() => { void this.refresh() }, interval)
    }
  }

  /** Refresh only while observed, without overlapping status reads or OAuth mutations. */
  async refresh(): Promise<void> {
    if (this.disposed || this.snapshot.busy || this.controller !== undefined || this.listeners.size === 0) return
    const controller = new AbortController()
    this.controller = controller
    try {
      const { status, accounts } = await this.readServerState(controller.signal)
      if (!controller.signal.aborted) this.publish({
        status, accounts, busy: false,
        ...status.status === 'signing-in' && this.snapshot.loginUrl !== undefined ? { loginUrl: this.snapshot.loginUrl } : {},
      })
    } catch (error: unknown) {
      if (!controller.signal.aborted) this.publish({ status: this.failure(error), busy: false, accounts: this.snapshot.accounts })
    } finally {
      if (this.controller === controller) {
        this.controller = undefined
        this.schedule()
      }
    }
  }

  /** Start or reopen the server-owned authorization from a user click, retaining popup permission. */
  async signIn(): Promise<void> {
    if (this.disposed || this.snapshot.busy) return
    this.stopPolling()
    const popup = window.open('about:blank', '_blank')
    this.popup = popup
    if (popup !== null) popup.opener = null
    this.publish({ status: { status: 'signing-in' }, busy: true, accounts: this.snapshot.accounts })
    try {
      const challenge = await request<{ url: string }>(OPENAI_CODEX_AUTH_LOGIN_PATH, 'POST')
      if (this.disposed) { popup?.close(); return }
      if (popup !== null) popup.location.replace(challenge.url)
      this.publish({ status: { status: 'signing-in' }, busy: false, accounts: this.snapshot.accounts, loginUrl: challenge.url })
    } catch (error: unknown) {
      popup?.close()
      this.publish({ status: this.failure(error), busy: false, accounts: this.snapshot.accounts })
      if (error instanceof AccountRequestError && error.message === 'OpenAI Codex sign-in cancelled') {
        // Another browser can cancel the shared server operation while this login request is pending.
        await this.refresh()
      }
    } finally {
      if (this.popup === popup) this.popup = null
      this.schedule()
    }
  }

  /** Cancel only the pending authorization, preserving an already signed-in account. */
  async cancel(): Promise<void> {
    if (this.disposed || this.snapshot.busy) return
    this.stopPolling()
    this.publish({ ...this.snapshot, busy: true })
    try {
      const response = await request<AccountServerState>(OPENAI_CODEX_AUTH_CANCEL_PATH, 'POST')
      this.publish({ ...this.splitServerState(response), busy: false })
    } catch (error: unknown) {
      this.publish({ status: this.failure(error), busy: false, accounts: this.snapshot.accounts })
    } finally {
      this.schedule()
    }
  }

  /** Sign out once for all mounted account views and invalidate older status reads. */
  async signOut(): Promise<void> {
    if (this.disposed || this.snapshot.busy) return
    this.stopPolling()
    this.publish({ ...this.snapshot, busy: true })
    try {
      const response = await request<AccountServerState>(OPENAI_CODEX_AUTH_LOGOUT_PATH, 'POST')
      this.publish({ ...this.splitServerState(response), busy: false })
    } catch (error: unknown) {
      this.publish({ status: this.failure(error), busy: false, accounts: this.snapshot.accounts })
    }
  }

  /** Explicitly select one saved account and refresh its quota state. */
  async activate(accountId: string): Promise<void> {
    if (this.disposed || this.snapshot.busy || this.snapshot.accounts.some(account => account.accountId === accountId && account.active)) return
    this.stopPolling()
    this.publish({ ...this.snapshot, busy: true })
    try {
      const response = await request<AccountServerState>(OPENAI_CODEX_AUTH_ACCOUNTS_PATH, 'POST', undefined, { accountId })
      this.publish({ ...this.splitServerState(response), busy: false })
    } catch (error: unknown) {
      this.publish({ status: this.failure(error), busy: false, accounts: this.snapshot.accounts })
    } finally {
      this.schedule()
    }
  }

  /** Stop local observation on plugin unload; do not log out the server account. */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
    this.popup?.close()
    this.popup = null
    this.listeners.clear()
    this.snapshot = { status: { status: 'loading' }, busy: false, accounts: [] }
  }
}

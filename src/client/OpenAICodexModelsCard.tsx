/** Compact Models account entry with quota disclosure and shared configuration. */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { OpenAICodexSettingsInjected } from './OpenAICodexSettings.tsx'
import { AccountActions, AccountFeedback, accountStatusLabel, dotStyle, UsageLimits } from './OpenAICodexSettings.tsx'
import { OpenAICodexConfiguration } from './OpenAICodexConfiguration.tsx'

export type OpenAICodexModelsCardInjected = Required<Pick<OpenAICodexSettingsInjected, 't' | 'account'>>
  & Pick<Partial<OpenAICodexSettingsInjected>, 'configScope'>

const buttonStyle: CSSProperties = { padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 999, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const secondaryStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
const accountSelectStyle: CSSProperties = { minWidth: 180, maxWidth: '100%', padding: '7px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13 }

const UNAVAILABLE_CONFIG = { status: 'unavailable' as const, value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' as const }

function AccountFallbackToggle({ t, configScope, accountCount }: Pick<OpenAICodexModelsCardInjected, 't' | 'configScope'> & { accountCount: number }) {
  const subscribe = useCallback((listener: () => void) => configScope?.subscribe(listener) ?? (() => undefined), [configScope])
  const getSnapshot = useCallback(() => configScope?.getSnapshot() ?? UNAVAILABLE_CONFIG, [configScope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (configScope === undefined || snapshot.value === undefined) return null
  const enabled = snapshot.value.enableAccountFallback
  const editable = snapshot.status === 'ready' && snapshot.writable && !busy && accountCount > 1
  return <div aria-busy={busy} style={{ marginTop: 12 }}><label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: editable ? 'pointer' : 'default' }}>
    <input type="checkbox" checked={enabled} disabled={!editable} aria-label={t('enableAccountFallback')}
      onChange={event => {
        const next = event.currentTarget.checked
        setBusy(true)
        setFailed(false)
        void configScope.set('enableAccountFallback', next)
          .catch(() => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }} />
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ ...secondaryStyle, fontWeight: 500 }}>{t('enableAccountFallback')}</span>
      <span style={secondaryStyle}>{accountCount > 1 ? t('enableAccountFallbackHelp') : t('enableAccountFallbackNeedsAccounts')}</span>
    </span>
  </label>{failed ? <span role="alert" style={{ ...secondaryStyle, display: 'block', marginTop: 4 }}>{t('accountFallbackSaveFailed')}</span> : null}</div>
}

/** Native modality contains keyboard focus and restores it to More settings on close. */
function ConfigurationDialog({ t, configScope, onClose }: Pick<OpenAICodexModelsCardInjected, 't' | 'configScope'> & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])
  const close = (): void => {
    dialog.current?.close()
    onClose()
  }
  return <dialog ref={dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close() }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      close()
    }}
    style={{ boxSizing: 'border-box', width: 'min(720px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', padding: 20, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1, white)', color: 'var(--dsw-alias-label-primary)', margin: 'auto' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <h2 id={titleId} style={{ margin: 0, fontSize: 18 }}>{t('moreSettingsTitle')}</h2>
      <button type="button" style={buttonStyle} onClick={close}>{t('closeSettings')}</button>
    </div>
    <p style={secondaryStyle}>{t('settingsSaveHint')}</p>
    <OpenAICodexConfiguration t={t} {...configScope === undefined ? {} : { scope: configScope }} />
  </dialog>
}

export function OpenAICodexModelsCard({ t, account, configScope }: OpenAICodexModelsCardInjected) {
  const [expanded, setExpanded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const detailsId = useId()
  const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot)
  const { status } = snapshot
  const accounts = snapshot.accounts ?? []
  const label = accountStatusLabel(status.status, t)
  const activeAccount = accounts.find(candidate => candidate.active)
  useEffect(() => { if (status.status !== 'signed-in') setExpanded(false) }, [status.status])
  return <div style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '12px 14px', color: 'var(--dsw-alias-label-primary)' }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
      <span style={{ fontSize: 14, lineHeight: '22px', fontWeight: 500 }}>{t('modelsProviderName')}</span>
      <span aria-hidden="true" style={{ ...dotStyle(status.status), width: 8, height: 8 }} />
      <span role="status" style={{ ...secondaryStyle, flex: 1 }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginLeft: 'auto' }}>
        {status.status === 'signed-in' && <button type="button" style={buttonStyle} disabled={snapshot.busy}
          onClick={() => { void account.signIn() }}>{t('addAccount')}</button>}
        <AccountActions t={t} store={account} snapshot={snapshot} compact />
        {status.status === 'signed-in' && <button type="button" aria-expanded={expanded} aria-controls={detailsId}
          onClick={() => { setExpanded(!expanded) }} style={buttonStyle}>{t(expanded ? 'hideQuota' : 'viewQuota')}</button>}
      </div>
    </div>
    <div style={{ ...secondaryStyle, marginTop: 4 }}>{t('modelsProviderSupport')}</div>
    {status.status === 'signed-in' && accounts.length > 0 && <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
      <label htmlFor={`${detailsId}-account`} style={{ ...secondaryStyle, fontWeight: 500 }}>{t('savedAccounts')}</label>
      <select id={`${detailsId}-account`} aria-label={t('savedAccounts')} style={accountSelectStyle}
        value={activeAccount?.accountId ?? ''} disabled={snapshot.busy}
        onChange={event => { void account.activate(event.currentTarget.value) }}>
        {accounts.map(saved => <option key={saved.accountId} value={saved.accountId}>
          {saved.email === undefined ? saved.displayName : `${saved.displayName} · ${saved.email}`}
        </option>)}
      </select>
      <span style={secondaryStyle}>{t('activeAccountHelp')}</span>
    </div>}
    {status.status === 'signed-in' && <AccountFallbackToggle t={t} accountCount={accounts.length} {...configScope === undefined ? {} : { configScope }} />}
    <AccountFeedback t={t} snapshot={snapshot} />
    {expanded && status.status === 'signed-in' && <div id={detailsId} style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', marginTop: 12, paddingTop: 12 }}>
      <UsageLimits t={t} usage={status.usage} heading={false} {...status.quotaError === undefined ? {} : { quotaError: status.quotaError }} />
    </div>}
    <div style={{ ...secondaryStyle, marginTop: 12 }}>
      <span>{t('modelsAccountHelp')}</span>{' '}
      <button type="button" onClick={() => { setSettingsOpen(true) }} style={{ ...buttonStyle, padding: 0, border: 0, fontSize: 'inherit', textDecoration: 'underline' }}>{t('moreSettings')}</button>
    </div>
    {settingsOpen && <ConfigurationDialog t={t} {...configScope === undefined ? {} : { configScope }} onClose={() => { setSettingsOpen(false) }} />}
  </div>
}

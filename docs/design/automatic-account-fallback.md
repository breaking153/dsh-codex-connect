# Automatic account fallback

Status: implementation specification for the narrow PR built on the multi-account foundation.

## Intent

When explicitly enabled, a Codex request that ends because the active ChatGPT account has a confirmed terminal quota or credit exhaustion may continue once on another saved account. The feature is plugin-global, disabled by default, and never changes provider or proxy configuration.

## Safety contract

- Trigger only on an allowlisted provider machine code. A plain HTTP 429, network failure, refresh failure, or human-language substring is insufficient.
- Never retry after a tool call has started or appeared in the failed response.
- Retry the original request context. Do not append synthetic assistant text or a hidden continuation instruction.
- Preserve already delivered text and suppress only an exact repeated prefix from the replacement stream.
- Attempt each saved account at most once and stop when the bounded account list is exhausted.
- Resolve or refresh the candidate credential before activation.
- Activate with compare-and-swap against the failed active account. Manual account changes, logout, deletion, and another fallback win races.
- If replacement startup fails after activation, conditionally restore the original account. Rollback must never overwrite a newer switch.
- Never log tokens, raw provider bodies, or raw error messages. Audit data is limited to session id, transition, account ids, reason code, attempt, and timestamp.

## Error allowlist

The initial allowlist is `usage_limit_reached`, `usage_not_included`, and `insufficient_quota`. Matching is case-sensitive after structured JSON extraction or exact token extraction from the flattened provider error. `rate_limit_exceeded` is deliberately excluded because it may be transient.

The installed pi-ai version currently flattens Codex HTTP error objects into `AssistantMessage.errorMessage`. The wrapper therefore inspects a clone of a failed JSON response before pi-ai consumes it, with a hard 64 KiB body limit, and retains only an allowlisted `error.code`/`error.type`. The compatibility extractor also accepts an exact standalone allowlisted machine-code terminal error. Friendly prose alone does not authorize switching, and neither the response body nor prose is retained in audit records.

## State machine

1. Pin the request's active-account snapshot.
2. Stream with that request credential.
3. On an allowlisted terminal error, reject fallback if disabled, aborted, or any tool call started.
4. Choose the next stable, untried account from the pinned account order.
5. Resolve/refresh that account through an account-scoped credential view without changing the active account.
6. Compare-and-swap active account from the failed id to the candidate id.
7. Emit a redacted, session-associated Host audit record and start the replacement stream with the resolved token.
8. On pre-terminal replacement startup failure, compare-and-swap back from the candidate to the original and append the rollback result.
9. On success, leave the selected account active and append completion. On exhaustion, surface the original terminal error.

Each request owns its attempted-account set. Concurrent sessions can independently preflight candidates, but activation is serialized by the credential file lock. A request whose compare-and-swap loses observes the newer active account and does not overwrite it.

## User surface

The opt-in setting is shown with account management in the existing Models/provider account card. The active account selector reflects a successful switch. Every transition is also emitted as a structured, redacted Host log record associated with the request session. DSH `0.1.2-alpha.2` does not expose an ignorable plugin-event append API, so this implementation deliberately avoids writing an unknown required event into durable session history and avoids modifying model-visible conversation history.

## Acceptance tests

- Disabled by default and bypasses all fallback work.
- Exact allowlisted codes trigger; generic 429 and prose do not.
- Tool-start/tool-call paths never replay.
- Partial text is joined without repeating an exact prefix.
- Candidate refresh happens before activation.
- Candidate refresh failure leaves the original active.
- Startup failure rolls back only if the candidate is still active.
- Manual and concurrent switches are never overwritten.
- Account attempts are bounded and non-repeating.
- Audit events contain no credentials or raw error text.
- A real terminal-quota account validation is recorded before merge; it is not replaceable by a fixture.

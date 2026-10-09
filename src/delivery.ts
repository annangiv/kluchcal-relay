/**
 * How the relay reacts to a failed downstream delivery.
 *
 * - `retry`: the destination definitely did not accept the event (it answered
 *   with a non-2xx status, or the connection could not be opened). Repeating it
 *   cannot duplicate anything, so it is retried with a bounded backoff.
 * - `uncertain`: the request may have been delivered and processed before the
 *   reply was lost (timeout/abort after sending, connection dropped). Unless the
 *   owner declared an idempotent receiver, this stops for owner review.
 */
export type Outcome = { kind: 'delivered' } | { kind: 'retry'; retryAfterMs?: number } | { kind: 'uncertain' }

/** Total delivery attempts per event (first try plus retries). */
export const MAX_ATTEMPTS = 10
const FIRST_RETRY_MS = 10_000
const MAX_RETRY_MS = 8 * 3600_000

/** Any HTTP answer means the destination saw the request and did not accept it
 * (4xx, 5xx, 408 and 429 alike); none of them can be a silent success. */
export function classifyResponse(status: number, retryAfter?: string | null): Outcome {
  if (status >= 200 && status < 300) return { kind: 'delivered' }
  const seconds = Number(retryAfter)
  return Number.isFinite(seconds) && seconds > 0 ? { kind: 'retry', retryAfterMs: seconds * 1000 } : { kind: 'retry' }
}

/** Errors raised before the request could reach the destination. Anything
 * else (our timeout abort, a dropped connection, unknown errors) is uncertain. */
const NOT_SENT = /ECONNREFUSED|connection refused|ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|name not resolved|could not resolve|certificate|TLS|SSL|handshake/i

export function classifyError(error: unknown): Outcome {
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'uncertain' }
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)
  return NOT_SENT.test(text) ? { kind: 'retry' } : { kind: 'uncertain' }
}

/** Delay before the next try after `attempts` failed attempts (1-based):
 * 10 s, 30 s, 90 s, 4.5 min, 13.5 min, 40 min, 2 h, 6 h, 8 h — about 17 hours
 * in total. A destination's Retry-After is honoured up to the 8-hour cap.
 * Returns null once `MAX_ATTEMPTS` attempts have failed. */
export function retryDelay(attempts: number, retryAfterMs?: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null
  const backoff = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 3 ** Math.max(0, attempts - 1))
  return retryAfterMs ? Math.min(MAX_RETRY_MS, Math.max(backoff, retryAfterMs)) : backoff
}

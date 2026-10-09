import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyResponse, classifyError, retryDelay, MAX_ATTEMPTS } from './delivery.ts'

test('only 2xx is delivered; every HTTP answer is a definite, retryable failure', () => {
  assert.deepEqual(classifyResponse(200), { kind: 'delivered' })
  assert.deepEqual(classifyResponse(204), { kind: 'delivered' })
  for (const status of [400, 401, 403, 404, 408, 410, 422, 429, 500, 502, 503, 504]) assert.equal(classifyResponse(status).kind, 'retry', String(status))
  assert.deepEqual(classifyResponse(429, '120'), { kind: 'retry', retryAfterMs: 120_000 })
  assert.deepEqual(classifyResponse(503, 'Wed, 21 Oct 2026 07:28:00 GMT'), { kind: 'retry' })
})

test('connection, DNS and TLS failures are definite; timeouts and dropped connections are uncertain', () => {
  for (const message of ['connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND hooks.example', 'DNS lookup failed', 'TLS peer certificate is not trusted', 'SSL handshake failed'])
    assert.equal(classifyError(new TypeError(message)).kind, 'retry', message)
  const abort = new Error('The operation was aborted'); abort.name = 'AbortError'
  assert.equal(classifyError(abort).kind, 'uncertain')
  assert.equal(classifyError(new TypeError('Network connection lost.')).kind, 'uncertain')
  assert.equal(classifyError(new Error('socket hang up')).kind, 'uncertain')
  assert.equal(classifyError('weird').kind, 'uncertain')
  assert.equal(classifyError(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.1:443') })).kind, 'retry')
})

test('retries are bounded to ten attempts over roughly a day', () => {
  const delays: number[] = []
  for (let attempts = 1; ; attempts++) { const d = retryDelay(attempts); if (d === null) break; delays.push(d) }
  assert.equal(delays.length, MAX_ATTEMPTS - 1)
  assert.equal(delays[0], 10_000)
  const total = delays.reduce((a, b) => a + b, 0)
  assert.ok(total > 12 * 3600_000 && total < 24 * 3600_000, `total ${total}`)
  assert.equal(retryDelay(1, 60_000), 60_000)
  assert.equal(retryDelay(1, 48 * 3600_000), 8 * 3600_000)
  assert.equal(retryDelay(MAX_ATTEMPTS), null)
})

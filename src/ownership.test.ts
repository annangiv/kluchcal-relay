import test from 'node:test'
import assert from 'node:assert/strict'
import { ed25519 } from '@noble/curves/ed25519.js'
import { toB64 } from './crypto.ts'
import { registerHooks } from 'node:module'
import { tokenMatches, validBinding, sameBinding } from './ownership.ts'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }', shortCircuit: true }
  if (specifier.startsWith('./') && !specifier.endsWith('.ts') && !specifier.endsWith('.js')) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { RelayKeys, default: worker } = await import('./index.ts')
const binding = { integration_id: 'integration', form_id: 'form', workspace_id: 'workspace' }
function relayState(env = {}) {
  const data = new Map<string, unknown>()
  const storage = { async get(key: string) { return data.get(key) }, async put(key: string, value: unknown) { data.set(key, value) }, async delete(key: string) { data.delete(key) }, async transaction(fn: (tx: unknown) => unknown) { return fn(storage) }, async list({prefix}: {prefix:string}) { return new Map([...data].filter(([key])=>key.startsWith(prefix))) }, async setAlarm() {}, async deleteAlarm() {} }
  return { state: new RelayKeys({ storage, async blockConcurrencyWhile(fn:()=>unknown){return fn()} } as never, env as never), data }
}
test('owner token is required; a public key or wrong token never authenticates', async () => {
  const token = 'a'.repeat(40)
  assert.equal(await tokenMatches(null, token), false)
  assert.equal(await tokenMatches(`Bearer ${'b'.repeat(40)}`, token), false)
  assert.equal(await tokenMatches(`Bearer ${token}`, token), true)
  assert.equal(await tokenMatches('Bearer short', 'short'), false)
  assert.equal(validBinding(binding), true)
  assert.equal(validBinding({ ...binding, form_id: '../other' }), false)
  assert.equal(sameBinding(binding, { ...binding, workspace_id: 'attacker' }), false)
})
test('pairing cannot overwrite; tenant/form checks, expiry and revocation fail closed', async () => {
  const {state, data} = relayState()
  assert.equal(await state.bound(binding), false)
  assert.equal(await state.pair(binding), true)
  assert.equal(await state.pair({ ...binding, form_id: 'attacker' }), false)
  assert.equal(await state.bound(binding), true)
  assert.equal(await state.bound({ ...binding, workspace_id: 'attacker' }), false)
  const saved = data.get('binding:integration') as Record<string, unknown>
  data.set('binding:integration', {...saved, expires_at: 0})
  assert.equal(await state.bound(binding), false)
  data.set('binding:integration', saved)
  assert.equal(await state.revoke({ ...binding, form_id: 'attacker' }), false)
  assert.equal(await state.revoke(binding), true)
  assert.equal(await state.bound(binding), false)
  assert.equal(await state.pair(binding), false)
})
test('definite failures retry by default; only an ambiguous send blocks until the owner retries', async () => {
  let calls=0,mode:'status'|'lost'='status'
  const {state,data}=relayState({WEBHOOK_URL:'https://example.invalid',WEBHOOK_SERVICE:{async fetch(){calls++;if(mode==='lost')throw new TypeError('Network connection lost.');return new Response('',{status:calls===1?500:200})}}})
  await state.pair(binding)
  const delivery={integration_id:binding.integration_id,workspace_id:binding.workspace_id,form:{id:binding.form_id,title:'Test'},event:'deleted',booking:{id:'booking',version:1}}
  const job=(id='booking')=>data.get(`booking:integration:${id}`) as {blocked?:boolean;blockedReason?:string;next:number;attempts:number;sent:boolean}
  await state.accept(delivery)
  await state.alarm();assert.equal(calls,1)
  // A 500 is a definite rejection: not blocked, retried after the backoff.
  assert.equal(job().blocked,undefined);assert.equal(job().attempts,1);assert.ok(job().next>Date.now())
  job().next=Date.now();await state.alarm();assert.equal(calls,2);assert.equal(job().sent,true)
  await state.accept(delivery);await state.alarm();assert.equal(calls,2)
  // A dropped connection after sending is uncertain: blocked for owner review.
  mode='lost'
  await state.accept({...delivery,booking:{id:'lost',version:1}});await state.alarm();assert.equal(calls,3)
  assert.equal(job('lost').blocked,true);assert.equal(job('lost').blockedReason,'uncertain')
  await state.alarm();assert.equal(calls,3)
  assert.equal(await state.retry({...binding,workspace_id:'attacker'},'lost'),false)
  mode='status';assert.equal(await state.retry(binding,'lost'),true)
  await state.alarm();assert.equal(calls,4);assert.equal(job('lost').sent,true)
  await state.revoke(binding)
  await state.accept({...delivery,booking:{id:'another',version:1}});await state.alarm();assert.equal(calls,4)
})

test('delivery to an unbound integration is answered with a recognizable code', async () => {
  const env = await requestEnv({})
  const { state } = relayState()
  const unbound = { ...env, KEYS: { idFromName() { return 'relay' }, get() { return state } } }
  const signing = ed25519.utils.randomSecretKey()
  const response = await worker.fetch(signedRequest(signing, 'kluchcal'), { ...unbound, KLUCHCAL_PUBLIC_KEY: toB64(ed25519.getPublicKey(signing)) } as never)
  assert.equal(response.status, 403)
  assert.equal((await response.json() as {code:string}).code, 'binding_inactive')
})

test('new and legacy pinned keys and signed header pairs stay interoperable', async () => {
  const signing = ed25519.utils.randomSecretKey()
  const publicKey = toB64(ed25519.getPublicKey(signing))
  const wrongKey = toB64(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
  for (const [settings, prefix] of [
    [{ KLUCHCAL_PUBLIC_KEY: publicKey }, 'kluchcal'],
    [{ ORAPLOT_PUBLIC_KEY: publicKey }, 'oraplot'],
    [{ KLUCHCAL_PUBLIC_KEY: publicKey, ORAPLOT_PUBLIC_KEY: wrongKey }, 'oraplot'],
  ] as const) {
    const env = await requestEnv(settings)
    assert.equal((await worker.fetch(signedRequest(signing, prefix), env as never)).status, 202)
    const health = await (await worker.fetch(new Request('https://relay.example/'), env as never)).json() as {service: string}
    assert.equal(health.service, 'kluchcal-relay')
  }
  const env = await requestEnv({ KLUCHCAL_PUBLIC_KEY: publicKey })
  const mixed = signedRequest(signing, 'oraplot')
  mixed.headers.set('x-kluchcal-timestamp', mixed.headers.get('x-oraplot-timestamp')!)
  assert.equal((await worker.fetch(mixed, env as never)).status, 401, 'partial new headers cannot borrow a legacy signature')
})

test('new origin takes precedence; legacy key path fallback is limited to absent routes', async () => {
  const signing = ed25519.utils.randomSecretKey()
  const key = toB64(ed25519.getPublicKey(signing))
  const oldFetch = globalThis.fetch
  try {
    const cases = [
      { settings: {}, origin: 'https://kluchcal.com', missing: 0 },
      { settings: { ORAPLOT_ORIGIN: 'https://legacy.example/' }, origin: 'https://legacy.example', missing: 404 },
      { settings: { KLUCHCAL_ORIGIN: 'https://new.example/', ORAPLOT_ORIGIN: 'https://wrong.example' }, origin: 'https://new.example', missing: 410 },
    ]
    for (const { settings, origin, missing } of cases) {
      const urls: string[] = []
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input); urls.push(url)
        if (missing && url.endsWith('/.well-known/kluchcal-delivery-key')) return new Response('', { status: missing })
        return Response.json({ public_key: key })
      }) as typeof fetch
      const env = await requestEnv(settings)
      assert.equal((await worker.fetch(signedRequest(signing, 'kluchcal'), env as never)).status, 202)
      assert.deepEqual(urls, [origin + '/.well-known/kluchcal-delivery-key', ...(missing ? [origin + '/.well-known/oraplot-delivery-key'] : [])])
    }
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('', { status: 503 }) }) as typeof fetch
    const env = await requestEnv({ KLUCHCAL_ORIGIN: 'https://unavailable.example' })
    assert.equal((await worker.fetch(signedRequest(signing, 'oraplot'), env as never)).status, 401)
    assert.ok(urls.length > 0)
    assert.ok(urls.every(url => url === 'https://unavailable.example/.well-known/kluchcal-delivery-key'))
  } finally { globalThis.fetch = oldFetch }
})

async function requestEnv(settings: Record<string, string>) {
  const { state } = relayState()
  await state.pair(binding)
  return { ...settings, WEBHOOK_URL: 'https://destination.example', KEYS: { idFromName() { return 'relay' }, get() { return state } } }
}
function signedRequest(secret: Uint8Array, prefix: string) {
  const body = JSON.stringify({ ...binding, form: { id: binding.form_id }, event: 'deleted', booking: { id: 'booking', version: 1 } })
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = toB64(ed25519.sign(new TextEncoder().encode(`${ts}.${body}`), secret))
  return new Request('https://relay.example/deliver', { method: 'POST', body, headers: { [`x-${prefix}-timestamp`]: ts, [`x-${prefix}-signature`]: signature } })
}

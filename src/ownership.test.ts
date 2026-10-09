import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { tokenMatches, validBinding, sameBinding } from './ownership.ts'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }', shortCircuit: true }
  if (specifier.startsWith('./') && !specifier.endsWith('.ts') && !specifier.endsWith('.js')) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { RelayKeys } = await import('./index.ts')
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
test('ambiguous downstream delivery blocks until owner explicitly retries', async () => {
  let calls=0
  const {state}=relayState({WEBHOOK_URL:'https://example.invalid',WEBHOOK_SERVICE:{async fetch(){calls++;return new Response('',{status:calls===1?500:200})}}})
  await state.pair(binding)
  const delivery={integration_id:binding.integration_id,workspace_id:binding.workspace_id,form:{id:binding.form_id,title:'Test'},event:'deleted',booking:{id:'booking',version:1}}
  await state.accept(delivery)
  await state.alarm();assert.equal(calls,1)
  await state.accept(delivery);await state.alarm();assert.equal(calls,1)
  assert.equal(await state.retry({...binding,workspace_id:'attacker'},'booking'),false)
  assert.equal(await state.retry(binding,'booking'),true)
  await state.alarm();assert.equal(calls,2)
  await state.accept(delivery);await state.alarm();assert.equal(calls,2)
  await state.revoke(binding)
  await state.accept({...delivery,booking:{id:'another',version:1}});await state.alarm();assert.equal(calls,2)
})

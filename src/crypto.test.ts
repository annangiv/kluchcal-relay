// Interop test: data sealed with libsodium, exactly as Oraplot's browser does
// it, must open with the relay's @noble implementation. Run: npm test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sodium from 'libsodium-wrappers-sumo'
import { decryptSubmission, fromB64, sealOpen, toB64 } from './crypto.ts'

test('relay opens what the Oraplot browser seals', async () => {
  await sodium.ready
  const s = sodium
  const relay = s.crypto_box_keypair() // the relay's own key pair
  const form = s.crypto_box_keypair() // a form key pair

  // Owner's browser: seal the form secret key to the relay.
  const grant = toB64(s.crypto_box_seal(form.privateKey, relay.publicKey))

  // Respondent's browser: per-response key, sealed to the form, AEAD answers.
  const answers = { f_name: 'Ada', f_note: 'relay interop ✓ ünïcode', f_rate: 4 }
  const responseKey = s.crypto_aead_xchacha20poly1305_ietf_keygen()
  const nonce = s.randombytes_buf(24)
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(JSON.stringify({ v: 1, answers, submitted_at: 0 })),
    'oraplot:response:v1:form-9:3',
    null,
    nonce,
    responseKey,
  )
  const blob = new Uint8Array(nonce.length + ct.length)
  blob.set(nonce)
  blob.set(ct, nonce.length)
  const sub = { sealed_key: toB64(s.crypto_box_seal(responseKey, form.publicKey)), ciphertext: toB64(blob) }

  const env = decryptSubmission(relay.privateKey, { form_id: 'form-9', key_version: 3, sealed_form_sk: grant, ...sub })
  assert.deepEqual(env.answers, answers)

  // Wrong form id (AAD) or a flipped byte must fail.
  assert.throws(() => decryptSubmission(relay.privateKey, { form_id: 'form-X', key_version: 3, sealed_form_sk: grant, ...sub }))
  const bad = fromB64(sub.sealed_key)
  bad[40] ^= 1
  assert.throws(() => sealOpen(bad, form.publicKey, form.privateKey))
})

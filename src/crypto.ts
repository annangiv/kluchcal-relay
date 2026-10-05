/**
 * Decryption for the relay, matching libsodium byte for byte with pure-JS
 * audited primitives (@noble). Cloudflare Workers can't compile WebAssembly
 * at runtime, so libsodium.js itself can't run here.
 *
 *   crypto_box_seal_open:  epk || box, nonce = BLAKE2b-192(epk || pk),
 *                          key = HSalsa20(X25519(sk, epk), 0), XSalsa20-Poly1305
 *   crypto_aead_xchacha20poly1305_ietf_decrypt: nonce(24) || ciphertext || tag
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hsalsa, xsalsa20poly1305 } from '@noble/ciphers/salsa.js'
import { blake2b } from '@noble/hashes/blake2.js'

/** "expand 32-byte k" as little-endian words. */
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])

function words(bytes: Uint8Array): Uint32Array {
  // Workers run on little-endian hosts; copy so alignment is guaranteed.
  return new Uint32Array(bytes.slice().buffer)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** crypto_box_beforenm: HSalsa20 of the X25519 shared secret with a zero nonce. */
function boxKey(theirPublic: Uint8Array, mySecret: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(mySecret, theirPublic)
  const out = new Uint32Array(8)
  hsalsa(SIGMA, words(shared), new Uint32Array(4), out)
  return new Uint8Array(out.buffer)
}

export function publicKeyFor(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey)
}

/** libsodium crypto_box_seal_open. Throws if the box doesn't authenticate. */
export function sealOpen(sealed: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (sealed.length < 32 + 16) throw new Error('sealed box too short')
  const epk = sealed.subarray(0, 32)
  const nonce = blake2b(concat(epk, publicKey), { dkLen: 24 })
  return xsalsa20poly1305(boxKey(epk, secretKey), nonce).decrypt(sealed.subarray(32))
}

/** libsodium XChaCha20-Poly1305 (IETF) with the Oraplot `nonce || ct` framing. */
export function aeadOpen(blob: Uint8Array, key: Uint8Array, context: string): Uint8Array {
  if (blob.length < 24 + 16) throw new Error('ciphertext too short')
  return xchacha20poly1305(key, blob.subarray(0, 24), new TextEncoder().encode(context)).decrypt(blob.subarray(24))
}

export function fromB64(value: string): Uint8Array {
  const bin = atob(value.trim())
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/**
 * The same chain a Oraplot browser follows: the relay's grant opens the form
 * key, the form key opens the response key, the response key opens the answers.
 */
export function decryptSubmission(
  relaySecretKey: Uint8Array,
  input: { form_id: string; key_version: number; sealed_form_sk: string; sealed_key: string; ciphertext: string },
): { v: number; answers: Record<string, unknown>; submitted_at: number } {
  const relayPublic = publicKeyFor(relaySecretKey)
  const formSecret = sealOpen(fromB64(input.sealed_form_sk), relayPublic, relaySecretKey)
  const formPublic = publicKeyFor(formSecret)
  const responseKey = sealOpen(fromB64(input.sealed_key), formPublic, formSecret)
  const plain = aeadOpen(
    fromB64(input.ciphertext),
    responseKey,
    `oraplot:response:v1:${input.form_id}:${input.key_version}`,
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

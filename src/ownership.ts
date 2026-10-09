export type Binding = { integration_id: string; form_id: string; workspace_id: string }
export function validBinding(value: unknown): value is Binding {
  if (!value || typeof value !== 'object') return false
  return ['integration_id', 'form_id', 'workspace_id'].every(key => {
    const item = (value as Record<string, unknown>)[key]
    return typeof item === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item)
  })
}
export function sameBinding(a: Binding, b: Binding): boolean {
  return a.integration_id === b.integration_id && a.form_id === b.form_id && a.workspace_id === b.workspace_id
}
export async function tokenMatches(header: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ') || header.length > 1024) return false
  const enc = new TextEncoder()
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(secret)))
  const supplied = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(header.slice(7))))
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ supplied[i]
  return difference === 0
}

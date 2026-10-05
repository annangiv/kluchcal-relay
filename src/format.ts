/**
 * Shapes the readable response for the webhook it's going to. Slack, Discord,
 * Google Chat and Microsoft Teams only accept their own message format;
 * everything else (Zapier, Make, n8n, your API) gets flat JSON:
 * { fields: { question: answer } }. WEBHOOK_FORMAT overrides the guess.
 */
export type Readable = {
  source: 'oraplot'
  form: { id: string; title: string }
  submission_id: string
  submitted_at: string
  answers: { id: string; question: string; type: string; answer: unknown }[]
}

export type Target = 'slack' | 'discord' | 'google_chat' | 'teams' | 'json'

const TARGETS: Target[] = ['slack', 'discord', 'google_chat', 'teams', 'json']

/** The format to send: WEBHOOK_FORMAT if it names one, else a guess from the URL. */
export function targetFor(webhookUrl: string, override?: string): Target {
  const forced = override?.trim().toLowerCase() as Target | undefined
  if (forced && TARGETS.includes(forced)) return forced
  let host = ''
  let path = ''
  try {
    const u = new URL(webhookUrl)
    host = u.hostname
    path = u.pathname
  } catch {
    return 'json'
  }
  if (host === 'hooks.slack.com' && path.startsWith('/services/')) return 'slack'
  if (/^(ptb\.|canary\.)?discord(app)?\.com$/.test(host) && path.startsWith('/api/webhooks/')) return 'discord'
  if (host === 'chat.googleapis.com') return 'google_chat'
  // Teams: the old Office 365 connector hooks, and Teams "Workflows" webhooks,
  // which are Power Automate flows.
  if (host.endsWith('.webhook.office.com')) return 'teams'
  if ((host.endsWith('.logic.azure.com') || host.endsWith('.api.powerplatform.com')) && path.includes('/workflows/')) {
    return 'teams'
  }
  return 'json'
}

/** One answer as text: lists joined, files by name, empty as a dash. */
export function answerText(answer: unknown): string {
  if (answer === null || answer === undefined || answer === '') return '—'
  if (Array.isArray(answer)) {
    if (answer.length === 0) return '—'
    return answer.map((x) => (x && typeof x === 'object' && 'name' in x ? String(x.name) : answerText(x))).join(', ')
  }
  if (typeof answer === 'object') return JSON.stringify(answer)
  return String(answer)
}

/** Answer value for JSON: files by name, everything else as answered. */
function jsonAnswer(answer: unknown): unknown {
  if (Array.isArray(answer)) return answer.map((x) => (x && typeof x === 'object' && 'name' in x ? String(x.name) : x))
  return answer ?? null
}

/** { question: answer }, so automations map by question, not position. Repeated questions get " (2)". */
export function fieldsOf(r: Readable): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const a of r.answers) {
    const base = a.question.trim() || a.id
    let key = base
    for (let n = 2; key in fields; n++) key = `${base} (${n})`
    fields[key] = jsonAnswer(a.answer)
  }
  return fields
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** Plain-text lines shared by the chat formats: "*Question*\nanswer". */
function lines(r: Readable, bold: (s: string) => string, max: number) {
  const head = `${bold(`New response: ${r.form.title}`)}\n`
  let text = head
  for (const a of r.answers) {
    const next = `\n${bold(a.question)}\n${answerText(a.answer)}\n`
    if (text.length + next.length > max - 40) {
      text += '\n…more answers in Oraplot'
      break
    }
    text += next
  }
  return clip(text, max)
}

export function bodyFor(target: Target, r: Readable): unknown {
  switch (target) {
    case 'slack':
      return { text: lines(r, (s) => `*${s.replace(/\*/g, '')}*`, 3000) }
    case 'discord':
      return {
        username: 'Oraplot',
        content: lines(r, (s) => `**${s.replace(/\*/g, '')}**`, 2000),
        allowed_mentions: { parse: [] },
      }
    case 'google_chat':
      return { text: lines(r, (s) => `*${s.replace(/\*/g, '')}*`, 4000) }
    case 'teams':
      // Teams shows the Adaptive Card and ignores the rest. The plain fields ride
      // along, because Power Automate flows on the same host may want JSON.
      return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: teamsCard(r) }], ...plainJson(r) }
    default:
      return plainJson(r)
  }
}

function plainJson(r: Readable) {
  return {
    source: r.source,
    form: r.form,
    submission_id: r.submission_id,
    submitted_at: r.submitted_at,
    fields: fieldsOf(r),
  }
}

/** Teams caps a message at ~28 KB, so answers are clipped and long forms cut off. */
function teamsCard(r: Readable) {
  const facts = r.answers.slice(0, 40).map((a) => ({ title: clip(a.question, 100), value: clip(answerText(a.answer), 1000) }))
  const body: unknown[] = [
    { type: 'TextBlock', text: `New response: ${r.form.title}`, weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'FactSet', facts },
  ]
  if (r.answers.length > facts.length) body.push({ type: 'TextBlock', text: '…more answers in Oraplot', isSubtle: true, wrap: true })
  return { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body }
}

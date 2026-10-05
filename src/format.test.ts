import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerText, bodyFor, targetFor, type Readable } from './format.ts'

const r: Readable = {
  source: 'oraplot',
  form: { id: 'f', title: 'Patient intake' },
  submission_id: 's',
  submitted_at: '2026-09-28T00:00:00.000Z',
  answers: [
    { id: 'a', question: 'Full name', type: 'short_text', answer: 'Robin' },
    { id: 'b', question: 'Symptoms', type: 'checkboxes', answer: ['Cough', 'Fever'] },
    { id: 'c', question: 'Card', type: 'file', answer: [{ name: 'card.jpg', type: 'image/jpeg', size: 1 }] },
    { id: 'd', question: 'Notes', type: 'long_text', answer: null },
  ],
}

test('detects chat webhooks, everything else is JSON', () => {
  assert.equal(targetFor('https://hooks.slack.com/services/T/B/x'), 'slack')
  assert.equal(targetFor('https://discord.com/api/webhooks/1/abc'), 'discord')
  assert.equal(targetFor('https://discordapp.com/api/webhooks/1/abc'), 'discord')
  assert.equal(targetFor('https://chat.googleapis.com/v1/spaces/x/messages?key=k'), 'google_chat')
  assert.equal(targetFor('https://hooks.zapier.com/hooks/catch/1/2/'), 'json')
  assert.equal(targetFor('https://hook.us1.make.com/abc'), 'json')
  assert.equal(targetFor('https://evil.com/hooks.slack.com/services/x'), 'json')
  assert.equal(targetFor('not a url'), 'json')
})

test('answers read as text', () => {
  assert.equal(answerText(['Cough', 'Fever']), 'Cough, Fever')
  assert.equal(answerText([{ name: 'card.jpg' }]), 'card.jpg')
  assert.equal(answerText(null), '—')
  assert.equal(answerText(4), '4')
})

test('slack and discord get their own message shape', () => {
  const slack = bodyFor('slack', r) as { text: string }
  assert.match(slack.text, /\*New response: Patient intake\*/)
  assert.match(slack.text, /\*Symptoms\*\nCough, Fever/)
  const discord = bodyFor('discord', r) as { content: string; allowed_mentions: unknown }
  assert.match(discord.content, /\*\*Full name\*\*\nRobin/)
  assert.deepEqual(discord.allowed_mentions, { parse: [] })
})

test('long responses are cut to the chat limit', () => {
  const big = { ...r, answers: Array.from({ length: 200 }, (_, i) => ({ id: `${i}`, question: `Q${i}`, type: 'long_text', answer: 'x'.repeat(100) })) }
  const d = bodyFor('discord', big) as { content: string }
  assert.ok(d.content.length <= 2000)
  assert.match(d.content, /more answers in Oraplot/)
})

test('webhooks get flat fields keyed by question', () => {
  const dup = { ...r, answers: [...r.answers, { id: 'e', question: 'Full name', type: 'short_text', answer: 'Sam' }] }
  const j = bodyFor('json', dup) as Record<string, unknown>
  assert.deepEqual(Object.keys(j), ['source', 'form', 'submission_id', 'submitted_at', 'fields'])
  assert.deepEqual(j.fields, {
    'Full name': 'Robin',
    Symptoms: ['Cough', 'Fever'],
    Card: ['card.jpg'],
    Notes: null,
    'Full name (2)': 'Sam',
  })
})

test('teams: office hooks and Teams workflows get an Adaptive Card, plus the plain fields', () => {
  assert.equal(targetFor('https://contoso.webhook.office.com/webhookb2/abc'), 'teams')
  assert.equal(targetFor('https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x'), 'teams')
  assert.equal(targetFor('https://default1.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual'), 'teams')
  assert.equal(targetFor('https://example.logic.azure.com/other'), 'json')
  const t = bodyFor('teams', r) as Record<string, any>
  assert.equal(t.type, 'message')
  const card = t.attachments[0].content
  assert.equal(t.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive')
  assert.equal(card.type, 'AdaptiveCard')
  assert.deepEqual(card.body[1].facts[1], { title: 'Symptoms', value: 'Cough, Fever' })
  assert.equal(t.fields['Full name'], 'Robin', 'plain fields ride along for Power Automate')
})

test('WEBHOOK_FORMAT overrides the guess', () => {
  assert.equal(targetFor('https://prod-1.westus.logic.azure.com/workflows/x', 'json'), 'json')
  assert.equal(targetFor('https://example.com/hook', 'teams'), 'teams')
  assert.equal(targetFor('https://hooks.slack.com/services/x', 'nonsense'), 'slack')
})

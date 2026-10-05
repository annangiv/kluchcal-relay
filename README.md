# Oraplot relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/annangiv/oraplot-relay)

Run your booking integrations in **your own Cloudflare account**. Oraplot sends encrypted booking details; your relay opens them and sends them to your tools. Oraplot never receives your private key, decrypted client details, or webhook destination.

## Connect in three steps

1. Click **Deploy to Cloudflare**, sign in, and set `WEBHOOK_URL` to your Zapier, Make, n8n, Slack, Discord, Google Chat, Teams, or custom webhook. Deploy.
2. Copy the Worker's address, such as `https://oraplot-relay.you.workers.dev`.
3. In Oraplot, open the calendar, unlock your vault, expand **Your relay & integrations**, paste the address, and click **Connect**.

No keys to copy. The relay generates its own X25519 key pair and keeps its private key in a Durable Object in your account. Your browser seals the calendar key to the relay's public key.

If Cloudflare shows **No URLs enabled**, enable `workers.dev` under the Worker's **Settings → Domains & Routes**.

For a self-hosted Oraplot, set `ORAPLOT_ORIGIN` to your app's public HTTPS origin before connecting. The default is `https://oraplot.com`; the relay can only verify deliveries once that origin serves Oraplot. Running this repository does not deploy the scheduling app.

## What it does

- Accepts signed booking events: created, confirmed, rescheduled, cancelled, completed, no-show, and deleted.
- Verifies an Ed25519 signature and a five-minute timestamp window before opening ciphertext.
- Stores encrypted events for durable retries. It forwards readable data only to your configured destination.
- Keeps one current version per booking. Replayed or older versions cannot replace newer jobs.
- Schedules one **reminder event 24 hours before** an active appointment when that time is still in the future. Rescheduling replaces the pending reminder; cancellation, completion, and deletion remove it.
- Returns only acceptance/status information to Oraplot. A `202` means durably accepted; webhook delivery happens asynchronously.

Your destination receives a reminder event; configure that tool to send your client an email or SMS. The relay does not include a built-in email or SMS provider, calendar account connection, or payment processor.

Generic webhooks receive JSON like:

```json
{
  "source": "oraplot",
  "event": "rescheduled",
  "event_id": "booking-id:2:rescheduled",
  "booking": {
    "id": "booking-id",
    "version": 2,
    "starts_at": "2026-10-06T15:00:00Z",
    "ends_at": "2026-10-06T15:30:00Z",
    "status": "confirmed"
  },
  "form": { "id": "calendar-id", "title": "Your calendar" },
  "fields": {
    "client name": "Ada",
    "client email": "ada@example.com",
    "service name": "Consultation"
  }
}
```

Map fields in your automation tool. Use `booking.id` to update or delete the same external record. Use `event_id` or the `Idempotency-Key` header to deduplicate deliveries: retries are at least once, and a destination might process a request before its reply is lost. Delete events contain only the source, event, event ID, and booking ID/version.

Chat destinations receive their native message format. Set `WEBHOOK_FORMAT` to `json`, `slack`, `discord`, `google_chat`, or `teams` to override automatic detection. File keys must never be forwarded to chat/webhook destinations; file references are reduced to filenames by the formatter. Download encrypted attachments through Oraplot's unlocked dashboard.

## Settings

| Setting | Purpose |
| --- | --- |
| `WEBHOOK_URL` | Required secret: your destination |
| `ORAPLOT_ORIGIN` | App to trust; default `https://oraplot.com` |
| `ORAPLOT_PUBLIC_KEY` | Optional pinned delivery signing key |
| `WEBHOOK_FORMAT` | Optional destination format override |
| `WEBHOOK_SERVICE` | Optional service binding to a Worker in the same account |

Command line setup:

```sh
npm ci
npx wrangler deploy
npx wrangler secret put WEBHOOK_URL
```

## Privacy and access

The relay is an authorized decryption endpoint in your Cloudflare account. Cloudflare and your destination are part of your chosen trust boundary. Anything forwarded to a destination can be read by that destination. Removing it from Oraplot stops delivery and marks the calendar for key rotation; an authorized admin must unlock and rotate before new bookings are accepted. Remove the Worker from Cloudflare to delete its local records too.

Successful deletion removes stored ciphertext for that booking and keeps a small booking ID/version tombstone to reject delayed events. Downstream deletion depends on what your destination supports. Ciphertext retry jobs and signing metadata are not a guarantee of anonymity: the scheduling app still knows reservation times, duration, calendar, and status.

Observability is off by default. The Worker does not log answers or keys. Browser/relay crypto compatibility uses libsodium and the Noble primitives, adapted from KluchForms. This code has automated tests; it is not represented as independently security audited.

## Development

Node 22 or newer:

```sh
npm ci
npm test
npm run typecheck
npm run build:check
npm run test:lifecycle
```

The lifecycle test runs locally with Miniflare, generates disposable test keys, and uses a mock destination. It checks signed delivery, retries, replay protection, cancellation, reminder replacement, and deletion without a Cloudflare account or production credentials.

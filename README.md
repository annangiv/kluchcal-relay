# Oraplot relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/annangiv/oraplot-relay)

Run your booking integrations in **your own Cloudflare account**. Oraplot sends encrypted booking details; your relay opens them and sends them to your tools. Oraplot never receives your private key, decrypted client details, or webhook destination.

## Connect in three steps

1. Click **Deploy to Cloudflare**, sign in, and set `WEBHOOK_URL` to your Zapier, Make, n8n, Slack, Discord, Google Chat, Teams, or custom webhook. Set a random `RELAY_PAIRING_TOKEN` secret of at least 32 characters. Deploy.
2. Copy the Worker's address, such as `https://oraplot-relay.you.workers.dev`.
3. In Oraplot, open the calendar, unlock your vault, expand **Your relay & integrations**, paste the address and your owner pairing code, and click **Connect**.

The pairing code authorizes connection to your Worker and is not saved by Oraplot. The relay generates its own X25519 key pair and keeps its private key in a Durable Object in your account. Your browser seals the calendar key to the relay's public key.

If Cloudflare shows **No URLs enabled**, enable `workers.dev` under the Worker's **Settings → Domains & Routes**.

For a self-hosted Oraplot, set `ORAPLOT_ORIGIN` to your app's public HTTPS origin before connecting. The default is `https://oraplot.com`; the relay can only verify deliveries once that origin serves Oraplot. Running this repository does not deploy the scheduling app.

## What it does

- Accepts signed booking events: created, confirmed, rescheduled, cancelled, completed, no-show, and deleted.
- Requires an owner-authenticated, immutable integration/calendar/workspace binding, plus an Ed25519 signature and a five-minute timestamp window before opening ciphertext. A public encryption key alone never authorizes delivery.
- Stores encrypted events durably. It forwards readable data only to your configured destination. Ambiguous downstream delivery stops for owner review by default.
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

Map fields in your automation tool. Use `booking.id` to update or delete the same external record. Use the stable `Idempotency-Key` header (`integration:booking:version:event`) to deduplicate deliveries. A destination might process a request before its reply is lost. Automatic retries are enabled only when you explicitly set `WEBHOOK_IDEMPOTENT=1` and your receiver enforces that key. Standard chat webhooks generally do not enforce it. Delete events contain only the source, event, event ID, and booking ID/version.

Chat destinations receive their native message format. Set `WEBHOOK_FORMAT` to `json`, `slack`, `discord`, `google_chat`, or `teams` to override automatic detection. File keys must never be forwarded to chat/webhook destinations; file references are reduced to filenames by the formatter. Download encrypted attachments through Oraplot's unlocked dashboard.

## Settings

| Setting | Purpose |
| --- | --- |
| `WEBHOOK_URL` | Required secret: your destination |
| `RELAY_PAIRING_TOKEN` | Required random owner secret, at least 32 characters |
| `WEBHOOK_IDEMPOTENT` | Set to `1` only when the destination enforces the stable idempotency key |
| `ORAPLOT_ORIGIN` | App to trust; default `https://oraplot.com` |
| `ORAPLOT_PUBLIC_KEY` | Optional pinned delivery signing key |
| `WEBHOOK_FORMAT` | Optional destination format override |
| `WEBHOOK_SERVICE` | Optional service binding to a Worker in the same account |

Command line setup:

```sh
npm ci
npx wrangler deploy
npx wrangler secret put WEBHOOK_URL
npx wrangler secret put RELAY_PAIRING_TOKEN
```

## Privacy and access

The relay is an authorized decryption endpoint in your Cloudflare account. Cloudflare and your destination are part of your chosen trust boundary. Anything forwarded to a destination can be read by that destination. Disconnecting in Oraplot removes local grants and queued deliveries immediately, queues a durable signed remote revocation, and marks the calendar for key rotation. An offline relay may retain historical bookings and reminders until it receives that revocation or its 90-day binding expires; an authorized admin must unlock and rotate before new bookings are accepted. Remove the Worker from Cloudflare to delete its local records too.

Pairings expire after 90 days and cannot be overwritten, even after expiry or revocation. Disconnect, rotate the calendar key, and reconnect with the owner code to renew. On upgrade, old connections fail closed; update both the relay and app, then disconnect and reconnect.

For a blocked ambiguous delivery, first inspect the receiver to decide whether repeating it is safe. Only then POST JSON `{ "integration_id": "...", "form_id": "...", "workspace_id": "...", "booking_id": "..." }` to `/retry` with `Authorization: Bearer <RELAY_PAIRING_TOKEN>`. This is an explicit owner retry and can duplicate an already-processed event. Never put the code in a URL or logs. Revocation and expiry cannot be bypassed by retry.

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

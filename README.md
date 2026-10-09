# KluchCal relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/annangiv/kluchcal-relay)

Run your booking integrations in **your own Cloudflare account**. KluchCal sends encrypted booking details; your relay opens them and sends them to your tools. KluchCal never receives your private key, decrypted client details, or webhook destination.

## Connect in three steps

1. Click **Deploy to Cloudflare**, sign in, and set `WEBHOOK_URL` to your Zapier, Make, n8n, Slack, Discord, Google Chat, Teams, or custom webhook. Set a random `RELAY_PAIRING_TOKEN` secret of at least 32 characters. Deploy.
2. Copy the Worker's address, such as `https://oraplot-relay.you.workers.dev` (the Worker keeps its original name; see **Upgrading an existing relay**).
3. In KluchCal, open the calendar, unlock your vault, expand **Your relay & integrations**, paste the address and your owner pairing code, and click **Connect**.

The pairing code authorizes connection to your Worker and is not saved by KluchCal. The relay generates its own X25519 key pair and keeps its private key in a Durable Object in your account. Your browser seals the calendar key to the relay's public key.

If Cloudflare shows **No URLs enabled**, enable `workers.dev` under the Worker's **Settings → Domains & Routes**.

For a self-hosted KluchCal, set `KLUCHCAL_ORIGIN` to your app's public HTTPS origin before connecting. The default is `https://kluchcal.com`; the relay can only verify deliveries once that origin serves KluchCal. Running this repository does not deploy the scheduling app.

## What it does

- Accepts signed booking events: created, confirmed, rescheduled, cancelled, completed, no-show, and deleted.
- Requires an owner-authenticated, immutable integration/calendar/workspace binding, plus an Ed25519 signature and a five-minute timestamp window before opening ciphertext. A public encryption key alone never authorizes delivery.
- Stores encrypted events durably. It forwards readable data only to your configured destination. A definite rejection (any HTTP error status including 408/429/5xx, or a connection/DNS/TLS failure before sending) is retried with backoff: 10 attempts over about 17 hours, honouring `Retry-After`. Only an ambiguous send (timed out or dropped after the request went out) stops for owner review by default. Reminders keep working after a retried failure.
- Keeps one current version per booking. Replayed or older versions cannot replace newer jobs.
- Schedules one **reminder event 24 hours before** an active appointment when that time is still in the future. Rescheduling replaces the pending reminder; cancellation, completion, and deletion remove it.
- Returns only acceptance/status information to KluchCal. A `202` means durably accepted; webhook delivery happens asynchronously.

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

Map fields in your automation tool. Use `booking.id` to update or delete the same external record. Use the stable `Idempotency-Key` header (`integration:booking:version:event`) to deduplicate deliveries. A destination might process a request before its reply is lost. Ambiguous sends are retried automatically only when you explicitly set `WEBHOOK_IDEMPOTENT=1` and your receiver enforces that key; definite rejections are always retried, because the destination did not accept them. Standard chat webhooks generally do not enforce it. Delete events contain only the source, event, event ID, and booking ID/version.

Chat destinations receive their native message format. Set `WEBHOOK_FORMAT` to `json`, `slack`, `discord`, `google_chat`, or `teams` to override automatic detection. File keys must never be forwarded to chat/webhook destinations; file references are reduced to filenames by the formatter. Download encrypted attachments through KluchCal's unlocked dashboard.

## Settings

| Setting | Purpose |
| --- | --- |
| `WEBHOOK_URL` | Required secret: your destination |
| `RELAY_PAIRING_TOKEN` | Required random owner secret, at least 32 characters |
| `WEBHOOK_IDEMPOTENT` | Set to `1` only when the destination enforces the stable idempotency key; ambiguous sends are then retried too |
| `KLUCHCAL_ORIGIN` | App to trust; default `https://kluchcal.com` |
| `KLUCHCAL_PUBLIC_KEY` | Optional pinned delivery signing key |
| `ORAPLOT_ORIGIN`, `ORAPLOT_PUBLIC_KEY` | Legacy aliases; the corresponding nonempty `KLUCHCAL_*` setting takes precedence |
| `WEBHOOK_FORMAT` | Optional destination format override |
| `WEBHOOK_SERVICE` | Optional service binding to a Worker in the same account |

Command line setup:

```sh
npm ci
npx wrangler deploy
npx wrangler secret put WEBHOOK_URL
npx wrangler secret put RELAY_PAIRING_TOKEN
```

## Upgrading an existing relay

KluchCal is the new product name. Existing deployments keep their private key and pairings only when you update the **same Worker and Durable Object namespace**, so `wrangler.jsonc` keeps the original Worker name `oraplot-relay`. If your Worker has another name, deploy with `npx wrangler deploy --name <existing-worker-name>`. Do not delete or recreate its `KEYS` binding, `RelayKeys` class, or `v1` migration. To move to a new Worker name, deploy it as a second Worker, connect it in KluchCal as a new relay, then disconnect and delete the old one.

Deploying replaces the Worker's variables with those in `wrangler.jsonc`. Until the app is served at `https://kluchcal.com`, set `KLUCHCAL_ORIGIN` in `wrangler.jsonc` (or with `--var`) to the origin that serves it today, for example `https://oraplot.com`, or deliveries fail signature verification.

Old `ORAPLOT_ORIGIN` and `ORAPLOT_PUBLIC_KEY` settings still work when the corresponding new setting is absent or empty. When moving an existing custom origin into the new configuration, set `KLUCHCAL_ORIGIN` explicitly so the new default does not override it. Health and owner-key responses now identify the service as `kluchcal-relay`; upgrade the app to recognize that name before updating a connected relay.

The wire protocol intentionally retains `source: "oraplot"`, the encryption context `oraplot:response:v1:<calendar-id>:<key-version>`, storage keys, and idempotency keys. Changing those would break stored ciphertext, pairings, or existing automation filters. Signed requests accept both complete `x-kluchcal-timestamp` / `x-kluchcal-signature` and legacy `x-oraplot-timestamp` / `x-oraplot-signature` pairs. If any new header is present, the complete new pair is required. Signing-key discovery tries `/.well-known/kluchcal-delivery-key` on the configured origin and falls back to `/.well-known/oraplot-delivery-key` only when the new path returns 404 or 410.

## Privacy and access

The relay is an authorized decryption endpoint in your Cloudflare account. Cloudflare and your destination are part of your chosen trust boundary. Anything forwarded to a destination can be read by that destination. Disconnecting in KluchCal removes local grants and queued deliveries immediately, queues a durable signed remote revocation, and marks the calendar for key rotation. An offline relay may retain historical bookings and reminders until it receives that revocation or its 90-day binding expires; an authorized admin must unlock and rotate before new bookings are accepted. Remove the Worker from Cloudflare to delete its local records too.

Pairings expire after 90 days and cannot be overwritten, even after expiry or revocation. Disconnect, rotate the calendar key, and reconnect with the owner code to renew. On upgrade, old connections fail closed; update both the relay and app, then disconnect and reconnect.

Deliveries to an unpaired, expired or revoked binding are answered with `403` and `code: "binding_inactive"`; KluchCal then stops delivering to that connection and shows it as needing re-pairing.

An event that failed all 10 attempts, or an ambiguous delivery, is blocked. For a blocked delivery, first inspect the receiver to decide whether repeating it is safe. Only then POST JSON `{ "integration_id": "...", "form_id": "...", "workspace_id": "...", "booking_id": "..." }` to `/retry` with `Authorization: Bearer <RELAY_PAIRING_TOKEN>`. This is an explicit owner retry and can duplicate an already-processed event. Never put the code in a URL or logs. Revocation and expiry cannot be bypassed by retry.

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

The lifecycle test runs locally with Miniflare, generates disposable test keys, and uses a mock destination. It checks signed delivery, retries, replay protection, cancellation, reminder replacement, and deletion without a Cloudflare account or production credentials, both with `WEBHOOK_IDEMPOTENT=1` and in the default mode (503/429 retried, reminders continue after a failure, a timed-out send blocks until an owner retry).

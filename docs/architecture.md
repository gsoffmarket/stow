# Architecture

## Bird's-eye view

A coordinator posts an order in a Telegram work group. Stow turns it into one-item picking instructions on Even G2 glasses. The picker confirms what they physically put in the tote, and the group's status message for that order updates as they go.

The hard part is not the display but the order changing while someone is picking it. Stow keeps two numbers per line: `requested` (the coordinator's current target) and `picked` (net worker-confirmed units in the tote). It never clamps one to the other. When `picked` exceeds `requested`, the difference is a return the picker must do first. Every command carries the revision and version the client saw, so a tap on a stale screen is refused instead of applied to the new plan.

```
Telegram group ──updates──▶ inbox ──▶ createOrder ─┐
                                                   ▼
Glasses (Even Hub SDK) ──commands──▶ HTTP ──▶ fulfilment ──▶ order engine (pure)
        ▲                                          │
        └──────── snapshot (poll) ◀────────────────┤  one transaction:
                                                   │  state + event + command result + outbox row
Telegram group ◀── edit status message ◀── outbox ◀┘
```

## Codemap

| Path | What lives there |
|---|---|
| `packages/order-engine/src/engine.ts` | Pure domain core: `plan` derives the next task; `planBatch` chooses the next step across a picker's totes; `claim`, `confirm`, `complete` and the rest validate and apply commands. No I/O, no clock. |
| `packages/telegram/src/commands.ts` | Strict parsing of bot commands and the `/order` grammar. |
| `packages/telegram/src/status.ts` | Plain-text rendering of an order's status message. |
| `packages/telegram/src/botapi.ts` | Bot API client that classifies every outcome as ok, retry, rejected or unknown. |
| `apps/api/src/fulfilment.ts` | Imperative shell around the engine: transactions, locking, idempotency, events, outbox. |
| `apps/api/src/http.ts` | Fastify routes for the glasses: worker snapshot and commands. Device auth and task tokens. |
| `apps/api/src/telegram.ts` | Inbox intake, onboarding (`/setup`, `/stow_connect`, invites), `/order`, previews with buttons, shortage decisions, outbox delivery, polling loops. |
| `apps/api/src/messages.ts` | Coordinator notes to the glasses and picker quick replies to the group. Never change the order. |
| `apps/api/src/identity.ts` | Mini App sign-in: verifies Telegram's signed launch data, issues sessions, lists memberships. |
| `apps/api/src/devices.ts` | Glasses pairing: code, approval from the Mini App, one-time token exchange. |
| `apps/api/src/console.ts` | Read models for the coordinator console: the paged order list and its search, order detail, sessions and the onboarding checklist. |
| `apps/api/src/members.ts` | The team: roles, revoking glasses, removing a member, all owner-only under the workspace lock. |
| `apps/api/src/connections.ts` | Connected Telegram groups: list them and disconnect one. |
| `apps/api/src/reports.ts` | Counts over whole days in a time zone, from the event log, and the order history CSV. |
| `apps/api/src/settings.ts` | Time zone and retention, and the hourly purge of closed orders past retention. |
| `apps/api/src/local.ts` | Local-only setup, test order and bind-code commands. |
| `apps/glasses/src/screens.ts` | Pure choice of what the glasses show for a snapshot and link state. |
| `apps/glasses/src/main.ts` | Even Hub bridge glue: render, input, pairing, polling, command sending. |
| `apps/companion/src/` | Telegram Mini App: sign-in, pairing approval, coordinator console. Opened in a browser, the same build serves the landing page and the user guide at `/docs`. |
| `packages/ui-tokens/tokens.css` | Design tokens shared by the Mini App. |
| `deploy/` | Docker Compose, Caddy and the image build for one VPS. |
| `db/migrations/` | Forward-only SQL migrations. |

## Invariants

- The engine never imports I/O, a clock or randomness; the API and the glasses depend on it, never the reverse.
- `picked >= 0` on every line, enforced by the engine (assertion) and a CHECK constraint.
- A rejected command changes nothing. A repeated command ID returns its first result; the same ID with a different payload is refused.
- Every mutation writes state, its event, its command result and its outbox row in one transaction. No network call happens inside a transaction.
- Every child row references its parent through `(workspace_id, id)`, so a row can never point into another workspace.
- Writers lock the workspace row first, then the order, then its lines. That fixed order makes deadlocks impossible.
- Workspace event sequence numbers are allocated only for committed events, so there are no gaps from rejections.
- Telegram delivery never decides whether physical work was saved. A first send whose outcome is unknown is marked uncertain and never repeated automatically.
- Only explicit bot commands are read. Plain chat, bot messages, anonymous admins and forwards are never processed.

## Boundaries

- **Glasses ↔ API:** HTTPS JSON. The glasses hold an opaque device token (stored hashed) and send back the task token issued with each task.
- **Mini App ↔ API:** HTTPS JSON with a short-lived session obtained by exchanging Telegram's signed launch data.
- **API ↔ Telegram:** Bot API over HTTPS. Long polling locally; a webhook in hosted deployments (never both for one bot).
- **API ↔ Postgres:** the only durable state.

## Key decisions

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Deployable units | One API process (HTTP plus Telegram loops) and one static glasses app | A separate worker service: not needed at this scale; the outbox loop has leases so it can move out later. |
| Realtime | Snapshot polling every 1.5 s | WebSocket or SSE: not yet verified in the Even Hub WebView; polling is the PRD's fallback and is simple to reason about. |
| Telegram client | Small `fetch` client | grammY: the outbox needs explicit outcome classification and per-call deadlines more than a framework. |
| Server runtime | Node 24 running TypeScript directly (type stripping) | A build step or tsx: unnecessary with erasable-only syntax. |
| Glasses layout | Three text containers updated in place | Image rendering for larger type: image updates cost seconds over Bluetooth; text updates are instant and flicker-free. |
| Status message | One bot message per order, edited in place | A message per change: noisy for the group and harder to read. |
| Sign-in | Telegram identity everywhere: bot commands, Mini App launch data, pairing approved in the Mini App | Email via a hosted auth provider: an extra vendor and login for people who already live in Telegram. |
| Glasses secondary actions | A More screen drawn in text containers, opened by swipe | The SDK's native menu: in simulator 0.9.5 it opened empty and could not select items. |
| Batch picking | Each order keeps its own plan and tote; `planBatch` only orders their steps (acknowledgements, reviews, returns, then picks in walking order), and a batch is claimed all or none | A merged pick list across orders: one wrong count would be hard to attribute to an order, and a blocked order would stall the whole cart. |
| Hosting | One VPS: Postgres, API and Caddy in Docker Compose | Serverless or Supabase-only: the Telegram loops need a process that runs continuously. |
| Order list paging | Keyset cursor on (last activity, id), opaque to clients; only the first page is polled | Offset paging: an order that changes mid-scroll would repeat or vanish. |
| Glasses presence | `last_seen_at` stamped while authenticating a device, at most every 30 s; connected means seen within 90 s on the server clock | A heartbeat endpoint or a write per poll: one more request, or a write every 1.5 s per picker. |
| Onboarding progress | Derived from the data (catalogue, group, picker, glasses, completed order) | Stored progress flags: they drift when a step is done through the bot instead of the checklist. |
| Retention | Owner chooses 90 days, 1 year or keep; an hourly in-process purge in bounded batches | A separate job runner: one more moving part for one hourly query. |

## Defaults applied

- PostgreSQL 18, UUIDv7 IDs generated by the database (`uuidv7()`), used as primary keys. The PRD specifies UUID primary keys, so there is no separate internal identity column.
- `timestamptz` everywhere, UTC.
- Text limits as `text` with CHECK constraints.
- Bigint versions and sequences travel as decimal strings.
- Configuration from environment variables, validated once at startup.
- Structured JSON logs from Fastify with the authorization header redacted.
- API errors use the PRD's envelope (`{ error: { code, message, retryable }, meta }`) rather than RFC 9457, because the PRD specifies it.
- Idempotency through `commandId` on the command endpoint, stored durably with a request hash.

## Not planned

- Automatic stock or inventory updates; Stow records worker-confirmed actions only.
- Reading Telegram messages other than explicit bot commands.
- Background notifications on the glasses; the app works while it is open.
- Deleting a workspace from the app; whoever runs the server does that.
- Ending a picker's glasses session from Sessions; an owner revokes the glasses on the Team page.

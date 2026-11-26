# Stow

[![CI](https://github.com/gsoffmarket/stow/actions/workflows/ci.yml/badge.svg)](https://github.com/gsoffmarket/stow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Your work group's orders on your glasses, answered without touching your phone.**

Stow turns orders posted in a Telegram work group into one-item picking instructions on Even G2 smart glasses. The picker confirms what they actually put in the tote with a tap, and the order's status message in the group updates as they go.

## The problem

Small stockrooms and e-commerce teams often coordinate fulfilment in a Telegram group: orders, changes and questions all arrive there. The person picking has to stop, take out a phone, scroll the group and type back. When an order changes halfway through, what they read five minutes ago is already wrong.

Stow is for the picker with full hands and for the coordinator who wants to keep using Telegram instead of learning a warehouse system.

## How it works

1. A coordinator sends `/order` in a group bound to Stow, one `SKU x QTY` per line.
2. The API checks the SKUs against the catalogue and queues the order. The bot replies with a status message.
3. The glasses show one instruction at a time: bin, item, SKU and `PICK × N`. A tap confirms it.
4. Each confirmation is saved once, and the group's status message is edited to show progress.

The core is a pure order engine that keeps two numbers per line: what the coordinator currently wants (`requested`) and what the picker has confirmed (`picked`). It never clamps one to the other. If a target drops below what is already in the tote, the difference becomes a return the picker must do first. Every command carries the revision and version the screen showed, so a tap on an out-of-date screen is refused rather than applied to the new plan.

**Stack:** TypeScript throughout. Node 24 runs the API directly from TypeScript (Fastify, Zod, `pg`). PostgreSQL 18. The glasses app uses Vite and the official Even Hub SDK. Telegram goes through the Bot API.

**Design choices worth knowing:**
- State, event, idempotency record and Telegram outbox row are written in one transaction. Telegram is never on the critical path of saving physical work.
- Telegram delivery is honest about uncertainty. A first send with no answer is marked uncertain and never blindly repeated.
- Only explicit bot commands are read. Ordinary group chat is never processed.

See [docs/architecture.md](docs/architecture.md) for the codemap, invariants and decisions.

## What works today

- Order intake from Telegram (`/stow_bind`, `/order`) with strict validation and duplicate-delivery protection.
- Claim, pick, return and complete through the order engine, with stale-command rejection and idempotent retries.
- The glasses app on the official Even Hub SDK. One order was run end to end in **Even Hub simulator 0.9.5**: start, three picks, review and completion, with six events committed. Not yet tested on physical G2 hardware.
- The status message in the group is created and edited from a transactional outbox, with rate-limit handling and coalesced edits. Tested against a Bot API stand-in; a live Telegram run is pending a test bot.
- 99 automated tests, most of them integration tests against real Postgres.

## Run it locally

**Prerequisites:** Node 24, pnpm 9, Docker.

```bash
pnpm install --frozen-lockfile
docker compose up -d
pnpm setup:local
pnpm order:local
pnpm dev
```

`setup:local` creates `.env.local`, migrates, seeds a synthetic demo catalogue and writes a dev device token for the glasses. `order:local` queues a test order without Telegram. `pnpm dev` starts the API on port 8787 and the glasses app on port 5173.

Then, in another terminal, open the official simulator:

```bash
pnpm --filter @stow/glasses simulator
```

**With Telegram:**
1. Create a test bot with [@BotFather](https://t.me/BotFather) and add it to a private test group.
2. Put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` in `.env.local` and restart `pnpm dev`.
3. Run `pnpm bind:local` and send the printed `/stow_bind` line in the group.
4. Send an order:

```
/order
TS-BLK-M x 3
CP-WHT x 2
```

**Tests:** `pnpm typecheck && pnpm test` (needs the compose Postgres running).

## Project structure

```
apps/api        HTTP API, fulfilment transactions, Telegram intake and outbox
apps/glasses    Even G2 app (Even Hub SDK)
packages/order-engine   pure order engine
packages/telegram       command parser, status renderer, Bot API client
db/migrations   SQL migrations
docs            architecture
```

- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

Built for the Heads Up hackathon (Even Realities × TVM Ventures × Daos Hub), Messaging & News track. All code was written during the hackathon, starting 26 November 2026. It uses open-source libraries, the Even Hub SDK, CLI and simulator, and the Telegram Bot API.

**Scope:** Stow records what the picker confirms; it does not verify goods physically. It works while the app is open on the glasses.

## Licence

[MIT](LICENSE)

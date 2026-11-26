# Deploying Stow

Stow runs on one small Linux server: Postgres, the API (which also runs the Telegram loops) and Caddy for HTTPS, from `deploy/compose.yaml`. Caddy serves the Telegram Mini App at `/` and the glasses app at `/glasses/`.

## What you need

- A server with Docker and the Compose plugin, ports 80 and 443 open. Ubuntu 24.04 with 2 GB of RAM is plenty.
- A hostname pointing at the server's IP: your own subdomain, or `<ip-with-dashes>.sslip.io` if you have no domain.
- A Telegram bot from [@BotFather](https://t.me/BotFather).

## First deploy

```bash
git clone https://github.com/gsoffmarket/stow.git
cd stow
cp deploy/.env.example deploy/.env
```

Fill in `deploy/.env`: the hostname, a database password, a task-token secret and the bot's token and username. Then:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

The API applies migrations on start. Check it is up:

```bash
curl https://YOUR_HOST/health/ready
```

## Connect Telegram

1. In @BotFather, use `/newapp` (or Bot Settings → Configure Mini App) and set the Mini App URL to `https://YOUR_HOST/`.
2. Open a private chat with your bot and send `/setup Your stockroom name`.
3. Add the bot to your work group and send `/stow_connect` there.
4. Send `/invite picker` to the bot and forward the link to each picker.

The API polls Telegram for updates, so run only one deployment per bot.

## Glasses

Point the Even Hub simulator, or the Even Realities app's developer mode, at `https://YOUR_HOST/glasses/`.

To build the installable package for your server:

```bash
STOW_API_URL=https://YOUR_HOST pnpm --filter @stow/glasses package
```

This writes `apps/glasses/stow.ehpk`. The server's origin is compiled into the app and put on the package's network whitelist, so build one package per server. Upload it with `pnpm --filter @stow/glasses exec evenhub upload stow.ehpk` after `evenhub login`.

## Updating

```bash
git pull
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

Migrations only move forward and run on start.

## Public site on Vercel (optional)

The landing page and the guide at `/docs` can also be served from Vercel, which rebuilds them on every merge to `main`. Telegram keeps opening the Mini App on your server; the Vercel copy only talks to that server's API.

1. Create a Vercel project, connect it to the repository, and set its root directory to `apps/companion`. `apps/companion/vercel.json` sets the build and sends every path to the app, so `/docs` works.
2. Add two environment variables for Production and Preview: `VITE_STOW_API_URL` (your server's `https://` address) and `VITE_STOW_BOT_USERNAME` (the bot's username without `@`).

## Backups

The `backup` service writes a `pg_dump` every 24 hours to the `backups` volume and keeps a week. Those dumps live on the same server, so copy them somewhere else if the data matters. To restore into a fresh database:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T postgres pg_restore -U stow -d stow --clean < stow-YYYY-MM-DD.dump
```

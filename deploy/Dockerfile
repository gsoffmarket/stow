# One image for the API, plus the two static frontends Caddy serves next to
# it. The API runs TypeScript directly on Node 24 (type stripping), so there is
# no server build step; the frontends are built with Vite in their own stage.

FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/companion/package.json apps/companion/
COPY apps/glasses/package.json apps/glasses/
COPY packages/order-engine/package.json packages/order-engine/
COPY packages/telegram/package.json packages/telegram/
COPY packages/ui-tokens/package.json packages/ui-tokens/
RUN pnpm install --frozen-lockfile

FROM deps AS web
COPY . .
# The frontends are served from the same origin as the API, so they call
# relative /v1 URLs and need no API address baked in.
ENV VITE_STOW_API_URL=""
ARG STOW_BOT_USERNAME=""
ENV VITE_STOW_BOT_USERNAME=$STOW_BOT_USERNAME
RUN pnpm --filter @stow/companion build && pnpm --filter @stow/glasses build

FROM deps AS api
COPY apps/api apps/api
COPY packages packages
COPY db db
WORKDIR /app/apps/api
USER node
CMD ["sh", "-c", "node src/db/migrate.ts && node src/main.ts"]

FROM caddy:2-alpine AS edge
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/apps/companion/dist /srv/companion
COPY --from=web /app/apps/glasses/dist /srv/glasses

# Contributing

## Workflow

- Branch from `main`, open a pull request, and merge with a merge commit once CI is green. `main` requires the `check` job.
- Keep pull requests to one self-contained change. Refactors go separately from features and fixes.
- Commits use conventional prefixes (`feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `chore`), an imperative subject under 72 characters, and a body that says why.
- Every commit builds and passes tests.

## Before you push

```bash
docker compose up -d
pnpm typecheck
pnpm test
```

Integration tests create and drop their own databases on the compose Postgres (`TEST_DATABASE_URL` overrides the default).

## Code

- Business rules live in `packages/order-engine` as pure functions. I/O stays in `apps/api`.
- Tests go in the same change as the code they cover. Prefer integration tests against real Postgres; use stand-ins only at third-party boundaries such as the Telegram Bot API.
- Database changes are new forward-only files in `db/migrations`.
- Never commit secrets. `.env.local` is git-ignored, and a gitleaks hook is recommended.

See [docs/architecture.md](docs/architecture.md) for the invariants a change must keep.

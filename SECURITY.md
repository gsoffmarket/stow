# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's [private vulnerability reporting](https://github.com/gsoffmarket/stow/security/advisories/new), not in public issues. Include steps to reproduce and the impact you see.

## How Stow handles data

- **Telegram:** only explicit commands to the bot in a bound group are processed. Command payloads are cleared from the inbox once handled; other updates are kept only as a dedupe key.
- **Devices and bind codes:** tokens and codes are stored as SHA-256 hashes only.
- **Tasks:** each task shown on the glasses carries an HMAC task token, so a client cannot confirm a task the server did not issue.
- **Tenancy:** every row is tied to its workspace by composite foreign keys, and IDs from other workspaces return the same 404 as missing ones.
- **Secrets:** read from the environment, validated at startup, and never logged. The bot token never appears in error messages.

## Supported versions

Only the latest `main` is maintained.

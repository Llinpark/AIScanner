# Kaching AI — isolated staging setup

This is the operator runbook for **kaching-api-staging**.

Production remains **kaching-api** (`fly.toml`). Do not modify it. Do not run `fly deploy` (that uses production `fly.toml`).

This document does **not** claim that generated Pine 1.6.0 equals a live TradingView test.

---

## What you are provisioning

```
kaching-api-staging
        |
        ├── MongoDB database: kaching_staging   (name must be exact)
        ├── dedicated Redis
        ├── staging-only webhook secrets
        ├── Telegram TEST bot + TEST chat
        ├── Email TEST mailbox
        └── later: controlled TradingView canary (optional)
```

Never reuse production Mongo, Redis, Telegram bot/chats, subscriber email, webhook secrets, `api.kachingscanner.com`, or `kaching-api.fly.dev`.

---

## 0. Copy the env contract

```bash
cp .env.staging.example .env.staging
node scripts/generate-staging-secrets.js
```

Paste the printed secrets into `.env.staging`. Do not copy secrets from `kaching-api`.

Leave confirmation flags `false` until every resource below exists and is isolated.

---

## 1. Staging MongoDB

Create a **separate** cluster or database (Atlas or equivalent). Production Kaching databases must not be used.

Connection string requirements:

- Database name in the URI path must be exactly `kaching_staging`
- Host must not be `*.kachingscanner.com` or `kaching-api.fly.dev`

Example shape (replace USER, PASS, HOST yourself):

```text
MONGODB_URI=mongodb+srv://USER:PASS@HOST/kaching_staging
```

If the URI omits the database name, or uses `kachingscanner` / `kaching` / `prod`, staging scripts exit **2** and refuse to write.

---

## 2. Staging Redis

Create a **separate** Redis instance (Upstash or equivalent). Do not reuse production Redis/Upstash credentials.

```text
REDIS_URL=rediss://default:TOKEN@HOST:6379
REDIS_ENABLED=true
```

Staging health checks SET NX, GET, HASH, and TTL on keys prefixed `kaching:staging:health:*` only. Do not FLUSHALL / FLUSHDB.

Optional local data plane (not real Fly staging): `docker compose -f docker-compose.staging.yml up -d` exposes Redis **6380** and Mongo **27018**. Health/canary **reject loopback** as proof of `kaching-api-staging`.

---

## 3. Staging Fly application

Create a **new** app. Never retarget `kaching-api`.

```bash
fly apps create kaching-api-staging
```

Default hostname (operator-provided; confirm in `fly apps list`):

```text
https://kaching-api-staging.fly.dev
```

Set in `.env.staging`:

```text
FLY_APP=kaching-api-staging
PUBLIC_BACKEND_URL=https://kaching-api-staging.fly.dev
```

A custom domain is optional. If you attach one, it must not be `api.kachingscanner.com`. Put that hostname in `PUBLIC_BACKEND_URL`.

Set Fly secrets from the filled `.env.staging` (names only — values never go in git):

```bash
fly secrets set -a kaching-api-staging -c fly.staging.toml \
  NODE_ENV=staging \
  MONGODB_URI="..." \
  REDIS_URL="..." \
  REDIS_ENABLED=true \
  JWT_SECRET="..." \
  WEBHOOK_SIGNING_SECRET="..." \
  TRADINGVIEW_WEBHOOK_SECRET="..." \
  TELEGRAM_WEBHOOK_SECRET="..." \
  TELEGRAM_BOT_TOKEN="..." \
  PUBLIC_BACKEND_URL="https://kaching-api-staging.fly.dev" \
  FRONTEND_URL="..." \
  EMAIL_FROM="..." \
  SMTP2GO_API_KEY="..."
```

Deploy **only** after reviewing `fly.staging.toml` and isolated secrets:

```bash
fly deploy -a kaching-api-staging -c fly.staging.toml
```

**Never:** `fly deploy`  
**Never:** `fly deploy -a kaching-api`  
**Never:** `fly secrets set -a kaching-api ...`

Health check path: `GET /api/health` (already in `fly.staging.toml`).

---

## 4. Telegram test environment

1. Create a dedicated test bot with [@BotFather](https://t.me/BotFather) (not the production subscriber bot).
2. Create a dedicated test chat (private chat or a private test group). Add the bot.
3. Get the chat id (e.g. message the bot, then `getUpdates`).
4. Put token and chat id in `.env.staging`.
5. Put **known subscriber chat ids** in `STAGING_TELEGRAM_DENY_CHAT_IDS` (comma-separated).

The test chat must not belong to a subscriber. Staging scripts refuse denylisted chats. Health check calls `getMe` + `getChat` only — no `sendMessage`.

---

## 5. Email test environment

1. Use a dedicated test mailbox you control (`STAGING_EMAIL_TO`).
2. Prefer **SMTP2GO** (`SMTP2GO_API_KEY`) with a verified `EMAIL_FROM` on `kachingscanner.com`.
3. Put **known subscriber addresses** in `STAGING_EMAIL_DENY_RECIPIENTS`.
4. Addresses `@kachingscanner.com` whose local-part is not `staging|canary|soak|test` are refused.

Health check validates email provider configuration without sending a trade alert.

---

## 6. Enable isolation flags

Only after steps 1–5:

```text
STAGING_CONFIRM_ISOLATED=true
STAGING_MONGO_SOAK=true
STAGING_TELEGRAM_ENABLED=true
STAGING_EMAIL_ENABLED=true
```

---

## 7. Run the staging scripts (in this order)

```bash
node scripts/preflight-staging.js
node scripts/staging-health-check.js
node scripts/staging-canary.js
```

| Script | Exit 0 | Exit 2 |
|---|---|---|
| preflight | Isolated **configuration** present (no production-like targets). Does not connect, send, or write. | Missing/unsafe config |
| health | Real staging API + Mongo `kaching_staging` + Redis + Telegram getMe/getChat + email provider. Verdict `PASS`. | `BLOCKED` (isolation) or `FAIL` (probe) |
| canary | Isolation + health PASS, then real matrix against staging. | Isolation/health failed, or required matrix rows failed |

Do not treat localhost, an example file, or unit tests as a real canary.

---

## 8. TradingView canary (later, optional)

Generated Pine **1.6.0** is not a live chart test. After the API canary is green, use a **dedicated test chart** and the **staging** webhook URL only:

```text
${PUBLIC_BACKEND_URL}/api/webhook/tradingview
```

Create **one** alert: Any `alert()` function call, Message exactly `{{alert_message}}`. Do not point production alerts at staging. Do not point staging alerts at production.

### Scalping

| Chart | Role |
|---|---|
| 1m | Visualization only — must **not** send the authoritative webhook |
| 3m | Engine + authoritative webhook |
| 5m | Visualization only — must **not** send the authoritative webhook |

### Day trading

| Chart | Role |
|---|---|
| 5m | Engine + authoritative webhook |
| 15m | Visualization only |

Pine 1.6.0 does **not** auto-migrate old 1.3.0 alerts. Regenerate, remove the old indicator, delete old alerts, then create one new canonical alert.

---

## Canary matrix (executed only after health PASS)

The canary seeds **one** tagged staging user (test email + test Telegram chat) in `kaching_staging`. It refuses to run if other users already exist unless `STAGING_ALLOW_EXISTING_USERS=true`.

| Id | What it checks |
|---|---|
| A | ENTRY: one Signal, one Email, one Telegram, no duplicates |
| B | ENTRY → TP1: same `canonicalTradeId`, distinct `eventId` |
| C | ENTRY → TP1 → TP2 → TP3 |
| D | ENTRY → SL (no TP after SL in that trade) |
| E | Duplicate ENTRY webhook: no second Signal / no second send |
| F | Channel independence (Email fail vs Telegram fail) — requires injection; otherwise reported `BLOCKED` |
| G | Real Redis SET NX / TTL / HASH |
| H | Mongo Signal + DeliveryJob identity; overlay: Signal stays ENTRY while TP1 jobs are TP1 |
| I | Process recovery — operator may restart **only** `kaching-api-staging`; not auto-run against production |
| J | Admin observability — `fanout_complete` ≠ all channels delivered (code/docs; live Admin needs staging login) |

Cleanup deletes only records tagged with the canary `runId`.

---

## Safety recap

- Production app: `kaching-api` / `fly.toml` — do not deploy, do not set secrets.
- Staging app: `kaching-api-staging` / `fly.staging.toml` only.
- Mongo database name: `kaching_staging` only.
- No subscriber Telegram or email.
- No production webhook signing secret.

# Local real-integration canary (not cloud staging)

This is **LEVEL 2: LOCAL REAL-INTEGRATION**. It is not `kaching-api-staging`, not production, and not `api.kachingscanner.com`.

Cloud staging (`STAGING_SETUP.md`) remains unchanged. Do not run `fly deploy`.

## What you need

- Node.js 20+
- Local MongoDB on port **27017** with database **`kaching_local_canary`**
- Local Redis on port **6379**
- Optional: dedicated Telegram **test** bot + test chat
- Optional: dedicated test email via **SMTP2GO** (`SMTP2GO_API_KEY`)

Never use production Mongo, Redis, Telegram subscriber chats, subscriber email, or `api.kachingscanner.com`.

## Windows: MongoDB + Redis

### Option A — Docker (simplest)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. From the repo root:

```bash
docker compose -f docker-compose.local-canary.yml up -d
```

That maps Redis **6379** and Mongo **27017** with database `kaching_local_canary`.

If those ports are already taken, stop the existing local process or use it only with DB name `kaching_local_canary` (never `kachingscanner` / production names).

### Option B — Native Windows

MongoDB Community Server:

```powershell
winget install MongoDB.Server
```

Start the MongoDB Windows service, then:

```javascript
// mongosh
use kaching_local_canary
```

Redis: install [Memurai](https://www.memurai.com/) (Windows Redis-compatible) **or** run Redis in WSL:

```bash
sudo apt install redis-server
redis-server
```

Confirm:

```powershell
Test-NetConnection 127.0.0.1 -Port 27017
Test-NetConnection 127.0.0.1 -Port 6379
```

## Environment

```bash
cp .env.local-canary.example .env.local-canary
node scripts/generate-staging-secrets.js
```

Paste the printed secrets into `.env.local-canary`. Set:

```text
NODE_ENV=development
LOCAL_INTEGRATION_CANARY=true
LOCAL_INTEGRATION_CONFIRM_ISOLATED=true
MONGODB_URI=mongodb://127.0.0.1:27017/kaching_local_canary
REDIS_URL=redis://127.0.0.1:6379
PUBLIC_BACKEND_URL=http://127.0.0.1:4010
```

Telegram/email stay `false` until you have a dedicated test bot/mailbox. Then set the matching `LOCAL_INTEGRATION_*_ENABLED=true` flags and denylists.

`.env.local-canary` must not be committed.

## Start the local API

From the repo root, with `.env.local-canary` loaded into the process (or copied keys into a local `.env` that is **not** production):

```bash
# PowerShell example — load file then start
Get-Content .env.local-canary | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k,$v = $_.Split('=',2); Set-Item -Path "Env:$k" -Value $v
}
node server.js
```

Wait until `/api/health` responds on `http://127.0.0.1:4010/api/health`.

## Run validation

```bash
node scripts/preflight-local-canary.js
node scripts/health-local-canary.js
node scripts/canary-local-canary.js
```

Expected: all three exit **0** when Mongo, Redis, and the local API are up.

Results are **REAL LOCAL-INTEGRATION**, never **REAL STAGING**.

## Live TradingView (optional)

Use a dedicated test chart and a tunnel to localhost (ngrok, Cloudflare Tunnel). Never point the alert at `api.kachingscanner.com`. Generated Pine 1.6.0 is not a live chart test.

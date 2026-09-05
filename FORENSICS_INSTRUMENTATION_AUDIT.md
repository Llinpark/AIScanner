# KACHING V145 — FORENSICS-ONLY INSTRUMENTATION AUDIT

Tree: C:\TEMP\kaching-v145-webhook-ack-forensics
Baseline: C:\TEMP\kaching-v144-pipeline-repair (production v145 equivalent)
No Fly deploy. No machine restart. No Redis/Mongo changes.

## 1. Files changed

| File | Role |
|---|---|
| server.js | Probe + auth/accept hrtime + [PROCESS] boot line + process.report config |
| utils/tvAckLog.js | **new** compact [TV_ACK] logger (required so tests do not load server.js) |
| utils/__tests__/tvAckLog.test.js | **new** minimum tests |
| Dockerfile | node diagnostic CLI flags + /tmp report directory |
| package.json | `start` script matches Dockerfile flags |

Forbidden files not touched: TradingViewAlertService.js, TradeDeliveryService.js, durableDelivery.js, redisClient.js, deliverySequencer.js, DeliveryJob.js, deliveryIdempotency.js, Mt5PairingService.js, routes/mt5.js, Pine, frontend, payments.

## 2. Functions changed

- `attachTvAckProbe` (new) — prefix middleware; one log on `res.finish`
- `emitTvAck` / `formatTvAckLine` (new)
- `POST /api/webhook/tradingview` handler — records authMs/acceptMs/outcome only
- `server.on('listening')` — `[PROCESS]` identity line
- early `process.report` config after dotenv

## 3. SHA256

| File | Before (v145 baseline) | After |
|---|---|---|
| server.js | BE1580B6241AADD7EE1B9CEB705E95148207708730AA537BA662D167B48CD431 | C2F062EB6BABDFE4D83C7FACA359BC50AE9D5DB315E39AD1C700813B25650012 |
| Dockerfile | 810A8BCEA189926AAC996419CF672BA486E9402E2C4FC91FC6D302DF67A41CAC | 53A9263069DA3A35E16A17E9F855DDD5369C37047BF7FC62CB264E0BE682684D |
| package.json | 65D3BFC4B2B49BD87D4DFC1B07CC5CE3919D8E0C1FE8FB5E5DFB91430B54D12A | 94D5088516F55528090C0DE92F0D4505146D71CD2B805DFD22B1D4EE0A7D3EC4 |
| utils/tvAckLog.js | (new) | 35874E5D85CFD97D41B509D3F152B276E2A498CB801313AC7ECE3DFE58E0BF4E |
| utils/__tests__/tvAckLog.test.js | (new) | E641B327901A0EC36DB2C321432328E569DFCE5A0983C571D1C0B6217B402D0A |

## 4. Diff statistics (vs v145 baseline)

- server.js: 62 insertions, 4 deletions
- Dockerfile: 3 insertions, 1 deletion
- package.json: 1 insertion, 1 deletion
- utils/tvAckLog.js: new
- utils/__tests__/tvAckLog.test.js: new

## 5–8. Behavioral confirmation

Webhook acceptance, HTTP statuses, fan-out scheduling, Redis, Mongo, RC-E, RC-G: unchanged. Fan-out still `scheduleAcceptedTradingViewSignal` then `res.status(202)`.

## 9–12. Node diagnostics

Production image: `FROM node:20-alpine` (exact patch version is image-build-time; not hashed here).
Flags used (supported since Node 12, present on Node 20): `--report-on-fatalerror --report-uncaught-exception --report-directory=/tmp`
Report location: `/tmp` (Node default unique filename).
Survive Fly restart: **NO**.
Retrieve: `fly ssh console --machine <id> -C "ls /tmp"` only if the VM has not restarted; after exit 134 the files are gone. Fly logs may show Node's "Writing diagnostic report to:" line.

`--report-exclude-env` was **not** added to CMD (unknown whether Node 20 accepts it; a bad flag would prevent boot). JS sets `process.report.excludeEnv` only if the property exists. Node 20 likely still embeds env (secrets) in report JSON.

SIGABRT / exit 134 is **not** guaranteed to produce a report (native abort vs V8 fatal).

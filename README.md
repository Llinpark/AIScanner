# KachingScanner

A hybrid Forex AI scanner architecture combining Python and the MERN stack.

## Overview

- Python service: Core AI engine for signal generation, technical indicators, and ML modeling.
- Node.js + Express.js backend: API layer, MongoDB persistence, real-time event streaming.
- React frontend: Interactive dashboard for live signals and trading notifications.

## Architecture

1. `python-service`
   - **Market Data Service** (FastAPI): provider-agnostic interface with Twelve Data primary and EODHD automatic fallback.
   - Redis-backed caching (in-memory fallback when Redis is unavailable).
   - WebSocket relay for live Twelve Data price streaming.
   - Endpoints under `/market-data/*` plus `POST /signal` and `GET /health`.

2. `backend`
   - Receives signals from Python.
   - Persists them into MongoDB.
   - Broadcasts real-time updates to React clients via Socket.IO.
   - Supports subscriber authentication and subscription billing.

3. `frontend`
   - Sign up / sign in with email and password.
   - Subscribe via M-Pesa, PayPal, or mock payment.
   - Displays live signal feed for active subscribers.
   - TradingView setup guide for Entry, SL, TP1–TP3 alerts (no username linking).

## Setup 

### Python service

Set `TWELVE_DATA_API_KEY` and optional `EODHD_API_KEY` in `python-service/.env` (see `.env.example`).

FastAPI market data endpoints:
- `GET /market-data/status`
- `GET /market-data/providers`
- `GET /market-data/candles?symbol=EUR/USD&interval=1h&limit=100`
- `GET /market-data/symbols/{symbol}/candles`
- `WS /market-data/ws` — subscribe with `{"action":"subscribe","symbols":["EUR/USD"]}`

```powershell
cd python-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --reload --port 8001
```

### Backend

```powershell
cd backend
npm install
npm start
```

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

## Authentication

- `POST /api/auth/register` — `{ email, password, displayName?, phone? }`
- `POST /api/auth/login` — `{ email, password }`
- `GET /api/auth/me` — requires `Authorization: Bearer <token>`
- Set `JWT_SECRET` in `backend/.env`.

## Subscription Flow

1. Register or sign in.
2. Choose a plan on the Pricing page and complete payment.
3. Open **TradingView Setup** for the Pine Script and alert instructions.
4. Create TradingView alerts for Entry, Stop Loss, TP1, TP2, and TP3.

## Custom domain

Production URLs (override in `backend/.env` and `frontend/.env`):

| Service | URL |
|---------|-----|
| Website | https://kachingscanner.com |
| API / webhooks | https://api.kachingscanner.com |

- `APP_DOMAIN`, `FRONTEND_URL`, and `PUBLIC_BACKEND_URL` in `backend/.env`
- `VITE_APP_DOMAIN`, `VITE_SITE_URL`, and `VITE_BACKEND_URL` in `frontend/.env`
- TradingView webhooks: `https://api.kachingscanner.com/api/webhook/tradingview`
- Point DNS: `kachingscanner.com` → frontend host, `api.kachingscanner.com` → backend host

## TradingView Webhook

- Set `TRADINGVIEW_WEBHOOK_SECRET` in `backend/.env`.
- Configure TradingView alerts to POST to `https://api.kachingscanner.com/api/webhook/tradingview` (or your `PUBLIC_BACKEND_URL`).
- Expected payload fields include:
  - `symbol`, `direction`, `entry`, `stop_loss`, `take_profit_1`, `take_profit_2`, `take_profit_3`
  - `alertType` (`entry`, `stop_loss`, `take_profit_1`, `take_profit_2`, `take_profit_3`)
  - `broadcast: true` (all signals broadcast to active subscribers)
  - `secret` (must match `TRADINGVIEW_WEBHOOK_SECRET`)
- Incoming alerts are saved and delivered to all active subscribers via Socket.IO.
- Example payload: `backend/tradingview-alert-example.json`

## Notes

- Replace API keys in `backend/.env` and `python-service/.env` (Twelve Data + optional EODHD fallback).
- Market data uses **Twelve Data primary** with **EODHD automatic fallback** in both Node and Python services.

## Run All Services

Use the PowerShell helper to start all services in separate windows after installing Node.js and Python:

```powershell
cd c:\Users\Administrator\Desktop\KachingScanner
.\run-all.ps1
```

If runtime tools are not installed, install Node.js and Python first, then rerun the script.

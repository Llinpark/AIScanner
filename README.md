# KachingScanner

A hybrid Forex AI scanner architecture combining Python and the MERN stack.

## Overview

- Python service: Core AI engine for signal generation, technical indicators, and ML modeling.
- Node.js + Express.js backend: API layer, MongoDB persistence, real-time event streaming.
- React frontend: Interactive dashboard for live signals and trading notifications.

## Architecture

1. `python-service`
   - Fetches market data from external providers.
   - Computes indicators: RSI, MACD, Bollinger Bands.
   - Generates trade signals and risk points (entry, stop loss, TP levels).
   - Exposes a FastAPI REST interface for signal delivery.

2. `backend`
   - Receives signals from Python.
   - Persists them into MongoDB.
   - Broadcasts real-time updates to React clients via Socket.IO.
   - Supports TradingView username configuration.

3. `frontend`
   - Displays live signal feed.
   - Shows entry, stop loss, and take profit guidance.
   - Connects to backend via REST and WebSockets.

## Setup

### Python service

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

## TradingView Webhook

- Set `TRADINGVIEW_WEBHOOK_SECRET` in `backend/.env`.
- Configure TradingView alerts to POST to `http://<your-public-backend>/api/webhook/tradingview`.
- Expected TradingView payload fields include:
  - `symbol`
  - `direction`
  - `entry`
  - `stop_loss`
  - `take_profit_1`
  - `take_profit_2`
  - `take_profit_3`
  - `confidence`
  - `message`
  - `tradingviewUsername` (required for linked trader flows)
- Incoming alerts are saved to MongoDB and broadcast immediately to the React dashboard via Socket.IO.
- Example payload: `backend/tradingview-alert-example.json`

## Trader Linking

If a trader wants to use the app, they only need to provide their TradingView username.

Use the backend link endpoint to associate a trader account with a TradingView username:

- `POST http://<your-backend>/api/users/link`
- Body: `{ "username": "client_name", "tradingviewUsername": "tv_username" }`

Once linked, signals received with that `tradingviewUsername` can be associated with the trader and used as a guide.

## Notes

## Notes

- Replace API keys in backend `.env` and Python service env variables.
- Implement model training and production-grade signal filters before using live trading.
- This scaffold is designed for integration with data providers like Alpha Vantage, EODHD, or OANDA.

## Run All Services

Use the PowerShell helper to start all services in separate windows after installing Node.js and Python:

```powershell
cd c:\Users\Administrator\Desktop\KachingScanner
.\run-all.ps1
```

If runtime tools are not installed, install Node.js and Python first, then rerun the script.

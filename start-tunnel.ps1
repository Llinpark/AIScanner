# Exposes backend (port 4000) to the internet for TradingView webhooks.
# Keep this window open while TradingView alerts are active.

$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
$port = 4000

Write-Host "Starting tunnel to http://localhost:$port ..."
Write-Host "Webhook path: /api/webhook/tradingview"
Write-Host ""

# Prefer cloudflared (no browser warning). Fallback: localtunnel.
$cfPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (Test-Path $cfPath) {
  Write-Host "Using Cloudflare Tunnel (recommended for TradingView)."
  Write-Host "Copy the https://....trycloudflare.com URL into TradingView webhook + backend/.env PUBLIC_BACKEND_URL"
  & $cfPath tunnel --url "http://localhost:$port"
} else {
  Write-Host "Using localtunnel. Copy the https URL and set PUBLIC_BACKEND_URL in backend/.env"
  npx --yes localtunnel --port $port
}

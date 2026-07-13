# Interactive setup: MongoDB Atlas + TradingView webhook tunnel
# Run from project root: .\scripts\setup-atlas-and-webhooks.ps1

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot "backend\.env"
$cfPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

function Get-CloudflaredPath {
  if (Test-Path $cfPath) { return $cfPath }
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Set-EnvValue {
  param([string]$Path, [string]$Key, [string]$Value)
  $lines = Get-Content $Path
  $found = $false
  $updated = foreach ($line in $lines) {
    if ($line -match "^\s*$([regex]::Escape($Key))=") {
      $found = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $found) { $updated += "$Key=$Value" }
  Set-Content -Path $Path -Value $updated -Encoding UTF8
}

Write-Host ""
Write-Host "=== KachingScanner: Atlas + TradingView webhook setup ===" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: MongoDB Atlas ---
Write-Host "STEP 1 — MongoDB Atlas (free M0)" -ForegroundColor Yellow
Write-Host "  1. Sign up: https://cloud.mongodb.com"
Write-Host "  2. Create a FREE M0 cluster (AWS, region closest to you)"
Write-Host "  3. Database Access -> Add user (password auth, remember password)"
Write-Host "  4. Network Access -> Add IP -> Allow Access from Anywhere (0.0.0.0/0) for dev"
Write-Host "  5. Database -> Connect -> Drivers -> copy mongodb+srv://... URI"
Write-Host "  6. Replace <password> in the URI with your DB user password"
Write-Host ""

$openAtlas = Read-Host "Open MongoDB Atlas signup in browser now? (Y/n)"
if ($openAtlas -ne "n" -and $openAtlas -ne "N") {
  Start-Process "https://cloud.mongodb.com"
}

$atlasUri = Read-Host "Paste your MongoDB Atlas connection string (or press Enter to skip)"
if ($atlasUri -and $atlasUri.Trim()) {
  $atlasUri = $atlasUri.Trim().Trim('"')
  if ($atlasUri -notmatch "mongodb(\+srv)?://") {
    Write-Host "Invalid URI — must start with mongodb:// or mongodb+srv://" -ForegroundColor Red
    exit 1
  }
  if ($atlasUri -notmatch "/kachingscanner") {
    if ($atlasUri -match "\?") {
      $atlasUri = $atlasUri -replace "\?", "/kachingscanner?"
    } else {
      $atlasUri = "$atlasUri/kachingscanner"
    }
  }
  Set-EnvValue -Path $envFile -Key "MONGODB_URI" -Value $atlasUri
  Write-Host "Updated MONGODB_URI in backend/.env" -ForegroundColor Green
} else {
  Write-Host "Skipped Atlas URI — using existing MONGODB_URI in backend/.env" -ForegroundColor DarkYellow
}

# --- Step 2: Webhook secret ---
Write-Host ""
Write-Host "STEP 2 — TradingView webhook secret" -ForegroundColor Yellow
$webhookSecret = (Get-Content $envFile | Where-Object { $_ -match "^TRADINGVIEW_WEBHOOK_SECRET=" }) -replace "^TRADINGVIEW_WEBHOOK_SECRET=", ""
if ($webhookSecret -match "your_tradingview_webhook_secret") {
  $newSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  Set-EnvValue -Path $envFile -Key "TRADINGVIEW_WEBHOOK_SECRET" -Value $newSecret
  $webhookSecret = $newSecret
  Write-Host "Generated new TRADINGVIEW_WEBHOOK_SECRET" -ForegroundColor Green
}
Write-Host "  Webhook secret (use same value in Pine script WEBHOOK_SECRET): $webhookSecret"

# --- Step 3: TradingView plan note ---
Write-Host ""
Write-Host "STEP 3 — TradingView account" -ForegroundColor Yellow
Write-Host "  Native webhooks require Essential plan or higher (~`$12.95/mo)."
Write-Host "  Free Basic plan cannot send webhook alerts."
Write-Host "  Pricing: https://www.tradingview.com/pricing/"
Write-Host ""
Write-Host "  In TradingView alert message, use JSON with secret field, e.g.:"
Write-Host '  {"secret":"YOUR_SECRET","alertType":"entry","symbol":"EURUSD","direction":"buy",...}'
Write-Host ""

$openTv = Read-Host "Open TradingView pricing in browser? (Y/n)"
if ($openTv -ne "n" -and $openTv -ne "N") {
  Start-Process "https://www.tradingview.com/pricing/"
}

# --- Step 4: Tunnel ---
Write-Host ""
Write-Host "STEP 4 — Public HTTPS tunnel (for TradingView to reach your backend)" -ForegroundColor Yellow
Write-Host "  Start backend first: cd backend && npm run dev"
Write-Host ""

$startTunnel = Read-Host "Start Cloudflare tunnel now? (requires backend on port 4000) (y/N)"
if ($startTunnel -eq "y" -or $startTunnel -eq "Y") {
  $cf = Get-CloudflaredPath
  if (-not $cf) {
    Write-Host "cloudflared not found. Install: winget install Cloudflare.cloudflared" -ForegroundColor Red
    exit 1
  }
  Write-Host ""
  Write-Host "Copy the https://....trycloudflare.com URL below, then:" -ForegroundColor Cyan
  Write-Host "  - Set PUBLIC_BACKEND_URL in backend/.env to that URL (no trailing slash)"
  Write-Host "  - Set WEBHOOK_URL in Pine to: https://YOUR-TUNNEL.trycloudflare.com/api/webhook/tradingview"
  Write-Host "  - Restart backend after updating .env"
  Write-Host ""
  & $cf tunnel --url "http://localhost:4000"
} else {
  Write-Host ""
  Write-Host "Run later: .\start-tunnel.ps1" -ForegroundColor Cyan
  Write-Host "Then set PUBLIC_BACKEND_URL and restart backend."
}

Write-Host ""
Write-Host "Done. Test webhook locally:" -ForegroundColor Green
Write-Host "  curl -X POST http://localhost:4000/api/webhook/tradingview -H `"Content-Type: application/json`" -H `"x-tradingview-secret: $webhookSecret`" -d `"{\`"secret\`":\`"$webhookSecret\`",\`"alertType\`":\`"entry\`",\`"symbol\`":\`"EURUSD\`",\`"direction\`":\`"buy\`",\`"entry\`":1.085,\`"stopLoss\`":1.08,\`"takeProfit1\`":1.09,\`"takeProfit2\`":1.095,\`"takeProfit3\`":1.10}`""

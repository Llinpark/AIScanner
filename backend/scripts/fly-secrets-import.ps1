# Builds production Fly secrets from backend/.env (not committed).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$fly = Join-Path $env:USERPROFILE '.fly\bin\flyctl.exe'

if (-not (Test-Path $envFile)) {
  throw "Missing $envFile - run npm run generate-secrets first."
}

function Get-EnvValue($name) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$name=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^[^=]+=", '').Trim()
}

$keys = @(
  'MONGODB_URI', 'REDIS_URL', 'JWT_SECRET', 'WEBHOOK_SIGNING_SECRET',
  'PAYMENT_WEBHOOK_SECRET', 'TELEGRAM_WEBHOOK_SECRET', 'TRADINGVIEW_WEBHOOK_SECRET',
  'TWELVE_DATA_API_KEY', 'EODHD_API_KEY',
  'PAYSTACK_SECRET_KEY', 'PAYSTACK_PUBLIC_KEY'
)

$lines = New-Object System.Collections.Generic.List[string]
foreach ($key in $keys) {
  $value = Get-EnvValue $key
  if ($value) { [void]$lines.Add("$key=$value") }
}

# Production overrides
$overrides = @{
  APP_DOMAIN = 'kachingscanner.com'
  FRONTEND_URL = 'https://kachingscanner.com'
  PUBLIC_BACKEND_URL = 'https://api.kachingscanner.com'
  COOKIE_DOMAIN = '.kachingscanner.com'
  PAYMENTS_MODE = 'live'
  PAYSTACK_CALLBACK_URL = 'https://api.kachingscanner.com/api/payments/paystack/callback'
  PAYSTACK_WEBHOOK_URL = 'https://api.kachingscanner.com/api/webhook/paystack'
  PAYSTACK_SITE_CALLBACK_URL = 'https://kachingscanner.com'
  ADMIN_EMAILS = 'collinspark1985@gmail.com,barasajohn1985@gmail.com,lilianmonari15@gmail.com'
  REDIS_ENABLED = 'true'
  TELEGRAM_USE_POLLING = 'false'
  SCANNER_AUTO_ENABLED = 'true'
  BETA_MODE = 'true'
  BETA_TIER = 'premium'
  BETA_ACCESS_DAYS = '30'
}
foreach ($entry in $overrides.GetEnumerator()) {
  [void]$lines.Add("$($entry.Key)=$($entry.Value)")
}

$tempFile = Join-Path $env:TEMP "kaching-fly-secrets-$([guid]::NewGuid().ToString('n')).env"
try {
  Set-Content -Path $tempFile -Value $lines -Encoding UTF8
  Write-Host "Importing $($lines.Count) secrets to Fly..."
  Get-Content $tempFile | & $fly secrets import --app kaching-api
  Write-Host 'Secrets imported.'
} finally {
  if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
}

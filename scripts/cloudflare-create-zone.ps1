$ErrorActionPreference = 'Stop'
$accountId = '1a87e288ef5e521ff2f31f974e027a98'
$cfgPath = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
$cfg = Get-Content $cfgPath -Raw
$token = [regex]::Match($cfg, 'oauth_token = "([^"]+)"').Groups[1].Value
$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

$check = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/zones?name=kachingscanner.com' -Headers $headers
if ($check.result.Count -gt 0) {
  Write-Host "Zone already exists: $($check.result[0].status)"
  $check.result[0].name_servers | ForEach-Object { Write-Host "  $_" }
  exit 0
}

$body = @{
  name = 'kachingscanner.com'
  account = @{ id = $accountId }
  jump_start = $true
  type = 'full'
} | ConvertTo-Json

try {
  $resp = Invoke-RestMethod -Method POST -Uri 'https://api.cloudflare.com/client/v4/zones' -Headers $headers -Body $body
  Write-Host 'Zone created:' $resp.result.status
  $resp.result.name_servers | ForEach-Object { Write-Host "  $_" }
} catch {
  Write-Host 'Create zone failed.'
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
}

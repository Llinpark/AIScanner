$ErrorActionPreference = 'Stop'
$cfgPath = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
if (-not (Test-Path $cfgPath)) { Write-Host 'NOT_LOGGED_IN'; exit 1 }
$cfg = Get-Content $cfgPath -Raw
$token = [regex]::Match($cfg, 'oauth_token = "([^"]+)"').Groups[1].Value
$headers = @{ Authorization = "Bearer $token" }

$resp = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/zones?name=kachingscanner.com' -Headers $headers
if ($resp.result.Count -eq 0) {
  Write-Host 'DOMAIN_NOT_IN_CLOUDFLARE'
  Write-Host 'Add kachingscanner.com at: https://dash.cloudflare.com/1a87e288ef5e521ff2f31f974e027a98/domains/add'
  exit 0
}

$zone = $resp.result[0]
Write-Host "Zone status: $($zone.status)"
Write-Host 'Nameservers for hosting.com:'
$i = 1
foreach ($ns in $zone.name_servers) {
  Write-Host "$i. $ns"
  $i++
}

$ErrorActionPreference = 'Stop'
$cfgPath = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
$cfg = Get-Content $cfgPath -Raw
$token = [regex]::Match($cfg, 'oauth_token = "([^"]+)"').Groups[1].Value
$headers = @{ Authorization = "Bearer $token" }
$zoneId = '79f6e8df2acb75751036de023b23b57b'
$r = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?per_page=100" -Headers $headers
$r.result | ForEach-Object { "$($_.type) $($_.name) -> $($_.content) proxied=$($_.proxied)" }

$cfgPath = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
$cfg = Get-Content $cfgPath -Raw
$token = [regex]::Match($cfg, 'oauth_token = "([^"]+)"').Groups[1].Value
$headers = @{ Authorization = "Bearer $token" }
$r = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/zones?per_page=50' -Headers $headers
foreach ($z in $r.result) {
  Write-Output "$($z.name) | $($z.status) | $($z.id)"
}

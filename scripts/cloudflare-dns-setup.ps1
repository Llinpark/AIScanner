# Cloudflare DNS + Pages custom domain setup for kachingscanner.com
# Reads wrangler OAuth token locally. Does NOT print the token.
$ErrorActionPreference = 'Stop'

$accountId = '1a87e288ef5e521ff2f31f974e027a98'
$domain = 'kachingscanner.com'
$pagesProject = 'kachingscanner'
$flyCname = 'emqpwkk.kaching-api.fly.dev'
$pagesTarget = 'kachingscanner.pages.dev'

$cfgPath = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
if (-not (Test-Path $cfgPath)) { throw 'Wrangler not logged in. Run: wrangler login' }
$cfg = Get-Content $cfgPath -Raw
$token = [regex]::Match($cfg, 'oauth_token = "([^"]+)"').Groups[1].Value
if (-not $token) { throw 'No wrangler oauth token found.' }

$headers = @{
  Authorization = "Bearer $token"
  'Content-Type' = 'application/json'
}

function Invoke-Cf($Method, $Uri, $Body = $null) {
  if ($Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -Body ($Body | ConvertTo-Json -Depth 8)
  }
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers
}

Write-Host "Checking Cloudflare zone for $domain..."
$zoneResp = Invoke-Cf GET "https://api.cloudflare.com/client/v4/zones?name=$domain"
$zone = $zoneResp.result | Select-Object -First 1

if (-not $zone) {
  Write-Host 'Creating Cloudflare zone (jump_start scans existing DNS)...'
  $createBody = @{ name = $domain; account = @{ id = $accountId }; jump_start = $true; type = 'full' }
  $createResp = Invoke-Cf POST 'https://api.cloudflare.com/client/v4/zones' $createBody
  if (-not $createResp.success) { throw "Zone create failed: $($createResp.errors | ConvertTo-Json)" }
  $zone = $createResp.result
}

$zoneId = $zone.id
Write-Host "Zone ID: $zoneId  Status: $($zone.status)"

Write-Host ''
Write-Host '=== UPDATE NAMESERVERS AT HOSTING.COM TO THESE TWO ==='
$zone.name_servers | ForEach-Object { Write-Host "  $_" }
Write-Host '===================================================='
Write-Host ''

function Ensure-DnsRecord($type, $name, $content, $proxied = $false, $priority = $null) {
  $qName = if ($name -eq '@') { $domain } else { "$name.$domain" }
  $existing = Invoke-Cf GET "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=$type&name=$qName"
  $recordBody = @{
    type = $type
    name = $name
    content = $content
    proxied = [bool]$proxied
    ttl = 1
  }
  if ($priority -ne $null) { $recordBody.priority = $priority }

  if ($existing.result.Count -gt 0) {
    $id = $existing.result[0].id
    Write-Host "Updating $type $name -> $content"
    $null = Invoke-Cf PUT "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$id" $recordBody
  } else {
    Write-Host "Adding $type $name -> $content"
    $null = Invoke-Cf POST "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records" $recordBody
  }
}

# Frontend -> Cloudflare Pages
Ensure-DnsRecord 'CNAME' 'www' $pagesTarget $true
Ensure-DnsRecord 'CNAME' '@' $pagesTarget $true

# Backend API -> Fly (must be DNS-only / grey cloud)
Ensure-DnsRecord 'CNAME' 'api' $flyCname $false

# Pages custom domains
foreach ($hostName in @($domain, "www.$domain")) {
  Write-Host "Linking Pages domain: $hostName"
  try {
    $body = @{ name = $hostName }
    $resp = Invoke-Cf POST "https://api.cloudflare.com/client/v4/accounts/$accountId/pages/projects/$pagesProject/domains" $body
    if ($resp.success) { Write-Host "  OK: $hostName" } else { Write-Host "  Note: $($resp.errors | ConvertTo-Json -Compress)" }
  } catch {
    Write-Host "  Note: $hostName may already exist or zone pending: $($_.Exception.Message)"
  }
}

Write-Host ''
Write-Host 'Done. After nameservers propagate (15-60 min):'
Write-Host "  https://$domain"
Write-Host "  https://api.$domain/api/health"

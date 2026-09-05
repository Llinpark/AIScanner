# Create production DNS records using a Cloudflare API token with Zone:DNS:Edit.
# Usage:
#   $env:CLOUDFLARE_API_TOKEN = 'your_token_here'
#   powershell -ExecutionPolicy Bypass -File .\backend\scripts\cloudflare-dns-with-token.ps1

$ErrorActionPreference = 'Stop'

$token = $env:CLOUDFLARE_API_TOKEN
if (-not $token) {
  throw 'Set CLOUDFLARE_API_TOKEN first (Zone.DNS Edit + Zone.Zone Read on kachingscanner.com).'
}

$zoneId = '79f6e8df2acb75751036de023b23b57b'
$domain = 'kachingscanner.com'
$pagesTarget = 'kachingscanner.pages.dev'
$flyCname = 'emqpwkk.kaching-api.fly.dev'
$headers = @{
  Authorization = "Bearer $token"
  'Content-Type' = 'application/json'
}

function Ensure-DnsRecord($type, $name, $content, $proxied) {
  $qName = if ($name -eq '@') { $domain } else { "$name.$domain" }
  $existing = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=$type&name=$qName" -Headers $headers
  $body = @{
    type = $type
    name = $name
    content = $content
    proxied = [bool]$proxied
    ttl = 1
  } | ConvertTo-Json

  if ($existing.result.Count -gt 0) {
    $id = $existing.result[0].id
    Write-Host "Updating $type $qName -> $content (proxied=$proxied)"
    $null = Invoke-RestMethod -Method PUT -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$id" -Headers $headers -Body $body
  } else {
    Write-Host "Creating $type $qName -> $content (proxied=$proxied)"
    $null = Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records" -Headers $headers -Body $body
  }
}

Ensure-DnsRecord 'CNAME' 'www' $pagesTarget $true
Ensure-DnsRecord 'CNAME' '@' $pagesTarget $true
Ensure-DnsRecord 'CNAME' 'api' $flyCname $false

Write-Host ''
Write-Host 'DNS records upserted. Verify:'
Write-Host '  https://kachingscanner.com'
Write-Host '  https://api.kachingscanner.com/api/health'

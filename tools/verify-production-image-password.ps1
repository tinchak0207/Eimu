param(
  [string]$CredentialsPath = "C:\Users\lenovo\Downloads\imagepassword.txt",
  [string]$SiteBaseUrl = "https://image.tinchak0207.xyz",
  [string]$GatewayBaseUrl = "http://43.172.85.76",
  [ValidateSet("adobe-firefly", "gpt-image-2", "gemini-3.1-flash-image")]
  [string]$Model = "adobe-firefly",
  [ValidateSet("fast", "quality")]
  [string]$QualityMode = "quality",
  [string]$Prompt = "A cobalt-blue glass perfume bottle on a clean white studio background, product photography",
  [string]$OutputPath = "",
  [switch]$SkipGeneration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-JsonRequest {
  param(
    [string]$Uri,
    [string]$Method = "GET",
    [hashtable]$Headers = @{},
    [object]$Body
  )

  $params = @{ Uri = $Uri; Method = $Method; Headers = $Headers; UseBasicParsing = $true; TimeoutSec = 180 }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = $Body | ConvertTo-Json -Compress -Depth 8
  }
  try {
    $response = Invoke-WebRequest @params
    $payload = if ($response.Content) { $response.Content | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{ Status = [int]$response.StatusCode; Payload = $payload; Headers = $response.Headers }
  } catch {
    $response = $_.Exception.Response
    $status = if ($response) { [int]$response.StatusCode } else { 0 }
    $payload = $null
    if ($response -and $response.GetResponseStream()) {
      $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
      try {
        $content = $reader.ReadToEnd()
        if ($content) { $payload = $content | ConvertFrom-Json }
      } catch {
        $payload = $null
      } finally {
        $reader.Dispose()
      }
    }
    return [pscustomobject]@{ Status = $status; Payload = $payload; Headers = $null }
  }
}

function Get-CookieHeader {
  param([object]$Headers)
  if (-not $Headers) { return $null }
  $setCookies = @(
    if ($Headers -is [System.Collections.IDictionary] -and $Headers.ContainsKey("Set-Cookie")) {
      $Headers["Set-Cookie"]
  } elseif ($Headers.PSObject.Methods["GetValues"]) {
      $Headers.GetValues("Set-Cookie")
    }
  )
  if ($setCookies.Count -eq 0) { return $null }
  return ($setCookies | ForEach-Object { ($_ -split ";", 2)[0] }) -join "; "
}

$lines = @(Get-Content -LiteralPath $CredentialsPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($lines.Count -lt 2) { throw "imagepassword.txt must contain username:password and a Bearer token." }
$separator = $lines[0].IndexOf(":")
if ($separator -lt 1) { throw "The first imagepassword.txt line must be username:password." }

$username = $lines[0].Substring(0, $separator)
$password = $lines[0].Substring($separator + 1)
$candidateTokens = @($lines | Select-Object -Skip 1 | ForEach-Object {
  $value = $_.Trim()
  if ($value -match "=") { $value = $value -replace "^.*?=\\s*", "" }
  $value -replace "^Bearer\\s+", ""
} | Where-Object { $_ })
$token = $null
$userId = $null
$source = $null
$verified = $false

foreach ($providedToken in $candidateTokens) {
  $tokenMe = Invoke-JsonRequest -Uri "$($SiteBaseUrl.TrimEnd('/'))/api/auth/me" -Headers @{ Authorization = "Bearer $providedToken" }
  if ($tokenMe.Status -eq 200 -and $tokenMe.Payload -and $tokenMe.Payload.success -and $tokenMe.Payload.data -and $tokenMe.Payload.data.id) {
    $token = $providedToken
    $userId = [string]$tokenMe.Payload.data.id
    $source = "bearer"
    $verified = $true
    break
  }
}

if (-not $verified) {
  $login = Invoke-JsonRequest -Uri "$($GatewayBaseUrl.TrimEnd('/'))/api/user/login" -Method "POST" -Body @{ username = $username; password = $password }
  $cookie = Get-CookieHeader $login.Headers
  if ($login.Payload -and $login.Payload.success -and $login.Payload.data -and $login.Payload.data.id -and $cookie) {
    $loginId = $login.Payload.data.id
    $issued = Invoke-JsonRequest -Uri "$($GatewayBaseUrl.TrimEnd('/'))/api/user/token" -Headers @{ Cookie = $cookie; "New-Api-User" = [string]$loginId }
    if ($issued.Status -eq 200 -and $issued.Payload -and $issued.Payload.success -and $issued.Payload.data) {
      $candidateToken = [string]$issued.Payload.data
      $issuedMe = Invoke-JsonRequest -Uri "$($SiteBaseUrl.TrimEnd('/'))/api/auth/me" -Headers @{ Authorization = "Bearer $candidateToken"; "x-user-id" = [string]$loginId }
      if ($issuedMe.Status -eq 200 -and $issuedMe.Payload -and $issuedMe.Payload.success -and $issuedMe.Payload.data -and $issuedMe.Payload.data.id) {
        $token = $candidateToken
        $userId = [string]$issuedMe.Payload.data.id
        $source = "gateway-login"
        $verified = $true
      }
    }
  }
}

if (-not $verified) { throw "imagepassword verification did not produce a production session." }

Write-Output ([pscustomobject]@{ Stage = "auth"; Verified = $true; Source = $source })
if ($SkipGeneration) { return }

$generation = Invoke-JsonRequest -Uri "$($SiteBaseUrl.TrimEnd('/'))/api/generate-images" -Method "POST" -Headers @{ Authorization = "Bearer $token"; "x-user-id" = $userId } -Body @{
  provider = "image_tinchak"
  modelId = $Model
  prompt = $Prompt
  qualityMode = $QualityMode
}
$hasImage = [bool]($generation.Payload -and ($generation.Payload.image -or $generation.Payload.imageUrl))
$endpoint = if ($generation.Payload -and $generation.Payload.PSObject.Properties["endpointLabel"]) { $generation.Payload.endpointLabel } else { $null }
if ($generation.Status -ne 200 -or -not $hasImage) { throw "Production image generation did not return an image." }

$artifactBytes = 0
if ($OutputPath) {
  $imageValue = if ($generation.Payload.image) { [string]$generation.Payload.image } else { [string]$generation.Payload.imageUrl }
  if ($imageValue -match '^https?://') {
    Invoke-WebRequest -Uri $imageValue -OutFile $OutputPath -UseBasicParsing -TimeoutSec 120
  } else {
    $encoded = $imageValue -replace '^data:image/[^;]+;base64,', ''
    [IO.File]::WriteAllBytes($OutputPath, [Convert]::FromBase64String($encoded))
  }
  $artifactBytes = (Get-Item -LiteralPath $OutputPath).Length
}

Write-Output ([pscustomobject]@{ Stage = "generation"; Model = $Model; Http = $generation.Status; Delivered = $hasImage; Endpoint = $endpoint; ArtifactBytes = $artifactBytes })

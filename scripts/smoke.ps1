<#
  End-to-end smoke test against a running stack.

  Exercises the real HTTP surface the dashboard uses - registration, session cookies, CSRF,
  tenant scoping, property creation and the installation snippet - and asserts the security
  properties that matter, not just the happy path.

  Usage:  pwsh ./scripts/smoke.ps1        (or)  powershell -File .\scripts\smoke.ps1
#>

$ErrorActionPreference = 'Stop'
$api = $env:SMOKE_API_URL; if (-not $api) { $api = 'http://localhost:3001' }

$script:pass = 0
$script:fail = 0

function Check($name, $condition, $detail = '') {
    if ($condition) {
        $script:pass++
        Write-Host ("  PASS  " + $name) -ForegroundColor Green
    } else {
        $script:fail++
        Write-Host ("  FAIL  " + $name + " " + $detail) -ForegroundColor Red
    }
}

function New-Client { New-Object Microsoft.PowerShell.Commands.WebRequestSession }

function Call($session, $method, $path, $body = $null, $csrf = $null, $accountId = $null) {
    $headers = @{}
    if ($csrf) { $headers['x-csrf-token'] = $csrf }
    if ($accountId) { $headers['x-account-id'] = $accountId }
    $params = @{
        Uri             = "$api/api/v1$path"
        Method          = $method
        WebSession      = $session
        Headers         = $headers
        ContentType     = 'application/json'
        SkipHttpErrorCheck = $true
    }
    if ($null -ne $body) { $params['Body'] = ($body | ConvertTo-Json -Depth 6 -Compress) }
    $response = Invoke-WebRequest @params
    $parsed = $null
    if ($response.Content) { try { $parsed = $response.Content | ConvertFrom-Json } catch {} }
    return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $parsed }
}

function CookieValue($session, $name) {
    ($session.Cookies.GetCookies($api) | Where-Object { $_.Name -eq $name }).Value
}

Write-Host "`nSmartChat smoke test -> $api" -ForegroundColor Cyan

# --- health -------------------------------------------------------------------
Write-Host "`nHealth"
$health = Invoke-WebRequest -Uri "$api/health" -SkipHttpErrorCheck
Check 'GET /health returns 200' ($health.StatusCode -eq 200)
$ready = Invoke-WebRequest -Uri "$api/ready" -SkipHttpErrorCheck
$readyBody = $ready.Content | ConvertFrom-Json
Check 'GET /ready reports database ok' ($readyBody.checks.database -eq 'ok')
Check 'GET /ready reports redis ok' ($readyBody.checks.redis -eq 'ok')

# --- registration -------------------------------------------------------------
Write-Host "`nRegistration and session"
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$emailA = "smoke.a.$stamp@example.test"
$emailB = "smoke.b.$stamp@example.test"
$password = 'Tuesday-Mango-Ferry-42'

$clientA = New-Client
$reg = Call $clientA 'POST' '/auth/register' @{
    name = 'Smoke A'; email = $emailA; password = $password
    accountName = "Smoke A $stamp"; timezone = 'UTC'; locale = 'en'; acceptTerms = $true
}
Check 'register returns 201' ($reg.Status -eq 201) "got $($reg.Status)"
$accountA = $reg.Body.data.account.id
Check 'register returns an account' ($null -ne $accountA)
Check 'session cookie was set' ((CookieValue $clientA 'sc_session').Length -gt 20)
$csrfA = CookieValue $clientA 'sc_csrf'
Check 'csrf cookie was set' ($csrfA.Length -gt 10)

$weak = Call (New-Client) 'POST' '/auth/register' @{
    name = 'Weak'; email = "weak.$stamp@example.test"; password = 'password123'
    accountName = 'Weak'; timezone = 'UTC'; locale = 'en'; acceptTerms = $true
}
Check 'weak password is rejected (422)' ($weak.Status -eq 422) "got $($weak.Status)"

$dup = Call (New-Client) 'POST' '/auth/register' @{
    name = 'Dup'; email = $emailA; password = $password
    accountName = 'Dup'; timezone = 'UTC'; locale = 'en'; acceptTerms = $true
}
Check 'duplicate email is rejected (409)' ($dup.Status -eq 409) "got $($dup.Status)"

# --- authentication guards ----------------------------------------------------
Write-Host "`nAuthentication and CSRF"
$anon = Call (New-Client) 'GET' '/auth/me'
Check 'unauthenticated /auth/me returns 401' ($anon.Status -eq 401) "got $($anon.Status)"

$me = Call $clientA 'GET' '/auth/me'
Check 'authenticated /auth/me returns 200' ($me.Status -eq 200)
Check '/auth/me returns the right user' ($me.Body.data.user.email -eq $emailA)

$noCsrf = Call $clientA 'POST' '/properties' @{ name = 'x'; websiteUrl = 'example.com' }
Check 'mutation without CSRF header is rejected (403)' ($noCsrf.Status -eq 403) "got $($noCsrf.Status)"

$badCsrf = Call $clientA 'POST' '/properties' @{ name = 'x'; websiteUrl = 'example.com' } 'not-the-token'
Check 'mutation with a wrong CSRF token is rejected (403)' ($badCsrf.Status -eq 403) "got $($badCsrf.Status)"

$badLogin = Call (New-Client) 'POST' '/auth/login' @{ email = $emailA; password = 'wrong-password-here' }
Check 'wrong password returns 401' ($badLogin.Status -eq 401) "got $($badLogin.Status)"
Check 'wrong password does not say which field was wrong' ($badLogin.Body.error.code -eq 'INVALID_CREDENTIALS')

$unknown = Call (New-Client) 'POST' '/auth/login' @{ email = "nobody.$stamp@example.test"; password = $password }
Check 'unknown email returns the same error as a wrong password' ($unknown.Body.error.code -eq 'INVALID_CREDENTIALS')

# --- properties ---------------------------------------------------------------
Write-Host "`nProperties"
$created = Call $clientA 'POST' '/properties' @{ name = 'Smoke Site'; websiteUrl = 'smoke-example.com' } $csrfA
Check 'create property returns 201' ($created.Status -eq 201) "got $($created.Status)"
$propertyA = $created.Body.data.id
Check 'property has a public id' ($created.Body.data.publicId -like 'prp_*')
Check 'website url is normalised to https' ($created.Body.data.websiteUrl -eq 'https://smoke-example.com')
Check 'apex and www domains are seeded automatically' ($created.Body.data.domains.Count -ge 2)

$list = Call $clientA 'GET' '/properties'
Check 'list returns the new property' (($list.Body.data | Where-Object { $_.id -eq $propertyA }).Count -eq 1)

$install = Call $clientA 'GET' "/properties/$propertyA/install"
Check 'installation snippet is generated' ($install.Body.data.snippet -like '*loader.js*')
Check 'snippet contains the public id' ($install.Body.data.snippet -like "*$($created.Body.data.publicId)*")
Check 'snippet contains no secret' (
    ($install.Body.data.snippet -notlike '*SECRET*') -and
    ($install.Body.data.snippet -notlike '*sc_live*') -and
    ($install.Body.data.snippet -notlike "*$accountA*")
)

$badDomain = Call $clientA 'POST' "/properties/$propertyA/domains" @{ pattern = '*' } $csrfA
Check 'a bare wildcard domain is rejected' ($badDomain.Status -eq 422) "got $($badDomain.Status)"

# --- tenant isolation ---------------------------------------------------------
Write-Host "`nTenant isolation"
$clientB = New-Client
$regB = Call $clientB 'POST' '/auth/register' @{
    name = 'Smoke B'; email = $emailB; password = $password
    accountName = "Smoke B $stamp"; timezone = 'UTC'; locale = 'en'; acceptTerms = $true
}
Check 'second account registered' ($regB.Status -eq 201)
$csrfB = CookieValue $clientB 'sc_csrf'

$read = Call $clientB 'GET' "/properties/$propertyA"
Check "B cannot read A's property (404, not 403)" ($read.Status -eq 404) "got $($read.Status)"

$update = Call $clientB 'PATCH' "/properties/$propertyA" @{ name = 'hijacked' } $csrfB
Check "B cannot update A's property" ($update.Status -eq 404) "got $($update.Status)"

$remove = Call $clientB 'DELETE' "/properties/$propertyA" $null $csrfB
Check "B cannot delete A's property" ($remove.Status -eq 404) "got $($remove.Status)"

$installB = Call $clientB 'GET' "/properties/$propertyA/install"
Check "B cannot read A's installation snippet" ($installB.Status -eq 404) "got $($installB.Status)"

$listB = Call $clientB 'GET' '/properties'
Check "A's property never appears in B's list" (($listB.Body.data | Where-Object { $_.id -eq $propertyA }).Count -eq 0)

$switch = Call $clientB 'POST' '/auth/switch-account' @{ accountId = $accountA } $csrfB
Check "B cannot switch into A's account" ($switch.Status -eq 404) "got $($switch.Status)"

$header = Call $clientB 'GET' '/properties' $null $null $accountA
Check "B cannot borrow A's account via the x-account-id header" ($header.Status -eq 404) "got $($header.Status)"

# --- still alive after A's property was left untouched -------------------------
$stillThere = Call $clientA 'GET' "/properties/$propertyA"
Check "A's property survived every attempt" ($stillThere.Status -eq 200 -and $stillThere.Body.data.name -eq 'Smoke Site')

# --- sessions -----------------------------------------------------------------
Write-Host "`nSessions"
$sessions = Call $clientA 'GET' '/auth/sessions'
Check 'session list includes the current session' (($sessions.Body.data.sessions | Where-Object { $_.current }).Count -eq 1)

$logout = Call $clientA 'POST' '/auth/logout' $null $csrfA
Check 'logout returns 204' ($logout.Status -eq 204) "got $($logout.Status)"
$afterLogout = Call $clientA 'GET' '/auth/me'
Check 'session is dead immediately after logout' ($afterLogout.Status -eq 401) "got $($afterLogout.Status)"

# --- result -------------------------------------------------------------------
Write-Host ""
if ($script:fail -eq 0) {
    Write-Host "$($script:pass) checks passed." -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($script:pass) passed, $($script:fail) FAILED." -ForegroundColor Red
    exit 1
}

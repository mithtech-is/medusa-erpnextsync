<#
.SYNOPSIS
  Resolve the Windows <-> WSL addresses of the local connector stack and write
  them where each side reads them.

.DESCRIPTION
  WSL2 runs in NAT mode here, so:
    * Medusa (Windows)  -> Frappe (WSL):  the WSL IP (changes on every WSL restart)
                                          or 127.0.0.1 through localhost forwarding
    * Frappe (WSL)      -> Medusa (Windows): the WSL default gateway (the Windows
                                             vEthernet adapter, usually 172.26.48.1)
  Run this after every WSL restart, before starting the stacks. It:
    1. picks the Windows->WSL address that actually answers on the Frappe port
       (falls back to the WSL IP when the bench is down),
    2. writes ERPNEXT_URL into the sandbox backend .env,
    3. writes Medusync Settings.medusa_url on the Frappe site (bench execute),
    4. optionally updates the plugin's erpnext_url via the Medusa admin API
       (-MedusaAdminEmail / -MedusaAdminPassword, or env MEDUSA_ADMIN_EMAIL /
       MEDUSA_ADMIN_PASSWORD) when Medusa is already running.

.EXAMPLE
  pwsh scripts/dev/resolve-addresses.ps1
  pwsh scripts/dev/resolve-addresses.ps1 -NoWrite      # just print
#>
[CmdletBinding()]
param(
  [string]$Distro = "Ubuntu",
  [string]$BenchUser = $env:USERNAME,
  [string]$BenchPath = "~/frappe-bench",
  [string]$Site = "site1.local",
  # The Medusa project is not in this repo and its path is yours. Pass it,
  # or set MEDUSA_BACKEND_ENV; without one the script only prints.
  [string]$BackendEnv = $env:MEDUSA_BACKEND_ENV,
  [int]$FrappePort = 8000,
  [int]$MedusaPort = 9000,
  [string]$MedusaAdminEmail = $env:MEDUSA_ADMIN_EMAIL,
  [string]$MedusaAdminPassword = $env:MEDUSA_ADMIN_PASSWORD,
  [switch]$NoWrite
)

$ErrorActionPreference = "Stop"

function Invoke-Wsl([string[]]$WslArgs) {
  # Note: `$` inside arguments gets mangled on the way into WSL; keep commands variable-free.
  & wsl.exe -d $Distro @WslArgs 2>$null
}

# ── 1. discover ────────────────────────────────────────────────────────────────
$wslIp = ((Invoke-Wsl @("--", "hostname", "-I")) -join " ").Trim().Split(" ")[0]
$routeLine = ((Invoke-Wsl @("--", "ip", "route", "show", "default")) -join " ").Trim()
$gateway = ($routeLine -split "\s+")[2]
if (-not $wslIp -or -not $gateway) { throw "could not read WSL IP / gateway (distro '$Distro' running?)" }

function Test-Port([string]$Address, [int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ok = $c.ConnectAsync($Address, $Port).Wait(1500) -and $c.Connected
    $c.Dispose(); return [bool]$ok
  } catch { return $false }
}

$frappeHost = $null
foreach ($candidate in @("127.0.0.1", $wslIp)) {
  if (Test-Port $candidate $FrappePort) { $frappeHost = $candidate; break }
}
$frappeReachable = [bool]$frappeHost
if (-not $frappeHost) { $frappeHost = $wslIp }

$erpnextUrl = "http://${frappeHost}:${FrappePort}"
$medusaUrl = "http://${gateway}:${MedusaPort}"

Write-Host "WSL IP           : $wslIp"
Write-Host "WSL gateway      : $gateway   (Windows host as seen from WSL)"
Write-Host "Medusa -> Frappe : $erpnextUrl  (frappe answering now: $frappeReachable)"
Write-Host "Frappe -> Medusa : $medusaUrl"
if ($NoWrite) { return }

# ── 2. the Medusa project's .env ──────────────────────────────────────────────
# Its path is not this repo's business, so there is no default worth guessing.
# Without one, everything else still runs and this step says it was skipped.
if ([string]::IsNullOrWhiteSpace($BackendEnv)) {
  Write-Warning "no -BackendEnv and no MEDUSA_BACKEND_ENV; ERPNEXT_URL not written"
} else {
  $BackendEnv = [System.IO.Path]::GetFullPath($BackendEnv)
  if (Test-Path -LiteralPath $BackendEnv) {
    $lines = Get-Content -LiteralPath $BackendEnv
    $found = $false
    $lines = $lines | ForEach-Object {
      if ($_ -match '^\s*ERPNEXT_URL=') { $found = $true; "ERPNEXT_URL=$erpnextUrl" } else { $_ }
    }
    if (-not $found) { $lines += "ERPNEXT_URL=$erpnextUrl" }
    [System.IO.File]::WriteAllText($BackendEnv, (($lines -join "`n") + "`n"))
    Write-Host "wrote ERPNEXT_URL -> $BackendEnv"
  } else {
    Write-Warning ".env not found at $BackendEnv (skipped)"
  }
}

# ── 3. Medusync Site.medusa_url (Frappe side) ─────────────────────────────────
# Every connected store is a Medusync Site record and delivery reads the URL
# from there; the Single's connection fields are legacy and no longer used to
# send anything. Every enabled site is updated, which is right while they all
# point at one local Medusa — pass -NoWrite first if that is not true here.
$script = @"
#!/usr/bin/env bash
set -e
export PATH="`$HOME/.local/bin:`$PATH"
cd $BenchPath/sites
../env/bin/python - <<'PYEOF'
import frappe
frappe.init(site="$Site", sites_path=".")
frappe.connect()
rows = frappe.get_all("Medusync Site", filters={"enabled": 1}, fields=["name"])
if not rows:
    print("no enabled Medusync Site - create one in the Desk first")
for row in rows:
    frappe.db.set_value("Medusync Site", row.name, "medusa_url", "$medusaUrl", update_modified=False)
    print("Medusync Site", row.name, "medusa_url =", "$medusaUrl")
frappe.db.commit()
frappe.clear_cache()
PYEOF
"@
$tmp = Join-Path $env:TEMP "medusync-set-url.sh"
[System.IO.File]::WriteAllText($tmp, ($script -replace "`r`n", "`n"))
$tmpWsl = "/mnt/" + $tmp.Substring(0, 1).ToLower() + ($tmp.Substring(2) -replace "\\", "/")
& wsl.exe -d $Distro -u $BenchUser -- bash $tmpWsl

# ── 4. plugin erpnext_url (Medusa side, only when running + creds given) ─────
if ($MedusaAdminEmail -and $MedusaAdminPassword -and (Test-Port "127.0.0.1" $MedusaPort)) {
  try {
    $base = "http://127.0.0.1:${MedusaPort}"
    $auth = Invoke-RestMethod -Method Post -Uri "$base/auth/user/emailpass" -ContentType "application/json" `
      -Body (@{ email = $MedusaAdminEmail; password = $MedusaAdminPassword } | ConvertTo-Json)
    $headers = @{ Authorization = "Bearer $($auth.token)" }
    Invoke-RestMethod -Method Post -Uri "$base/admin/erpnext/settings" -Headers $headers -ContentType "application/json" `
      -Body (@{ erpnext_url = $erpnextUrl } | ConvertTo-Json) | Out-Null
    Write-Host "plugin erpnext_setting.erpnext_url = $erpnextUrl"
  } catch {
    Write-Warning "could not update the plugin setting via the admin API: $($_.Exception.Message)"
  }
} else {
  Write-Host "plugin erpnext_url not updated (Medusa not running or no admin credentials); the env fallback ERPNEXT_URL applies when the setting row is empty."
}

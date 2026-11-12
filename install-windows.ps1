# BE-Aero Relay Server: install on Windows as a scheduled task that starts at
# boot (runs whether or not anyone is signed in), with a firewall rule for
# its port. Run in an elevated PowerShell, from the unzipped release folder:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
# Remove with:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall
# Uses be-aero-relay.exe from this folder (nothing else needed), or relay.js
# with Node.js 18+ from the source release.
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:ProgramData 'BE-Aero Relay'
$Data = Join-Path $Dir 'data'
$Task = 'BE-Aero Relay Server'

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName $Task -ErrorAction SilentlyContinue
  Get-ChildItem $Dir -Exclude data -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  Write-Host "Removed. Its data is still in $Data (delete it to forget the paired devices)."
  return
}

$exe = Join-Path $PSScriptRoot 'be-aero-relay.exe'
if (Test-Path $exe) {
  $run = Join-Path $Dir 'be-aero-relay.exe'; $runArgs = ''
} else {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'be-aero-relay.exe is not in this folder, and Node.js 18+ is not installed.' }
  $major = [int](& $node -p 'process.versions.node.split(".")[0]')
  if ($major -lt 18) { throw "Node.js 18+ is needed (found $(& $node -v))" }
  $run = $node; $runArgs = "`"$Dir\relay.js`""
}

# Stop a running copy before replacing its files (an update).
Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Get-Process be-aero-relay -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
New-Item -ItemType Directory -Force -Path $Dir, $Data | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $Dir -Recurse -Force -Exclude 'data'
# Only SYSTEM and Administrators may read the relay's identity and mail.
icacls $Data /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
[Environment]::SetEnvironmentVariable('RELAY_DATA', $Data, 'Machine')

$action = if ($runArgs) { New-ScheduledTaskAction -Execute $run -Argument $runArgs -WorkingDirectory $Dir } else { New-ScheduledTaskAction -Execute $run -WorkingDirectory $Dir }
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $Task
if (-not (Get-NetFirewallRule -DisplayName $Task -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $Task -Direction Inbound -Protocol TCP -LocalPort 41811 -Action Allow | Out-Null
}

Write-Host 'Installed and started (port 41811). Pair your devices - in this elevated window:'
if ($runArgs) { Write-Host "    `$env:RELAY_DATA='$Data'; node '$Dir\relay.js' pair" } else { Write-Host "    `$env:RELAY_DATA='$Data'; & '$Dir\be-aero-relay.exe' pair" }

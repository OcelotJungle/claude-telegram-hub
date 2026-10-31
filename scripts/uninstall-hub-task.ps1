# telegram-hub: remove the task scripts\install-hub-task.ps1 registered. A hub
# already running keeps running until it is stopped or the user logs off.
#
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-hub-task.ps1

$ErrorActionPreference = 'Stop'

$TaskName = 'telegram-hub'

# Windows start the hub themselves again; removed also when the task is already gone.
$stateDir = if ($env:TELEGRAM_HUB_STATE_DIR) { $env:TELEGRAM_HUB_STATE_DIR } else { Join-Path $HOME '.claude\channels\telegram-hub' }
Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $stateDir 'service-managed')

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Host "No task '$TaskName'."
    return
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Task '$TaskName' removed."

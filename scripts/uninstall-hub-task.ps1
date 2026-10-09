# tg-hub: remove the task scripts\install-hub-task.ps1 registered. A hub
# already running keeps running until it is stopped or the user logs off.
#
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-hub-task.ps1

$ErrorActionPreference = 'Stop'

$TaskName = 'tg-hub'

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Host "No task '$TaskName'."
    return
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Task '$TaskName' removed."

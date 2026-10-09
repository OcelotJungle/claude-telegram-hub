# tg-hub: keep the hub running, so a message in a topic can start its session.
# Registers a Task Scheduler task for the current user: it starts the hub at
# logon and checks every 5 minutes; a hub already running (started by the task
# or by a window) makes the new one exit at once, a crashed hub comes back.
# The hub runs in a hidden console, in your interactive session, so the
# windows it starts are visible.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-hub-task.ps1
#
# No administrator rights needed. scripts\uninstall-hub-task.ps1 removes it.

$ErrorActionPreference = 'Stop'

$TaskName = 'tg-hub'
$CheckEveryMinutes = 5

$bun = (Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $bun) { throw 'bun is not on PATH' }
$main = (Resolve-Path (Join-Path $PSScriptRoot '..\plugin\src\hub\main.ts')).Path
$user = "$env:USERDOMAIN\$env:USERNAME"

# conhost --headless gives bun a console nobody sees.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$bun`" `"$main`" --always-on" -WorkingDirectory (Split-Path $main)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# A logon trigger cannot take a repetition directly: borrow one.
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $CheckEveryMinutes)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'tg-hub: Telegram hub for Claude Code sessions' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Task '$TaskName' registered and started: $bun $main --always-on"

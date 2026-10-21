# tg-hub: restart the hub, for example after its code changed. Queued messages
# survive: the new hub delivers what the old one left.
# Needs the Task Scheduler task (scripts\install-hub-task.ps1): the hub left
# running is the task's (--always-on). An open window starts its own hub
# ~100 ms after the old one dies and then waits 2 s before it may start
# another, so a window's hub is killed right after it appears and the task is
# started inside that pause.
#
#   powershell -ExecutionPolicy Bypass -File scripts\restart-hub.ps1

$TaskName = 'tg-hub'
$Tries = 5

function Get-Hubs {
  Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object { $_.CommandLine -like '*hub\main.ts*' }
}

for ($try = 1; $try -le $Tries; $try++) {
  Get-Hubs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Milliseconds 400
  Get-Hubs | Where-Object { $_.CommandLine -notlike '*--always-on*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 5
  $hubs = @(Get-Hubs)
  $hubs | ForEach-Object { "try $try" + ": hub $($_.ProcessId) $($_.CommandLine)" }
  if ($hubs.Count -eq 1 -and $hubs[0].CommandLine -like '*--always-on*') { "task hub is running"; exit 0 }
}
"gave up"
exit 1

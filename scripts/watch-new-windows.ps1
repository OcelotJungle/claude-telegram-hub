param(
  [int]$Seconds = 900,
  [string]$Out = "",
  [string]$StopFile = ""
)
# Diagnoses flashing console windows: logs every top-level window shown (WINDOW
# lines) and every new process (proc lines: pid, parent, exe, best-effort command
# line), so a window can be traced to the process that caused it. Stops after
# -Seconds or once -StopFile exists. Times are UTC. Without -Out it prints.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/watch-new-windows.ps1 -Out .tmp/w.log -StopFile .tmp/w.stop
Add-Type -Path (Join-Path $PSScriptRoot "watch-new-windows.cs") -ReferencedAssemblies System.Management
[WatchWin]::Run($Seconds, $Out, $StopFile)

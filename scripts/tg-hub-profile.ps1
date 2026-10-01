# tg-hub: start every Claude Code window with the tg-hub channel, without typing flags.
# Dot-source it from your PowerShell profile ($PROFILE):
#   . C:\code\claude-telegram-hub\scripts\tg-hub-profile.ps1
#
# Override before dot-sourcing if needed, e.g. once tg-hub is on an allowlist
# (allowedChannelPlugins in managed settings):
#   $global:TgHubChannelArgs = @('--channels', 'plugin:tg-hub@tg-hub-local')

if (-not $global:TgHubChannelArgs) {
    $global:TgHubChannelArgs = @('--dangerously-load-development-channels', 'plugin:tg-hub@tg-hub-local')
}
if (-not $global:TgHubClaudeExe) {
    $global:TgHubClaudeExe = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
if (-not $global:TgHubCswapExe) {
    $global:TgHubCswapExe = (Get-Command cswap -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}

$script:TgHubSubcommands = @(
    'mcp', 'plugin', 'plugins', 'config', 'doctor', 'update', 'upgrade', 'install', 'attach', 'logs',
    'rm', 'stop', 'kill', 'respawn', 'setup-token', 'auth', 'migrate-installer', 'agents'
)
$script:TgHubNonInteractive = @('-p', '--print', '-v', '--version', '-h', '--help')

function Test-TgHubInteractive([string[]]$ClaudeArgs) {
    if ($ClaudeArgs.Count -gt 0 -and $script:TgHubSubcommands -contains $ClaudeArgs[0]) { return $false }
    foreach ($a in $ClaudeArgs) { if ($script:TgHubNonInteractive -contains $a) { return $false } }
    return $true
}

# Arguments for claude.exe: the channel flag goes in front for interactive sessions.
function Get-TgHubClaudeArgs([string[]]$Rest) {
    $list = @($Rest | Where-Object { $_ -ne $null })
    if (Test-TgHubInteractive $list) { return @($global:TgHubChannelArgs) + $list }
    return $list
}

# Arguments for cswap: `cswap run N [-- args]` passes args after -- to claude.
function Get-TgHubCswapArgs([string[]]$Rest) {
    $list = @($Rest | Where-Object { $_ -ne $null })
    if ($list.Count -eq 0 -or $list[0] -ne 'run') { return $list }
    $sep = [array]::IndexOf($list, '--')
    if ($sep -lt 0) {
        $head = $list
        $tail = @()
    } else {
        $head = @($list[0..($sep - 1)])
        $tail = if ($sep -lt $list.Count - 1) { @($list[($sep + 1)..($list.Count - 1)]) } else { @() }
    }
    if (-not (Test-TgHubInteractive $tail)) { return $list }
    return $head + @('--') + @($global:TgHubChannelArgs) + $tail
}

function claude { & $global:TgHubClaudeExe @(Get-TgHubClaudeArgs $args) }
function cswap { & $global:TgHubCswapExe @(Get-TgHubCswapArgs $args) }

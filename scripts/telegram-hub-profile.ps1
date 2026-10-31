# telegram-hub: start every Claude Code window with the telegram-hub channel, without typing flags.
# Dot-source it from your PowerShell profile ($PROFILE):
#   . C:\code\claude-telegram-hub\scripts\telegram-hub-profile.ps1
#
# Override before dot-sourcing if needed, e.g. once telegram-hub is on an allowlist
# (allowedChannelPlugins in managed settings):
#   $global:TelegramHubChannelArgs = @('--channels', 'plugin:telegram-hub@telegram-hub')

if (-not $global:TelegramHubChannelArgs) {
    $global:TelegramHubChannelArgs = @('--dangerously-load-development-channels', 'plugin:telegram-hub@telegram-hub')
}
if (-not $global:TelegramHubClaudeExe) {
    $global:TelegramHubClaudeExe = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
if (-not $global:TelegramHubCswapExe) {
    $global:TelegramHubCswapExe = (Get-Command cswap -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}

$script:TelegramHubSubcommands = @(
    'mcp', 'plugin', 'plugins', 'config', 'doctor', 'update', 'upgrade', 'install', 'attach', 'logs',
    'rm', 'stop', 'kill', 'respawn', 'setup-token', 'auth', 'migrate-installer', 'agents'
)
$script:TelegramHubNonInteractive = @('-p', '--print', '-v', '--version', '-h', '--help')

function Test-TelegramHubInteractive([string[]]$ClaudeArgs) {
    if ($ClaudeArgs.Count -gt 0 -and $script:TelegramHubSubcommands -contains $ClaudeArgs[0]) { return $false }
    foreach ($a in $ClaudeArgs) { if ($script:TelegramHubNonInteractive -contains $a) { return $false } }
    return $true
}

# Arguments for claude.exe: the channel flag goes in front for interactive sessions.
function Get-TelegramHubClaudeArgs([string[]]$Rest) {
    $list = @($Rest | Where-Object { $_ -ne $null })
    if (Test-TelegramHubInteractive $list) { return @($global:TelegramHubChannelArgs) + $list }
    return $list
}

# Arguments for cswap: `cswap run N [-- args]` passes args after -- to claude.
function Get-TelegramHubCswapArgs([string[]]$Rest) {
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
    if (-not (Test-TelegramHubInteractive $tail)) { return $list }
    return $head + @('--') + @($global:TelegramHubChannelArgs) + $tail
}

function claude { & $global:TelegramHubClaudeExe @(Get-TelegramHubClaudeArgs $args) }
function cswap { & $global:TelegramHubCswapExe @(Get-TelegramHubCswapArgs $args) }

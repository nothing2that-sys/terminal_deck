# Session-only OSC 133 shell integration for Terminal Deck.
# This script is loaded with PowerShell -NoExit -Command and never edits $PROFILE.

if (
    (Test-Path variable:global:__MultiSessionManagerShellIntegration) -or
    $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'
) {
    return
}

$Global:__MultiSessionManagerShellIntegration = @{
    OriginalPrompt = $function:Prompt
    OriginalReadLine = $null
    HasPSReadLine = $false
    IsInExecution = $false
    Nonce = $env:MULTI_SESSION_MANAGER_OSC_NONCE
}
$env:MULTI_SESSION_MANAGER_OSC_NONCE = $null

function Global:__MSM-Osc133 {
    param([string] $Payload)
    "$([char]0x1b)]133;$Payload$([char]0x07)"
}

function Global:Prompt {
    $fakeExitCode = [int]!$global:?
    $result = ''

    if ($Global:__MultiSessionManagerShellIntegration.IsInExecution) {
        $Global:__MultiSessionManagerShellIntegration.IsInExecution = $false
        $result += __MSM-Osc133 "D;$($Global:__MultiSessionManagerShellIntegration.Nonce);$fakeExitCode"
    }

    $result += __MSM-Osc133 "A;$($Global:__MultiSessionManagerShellIntegration.Nonce)"

    # Restore $? before invoking the user's original prompt.
    if ($fakeExitCode -ne 0) {
        Write-Error 'failure' -ErrorAction Ignore
    }

    $result += $Global:__MultiSessionManagerShellIntegration.OriginalPrompt.Invoke()
    $pathBytes = [Text.Encoding]::UTF8.GetBytes([string] $PWD.Path)
    $encodedPath = [Convert]::ToBase64String($pathBytes)
    $result += __MSM-Osc133 "B;$($Global:__MultiSessionManagerShellIntegration.Nonce);$encodedPath"
    $result
}

if (Get-Module -Name PSReadLine) {
    $Global:__MultiSessionManagerShellIntegration.HasPSReadLine = $true
    $Global:__MultiSessionManagerShellIntegration.OriginalReadLine =
        $function:PSConsoleHostReadLine

    Set-PSReadLineKeyHandler -Chord Ctrl+g -ScriptBlock {
        $line = ''
        $cursor = 0
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState(
            [ref] $line,
            [ref] $cursor
        )
        if ($line.Length -gt 0) {
            [Microsoft.PowerShell.PSConsoleReadLine]::Replace(
                0,
                $line.Length,
                ''
            )
        }
    }

    function Global:PSConsoleHostReadLine {
        $commandLine =
            $Global:__MultiSessionManagerShellIntegration.OriginalReadLine.Invoke()
        $Global:__MultiSessionManagerShellIntegration.IsInExecution = $true

        $commandBytes = [Text.Encoding]::UTF8.GetBytes([string] $commandLine)
        $encodedCommand = [Convert]::ToBase64String($commandBytes)
        $nonce = $Global:__MultiSessionManagerShellIntegration.Nonce
        $markers =
            (__MSM-Osc133 "E;$nonce;$encodedCommand") +
            (__MSM-Osc133 "C;$nonce")

        [Console]::Write($markers)
        $commandLine
    }
}

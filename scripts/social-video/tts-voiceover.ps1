<#
  Renders one line of narration to a WAV file using the local Windows SAPI
  voices. Fully offline: no cloud TTS, no API keys, nothing leaves the machine.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tts-voiceover.ps1 `
      -TextFile line.txt -Out line.wav -Voice "Microsoft Zira Desktop" -Rate 2

  The text is read from a file (not passed on the command line) so punctuation,
  quotes and em dashes survive PowerShell argument handling unchanged.
#>
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Voice,
  [int]$Rate = 0
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

if (-not (Test-Path -LiteralPath $TextFile)) {
  throw "Missing text file: $TextFile"
}

$text = (Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($text)) {
  throw "Empty text file: $TextFile"
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $installed = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
  if ($installed -contains $Voice) {
    $synth.SelectVoice($Voice)
  }
  else {
    Write-Warning "Voice '$Voice' is not installed; using the SAPI default. Installed: $($installed -join ', ')"
  }

  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $synth.SetOutputToWaveFile($Out)
  $synth.Speak($text)
}
finally {
  $synth.Dispose()
}

Write-Output "voiceover -> $Out"

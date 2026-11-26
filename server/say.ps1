# Reads a text aloud into a WAV file with a voice that Windows already has. Hearth runs it for spoken answers.
# Usage: say.ps1 -TextFile <utf-8 text> -Out <file.wav> -Lang <ru|en|...>
# Prints one line: "OK <voice name>", "NO_VOICE <languages that have a voice>", or "ERROR <what went wrong>".
param([string]$TextFile, [string]$Out, [string]$Lang = 'en')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
$seen = @()
$why = ''

# 1. The voices of Windows 10 and 11 (Settings > Time & language > Speech). They cover the most languages.
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Wait-Result($operation, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $null = $task.Wait(120000)
    return $task.Result
  }
  $all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  $seen += $all | ForEach-Object { $_.Language }
  $voice = $all | Where-Object { $_.Language -like "$Lang*" } | Select-Object -First 1
  if ($voice) {
    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    $synth.Voice = $voice
    $stream = Wait-Result ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $size = [uint32]$stream.Size
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $null = Wait-Result ($reader.LoadAsync($size)) ([uint32])
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    [IO.File]::WriteAllBytes($Out, $bytes)
    Write-Output ("OK " + $voice.DisplayName)
    exit 0
  }
} catch {
  $why = $_.Exception.Message
}

# 2. The classic voices (the ones older programs use).
try {
  Add-Type -AssemblyName System.Speech
  $classic = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = $classic.GetInstalledVoices() | Where-Object { $_.Enabled }
  $seen += $voices | ForEach-Object { $_.VoiceInfo.Culture.Name }
  $pick = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like "$Lang*" } | Select-Object -First 1
  if ($pick) {
    $classic.SelectVoice($pick.VoiceInfo.Name)
    $classic.SetOutputToWaveFile($Out)
    $classic.Speak($text)
    $classic.Dispose()
    Write-Output ("OK " + $pick.VoiceInfo.Name)
    exit 0
  }
} catch {
  $why = ($why + ' | ' + $_.Exception.Message).Trim(' |')
}

if ($why -and -not $seen) { Write-Output ("ERROR " + $why); exit 2 }
Write-Output ("NO_VOICE " + (($seen | Sort-Object -Unique) -join ','))
exit 3

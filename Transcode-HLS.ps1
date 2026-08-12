<#
.SYNOPSIS
    Batch HLS VOD encoder - mimics a Bunny Stream style adaptive bitrate pipeline
    using NVIDIA NVENC hardware acceleration. Output is ready to upload to Cloudflare R2.

.DESCRIPTION
    For every video in -InputDir, produces:

        <OutputDir>\<VideoName>\
            master.m3u8
            stream_0\playlist.m3u8 + data###.ts      (1080p)
            stream_1\playlist.m3u8 + data###.ts      (720p)
            stream_2\playlist.m3u8 + data###.ts      (480p)

    Encoder : h264_nvenc, -preset p6, -tune hq
    Bitrates: 5000k / 2800k / 1400k video, 128k AAC stereo audio
    GOP     : -g 48 -keyint_min 48 -sc_threshold 0 (plus NVENC -no-scenecut / -forced-idr)
    Packager: -f hls, -hls_time 4, MPEG-TS segments, VOD playlist

.PARAMETER InputDir
    Folder containing the source videos. Prompted for if omitted.

.PARAMETER OutputDir
    Folder that will receive one subfolder per video. Prompted for if omitted.

.PARAMETER Extensions
    Source file extensions to pick up. Default: mp4.

.PARAMETER Recurse
    Search InputDir recursively.

.PARAMETER Overwrite
    Re-encode videos whose output folder already contains a master.m3u8.
    Without this, completed videos are skipped (safe to re-run after an interruption).

.PARAMETER AutoGop
    Set the GOP to (round(fps) * 2) per source instead of a fixed 48, so that the
    keyframe interval divides evenly into the 4-second segment duration.
    See the "GOP" note printed at runtime for why this matters.

.PARAMETER SkipUpscale
    Drop ladder rungs larger than the source (a 720p input yields only 720p + 480p).
    This is what Bunny does. Off by default - all three rungs are always produced.

.PARAMETER SanitizeNames
    Slugify output folder names to URL-safe characters (a-z 0-9 - _) for clean R2
    object keys. A name-map.csv recording original -> slug is written to OutputDir.

.PARAMETER SoftwareDecode
    Disable CUDA-accelerated decoding (encoding stays on NVENC). The script already
    falls back to this automatically if hardware decode fails on a given file.

.EXAMPLE
    .\Transcode-HLS.ps1 -InputDir "D:\raw" -OutputDir "D:\hls"

.EXAMPLE
    .\Transcode-HLS.ps1 -InputDir "D:\raw" -OutputDir "D:\hls" -AutoGop -SkipUpscale -SanitizeNames
#>

[CmdletBinding()]
param(
    [string]   $InputDir,
    [string]   $OutputDir,
    [string[]] $Extensions = @('mp4'),
    [switch]   $Recurse,
    [switch]   $Overwrite,
    [switch]   $AutoGop,
    [switch]   $SkipUpscale,
    [switch]   $SanitizeNames,
    [switch]   $SoftwareDecode
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------------------
# Encoding ladder. Bitrates per the spec; maxrate ~1.07x, bufsize 2x (HLS norm).
# ----------------------------------------------------------------------------
$Ladder = @(
    [pscustomobject]@{ Name = '1080p'; W = 1920; H = 1080; V = 5000; Max = 5350; Buf = 10000 }
    [pscustomobject]@{ Name = '720p';  W = 1280; H = 720;  V = 2800; Max = 2996; Buf = 5600  }
    [pscustomobject]@{ Name = '480p';  W = 854;  H = 480;  V = 1400; Max = 1498; Buf = 2800  }
)

$AudioBitrate  = '128k'
$SegmentTime   = 4
$FixedGop      = 48

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

function Assert-Tool {
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "$Name was not found on PATH. Install FFmpeg (winget install Gyan.FFmpeg) and reopen the shell."
    }
    return $cmd.Source
}

function Get-MediaInfo {
    <# Probes width/height/fps and whether an audio track exists. #>
    param([string]$Path)

    # Function-scoped, so it reverts automatically on return. Keeps ffprobe's
    # stderr from being promoted to a terminating error on damaged files.
    $ErrorActionPreference = 'Continue'

    $v = & ffprobe -v error -select_streams v:0 `
                   -show_entries stream=width,height,avg_frame_rate `
                   -of csv=p=0 -- $Path
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($v)) {
        throw "ffprobe could not read a video stream from this file."
    }

    $f = ($v | Select-Object -First 1).Trim().Split(',')
    $width  = [int]$f[0]
    $height = [int]$f[1]

    $fps = 0.0
    if ($f.Count -ge 3 -and $f[2] -match '^(\d+)/(\d+)$') {
        $den = [double]$Matches[2]
        if ($den -gt 0) { $fps = [double]$Matches[1] / $den }
    }

    $a = & ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 -- $Path
    $hasAudio = ($LASTEXITCODE -eq 0) -and (-not [string]::IsNullOrWhiteSpace($a))

    $dur = & ffprobe -v error -show_entries format=duration -of csv=p=0 -- $Path
    $duration = 0.0
    if (-not [string]::IsNullOrWhiteSpace($dur)) {
        [double]::TryParse(($dur | Select-Object -First 1).Trim(),
            [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$duration) | Out-Null
    }

    return [pscustomobject]@{
        Width = $width; Height = $height; Fps = $fps
        HasAudio = $hasAudio; Duration = $duration
    }
}

function Get-Slug {
    param([string]$Name)
    $s = $Name.ToLowerInvariant()
    $s = [regex]::Replace($s, '[^a-z0-9]+', '-')
    $s = $s.Trim('-')
    if ([string]::IsNullOrWhiteSpace($s)) { $s = 'video' }
    return $s
}

function Invoke-Ffmpeg {
    <#
        Runs ffmpeg and returns its exit code.

        FFmpeg writes all of its normal output to stderr. Under PowerShell 5.1 that
        stderr can be surfaced as ErrorRecords, which would turn a harmless warning
        into a terminating error while $ErrorActionPreference is 'Stop'. Relax the
        preference for the duration of the call and rely on the exit code instead.
    #>
    param([string[]]$Arguments)

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & ffmpeg @Arguments
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

function Build-FfmpegArgs {
    <# Builds the full ffmpeg argument array for one source file. #>
    param(
        [string] $Source,
        [string] $OutFolder,
        [array]  $Rungs,
        [int]    $Gop,
        [bool]   $HasAudio,
        [bool]   $UseHwDecode
    )

    $n = $Rungs.Count
    $a = New-Object System.Collections.Generic.List[string]

    $a.Add('-hide_banner'); $a.Add('-y')
    $a.Add('-loglevel');    $a.Add('warning')
    $a.Add('-stats')

    if ($UseHwDecode) { $a.Add('-hwaccel'); $a.Add('cuda') }

    $a.Add('-i'); $a.Add($Source)

    # Videos with no audio track still need an audio rendition per variant,
    # otherwise -var_stream_map breaks. Feed silence from lavfi.
    if (-not $HasAudio) {
        $a.Add('-f'); $a.Add('lavfi')
        $a.Add('-i'); $a.Add('anullsrc=channel_layout=stereo:sample_rate=48000')
    }

    # --- filter_complex: one split, one scaler per rung ----------------------
    $splitLabels = @()
    for ($i = 0; $i -lt $n; $i++) { $splitLabels += "[vs$i]" }
    $fg = "[0:v]split=$n" + ($splitLabels -join '')
    for ($i = 0; $i -lt $n; $i++) {
        $r = $Rungs[$i]
        # force_original_aspect_ratio=decrease fits inside the box (handles portrait
        # and odd aspect ratios); the second scale forces even dimensions for yuv420p.
        $fg += ";[vs$i]scale=w=$($r.W):h=$($r.H):force_original_aspect_ratio=decrease:flags=lanczos"
        $fg += ",scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[vo$i]"
    }
    $a.Add('-filter_complex'); $a.Add($fg)

    # --- maps: v0,a0, v1,a1, v2,a2 ------------------------------------------
    if ($HasAudio) { $audioSrc = '0:a:0' } else { $audioSrc = '1:a:0' }
    for ($i = 0; $i -lt $n; $i++) {
        $a.Add('-map'); $a.Add("[vo$i]")
        $a.Add('-map'); $a.Add($audioSrc)
    }
    if (-not $HasAudio) { $a.Add('-shortest') }

    # --- video encode --------------------------------------------------------
    $a.Add('-c:v');       $a.Add('h264_nvenc')
    $a.Add('-preset');    $a.Add('p6')
    $a.Add('-tune');      $a.Add('hq')
    $a.Add('-rc:v');      $a.Add('vbr')
    $a.Add('-profile:v'); $a.Add('high')
    $a.Add('-pix_fmt');   $a.Add('yuv420p')

    # Keyframe cadence. sc_threshold is the libx264 spelling (harmlessly ignored by
    # NVENC and it will say so); no-scenecut + forced-idr are the NVENC equivalents
    # that actually pin the GOP so every segment starts on an IDR frame.
    $a.Add('-g');              $a.Add("$Gop")
    $a.Add('-keyint_min');     $a.Add("$Gop")
    $a.Add('-sc_threshold');   $a.Add('0')
    $a.Add('-no-scenecut:v');  $a.Add('1')
    $a.Add('-forced-idr:v');   $a.Add('1')

    for ($i = 0; $i -lt $n; $i++) {
        $r = $Rungs[$i]
        $a.Add("-b:v:$i");       $a.Add("$($r.V)k")
        $a.Add("-maxrate:v:$i"); $a.Add("$($r.Max)k")
        $a.Add("-bufsize:v:$i"); $a.Add("$($r.Buf)k")
    }

    # --- audio encode --------------------------------------------------------
    $a.Add('-c:a'); $a.Add('aac')
    $a.Add('-b:a'); $a.Add($AudioBitrate)
    $a.Add('-ac');  $a.Add('2')
    $a.Add('-ar');  $a.Add('48000')

    # --- HLS packaging -------------------------------------------------------
    $a.Add('-f');                  $a.Add('hls')
    $a.Add('-hls_time');           $a.Add("$SegmentTime")
    $a.Add('-hls_playlist_type');  $a.Add('vod')
    $a.Add('-hls_list_size');      $a.Add('0')
    $a.Add('-hls_flags');          $a.Add('independent_segments')
    $a.Add('-hls_segment_type');   $a.Add('mpegts')
    # Forward slashes are mandatory here: FFmpeg copies the output path separator
    # verbatim into the master playlist, and "stream_0\playlist.m3u8" is not a
    # valid HLS URI - players will fail to resolve it over HTTP.
    $outFwd = $OutFolder.Replace('\', '/').TrimEnd('/')
    $a.Add('-hls_segment_filename'); $a.Add("$outFwd/stream_%v/data%03d.ts")
    $a.Add('-master_pl_name');     $a.Add('master.m3u8')

    $vsm = @()
    for ($i = 0; $i -lt $n; $i++) { $vsm += "v:$i,a:$i" }
    $a.Add('-var_stream_map'); $a.Add($vsm -join ' ')

    $a.Add('-max_muxing_queue_size'); $a.Add('4096')
    $a.Add("$outFwd/stream_%v/playlist.m3u8")

    return $a.ToArray()
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

Write-Host ''
Write-Host '=== HLS VOD batch encoder (NVENC) ===' -ForegroundColor Cyan

$ffmpegPath = Assert-Tool 'ffmpeg'
Assert-Tool 'ffprobe' | Out-Null
Write-Host "ffmpeg  : $ffmpegPath" -ForegroundColor DarkGray

$encoders = & ffmpeg -hide_banner -encoders
if (-not ($encoders | Select-String -SimpleMatch 'h264_nvenc' -Quiet)) {
    throw 'This FFmpeg build has no h264_nvenc encoder. Install a full build (winget install Gyan.FFmpeg).'
}

if (-not $InputDir)  { $InputDir  = Read-Host 'Input folder  (source videos)' }
if (-not $OutputDir) { $OutputDir = Read-Host 'Output folder (HLS packages)' }

$InputDir  = $InputDir.Trim().Trim('"')
$OutputDir = $OutputDir.Trim().Trim('"')

if (-not (Test-Path -LiteralPath $InputDir)) { throw "Input folder does not exist: $InputDir" }
$InputDir = (Resolve-Path -LiteralPath $InputDir).Path

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    Write-Host "Created output folder: $OutputDir" -ForegroundColor DarkGray
}
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

# Match on extension rather than -Include so that folder names containing
# wildcard characters ([ ] etc.) are handled correctly.
$wanted = $Extensions | ForEach-Object { '.' + $_.TrimStart('.').ToLowerInvariant() }
if ($Recurse) {
    $candidates = Get-ChildItem -LiteralPath $InputDir -File -Recurse
} else {
    $candidates = Get-ChildItem -LiteralPath $InputDir -File
}
$files = @($candidates |
    Where-Object { $wanted -contains $_.Extension.ToLowerInvariant() } |
    Sort-Object FullName)

if ($files.Count -eq 0) {
    Write-Warning "No $($wanted -join '/') files found in $InputDir"
    return
}

Write-Host ("Found {0} source file(s) in {1}" -f $files.Count, $InputDir) -ForegroundColor Cyan
Write-Host ''

$nameMap  = New-Object System.Collections.Generic.List[object]
$results  = New-Object System.Collections.Generic.List[object]
$index    = 0
$batchStart = Get-Date

# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------

foreach ($file in $files) {
    $index++
    $baseName = [IO.Path]::GetFileNameWithoutExtension($file.Name)
    if ($SanitizeNames) { $folderName = Get-Slug $baseName } else { $folderName = $baseName }

    $outFolder = Join-Path $OutputDir $folderName
    $master    = Join-Path $outFolder 'master.m3u8'
    $fileStart = Get-Date

    Write-Host ("[{0}/{1}] {2}" -f $index, $files.Count, $file.Name) -ForegroundColor White

    if ((Test-Path -LiteralPath $master) -and (-not $Overwrite)) {
        Write-Host '        already packaged - skipping (use -Overwrite to force)' -ForegroundColor DarkYellow
        $results.Add([pscustomobject]@{
            Source = $file.Name; Output = $folderName; Status = 'skipped'
            Renditions = ''; Gop = ''; Seconds = 0; Error = '' })
        continue
    }

    try {
        $info = Get-MediaInfo -Path $file.FullName

        # Ladder selection
        if ($SkipUpscale) {
            $rungs = @($Ladder | Where-Object { $_.H -le $info.Height })
            if ($rungs.Count -eq 0) { $rungs = @($Ladder[-1]) }
        } else {
            $rungs = $Ladder
        }

        # GOP selection
        if ($AutoGop -and $info.Fps -gt 0) {
            $gop = [int][Math]::Round($info.Fps) * 2
            if ($gop -lt 1) { $gop = $FixedGop }
        } else {
            $gop = $FixedGop
            if ($info.Fps -gt 0) {
                $gopSeconds = $gop / $info.Fps
                $ratio = $SegmentTime / $gopSeconds
                if ([Math]::Abs($ratio - [Math]::Round($ratio)) -gt 0.01) {
                    Write-Host ("        note: {0:N2} fps -> GOP 48 is {1:N2}s, which does not divide into {2}s segments; actual segment lengths will drift. Re-run with -AutoGop for exact {2}s cuts." -f $info.Fps, $gopSeconds, $SegmentTime) -ForegroundColor DarkYellow
                }
            }
        }

        $rungLabel = ($rungs | ForEach-Object { $_.Name }) -join '/'
        $audioNote = ''
        if (-not $info.HasAudio) { $audioNote = ' (no audio track - encoding silent AAC)' }
        Write-Host ("        {0}x{1} @ {2:N2} fps | {3} | GOP {4}{5}" -f `
            $info.Width, $info.Height, $info.Fps, $rungLabel, $gop, $audioNote) -ForegroundColor DarkGray

        # FFmpeg's HLS muxer will not create the %v subfolders itself.
        New-Item -ItemType Directory -Path $outFolder -Force | Out-Null
        for ($i = 0; $i -lt $rungs.Count; $i++) {
            New-Item -ItemType Directory -Path (Join-Path $outFolder "stream_$i") -Force | Out-Null
        }

        $useHw = -not $SoftwareDecode
        $ffArgs = Build-FfmpegArgs -Source $file.FullName -OutFolder $outFolder `
                                   -Rungs $rungs -Gop $gop -HasAudio $info.HasAudio -UseHwDecode $useHw
        $code = Invoke-Ffmpeg -Arguments $ffArgs

        # CUDA decode can fail on exotic codecs / 10-bit sources; retry on CPU decode.
        if ($code -ne 0 -and $useHw) {
            Write-Host '        hardware decode failed - retrying with software decode' -ForegroundColor DarkYellow
            $ffArgs = Build-FfmpegArgs -Source $file.FullName -OutFolder $outFolder `
                                       -Rungs $rungs -Gop $gop -HasAudio $info.HasAudio -UseHwDecode $false
            $code = Invoke-Ffmpeg -Arguments $ffArgs
        }

        $elapsed = ((Get-Date) - $fileStart).TotalSeconds

        if ($code -ne 0 -or -not (Test-Path -LiteralPath $master)) {
            throw "ffmpeg exited with code $code"
        }

        $segCount = @(Get-ChildItem -LiteralPath $outFolder -Recurse -Filter '*.ts' -File).Count
        $sizeMb   = [math]::Round(((Get-ChildItem -LiteralPath $outFolder -Recurse -File |
                     Measure-Object -Property Length -Sum).Sum / 1MB), 1)
        $speed = ''
        if ($info.Duration -gt 0 -and $elapsed -gt 0) {
            $speed = ' | {0:N1}x realtime' -f ($info.Duration / $elapsed)
        }

        Write-Host ("        done in {0:N1}s | {1} segments | {2} MB{3}" -f $elapsed, $segCount, $sizeMb, $speed) -ForegroundColor Green

        $results.Add([pscustomobject]@{
            Source = $file.Name; Output = $folderName; Status = 'ok'
            Renditions = $rungLabel; Gop = $gop
            Seconds = [math]::Round($elapsed, 1); Error = '' })
        $nameMap.Add([pscustomobject]@{ Original = $file.Name; Folder = $folderName })
    }
    catch {
        $msg = $_.Exception.Message
        Write-Host ("        FAILED: {0}" -f $msg) -ForegroundColor Red
        $results.Add([pscustomobject]@{
            Source = $file.Name; Output = $folderName; Status = 'failed'
            Renditions = ''; Gop = ''
            Seconds = [math]::Round(((Get-Date) - $fileStart).TotalSeconds, 1); Error = $msg })
    }

    Write-Host ''
}

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------

$ok      = @($results | Where-Object { $_.Status -eq 'ok' }).Count
$skipped = @($results | Where-Object { $_.Status -eq 'skipped' }).Count
$failed  = @($results | Where-Object { $_.Status -eq 'failed' }).Count
$total   = ((Get-Date) - $batchStart).TotalMinutes

Write-Host '=== Summary ===' -ForegroundColor Cyan
$results | Format-Table Source, Status, Renditions, Gop, Seconds -AutoSize
Write-Host ("{0} encoded, {1} skipped, {2} failed in {3:N1} min" -f $ok, $skipped, $failed, $total) -ForegroundColor Cyan

$reportPath = Join-Path $OutputDir 'encode-report.csv'
$results | Export-Csv -LiteralPath $reportPath -NoTypeInformation -Encoding UTF8
Write-Host "Report: $reportPath" -ForegroundColor DarkGray

if ($SanitizeNames -and $nameMap.Count -gt 0) {
    $mapPath = Join-Path $OutputDir 'name-map.csv'
    $nameMap | Export-Csv -LiteralPath $mapPath -NoTypeInformation -Encoding UTF8
    Write-Host "Name map: $mapPath" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host 'Upload to R2, then point your player at <public-base>/<VideoName>/master.m3u8' -ForegroundColor DarkGray
Write-Host 'Set Content-Type: application/vnd.apple.mpegurl on .m3u8 and video/mp2t on .ts,' -ForegroundColor DarkGray
Write-Host 'and enable CORS on the bucket or hls.js playback will fail.' -ForegroundColor DarkGray

if ($failed -gt 0) { exit 1 }

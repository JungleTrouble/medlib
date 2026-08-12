<#
.SYNOPSIS
    Local HLS packaging/encoding pipeline with direct upload to Cloudflare R2.

.DESCRIPTION
    For each source video:
      1. Creates an output folder mirroring the source's relative path
      2. Produces an HLS bundle (master.m3u8 + stream_N/segment_######.ts)
      3. Uploads that bundle to R2 over the S3-compatible API
      4. Verifies the upload, logs status, retries on failure

    Runs incrementally: already-packaged and already-uploaded videos are skipped,
    so you can add more source files later and re-run to upload only the new ones.

    MODES
      Package   Stream-copy (-c:v copy). No re-encode, no quality loss, ~1.15x
                source size, thousands of x realtime. One rendition.
      Transcode Full 3-rung NVENC ABR ladder (1080p/720p/480p) at fixed bitrates.
      Auto      Per-file: Package when the source is H.264 and under
                -TranscodeAboveKbps; Transcode otherwise. (default)

.PARAMETER Mode
    Package | Transcode | Auto. Default Auto.

.PARAMETER SkipUpload
    Encode/package only. Nothing is sent to R2.

.PARAMETER UploadOnly
    Skip encoding; upload existing bundles in -OutputDir.

.PARAMETER DeleteLocalAfterUpload
    Remove each bundle from disk once its upload is verified. Use when the full
    output set would not fit on the local drive.

.PARAMETER DryRun
    Print what would happen. No encoding, no uploads.

.NOTES
    Credentials are read from environment variables and are never written to disk,
    logged, or passed on the command line:
        R2_S3_ENDPOINT        https://<accountid>.r2.cloudflarestorage.com
        R2_ACCESS_KEY_ID
        R2_SECRET_ACCESS_KEY
    R2's region is always "auto".
#>

[CmdletBinding()]
param(
    [string]   $InputDir,
    [string]   $OutputDir,
    [string]   $Bucket,
    [string]   $Prefix = '',
    [ValidateSet('Package','Transcode','Auto')]
    [string]   $Mode = 'Auto',
    [string[]] $Extensions = @('mp4','mov','m4v','mkv'),
    [switch]   $NoRecurse,
    [int]      $SegmentTime = 0,
    [int]      $TranscodeAboveKbps = 2500,
    [switch]   $SkipUpload,
    [switch]   $UploadOnly,
    [switch]   $DeleteLocalAfterUpload,
    [switch]   $Overwrite,
    [switch]   $DryRun,
    [int]      $Retries = 3
)

$ErrorActionPreference = 'Stop'

$Ladder = @(
    [pscustomobject]@{ Name='1080p'; W=1920; H=1080; V=5000; Max=5350; Buf=10000 }
    [pscustomobject]@{ Name='720p';  W=1280; H=720;  V=2800; Max=2996; Buf=5600  }
    [pscustomobject]@{ Name='480p';  W=854;  H=480;  V=1400; Max=1498; Buf=2800  }
)

# ============================================================================
# Helpers
# ============================================================================

function Write-Step { param([string]$Text,[string]$Color='Gray') Write-Host "        $Text" -ForegroundColor $Color }

function Get-MediaInfo {
    param([string]$Path)
    $ErrorActionPreference = 'Continue'   # function-scoped; reverts on return

    $vo = @(& ffprobe -v error -select_streams v:0 `
            -show_entries stream=codec_name,width,height,avg_frame_rate `
            -of default=nw=1:nk=1 -- $Path)
    if ($LASTEXITCODE -ne 0 -or $vo.Count -lt 4) {
        throw 'ffprobe found no readable video stream'
    }

    $fps = 0.0
    if ("$($vo[3])" -match '^(\d+)/(\d+)$' -and [double]$Matches[2] -gt 0) {
        $fps = [double]$Matches[1] / [double]$Matches[2]
    }

    # @() forces array semantics before indexing. Without it, a single-line ffprobe
    # result is a plain string and [0] yields its first CHARACTER - which silently
    # turns a duration of "429.75" into 4 seconds and a codec of "aac" into "a".
    $ao = @(& ffprobe -v error -select_streams a:0 -show_entries stream=codec_name `
            -of default=nw=1:nk=1 -- $Path)
    $acodec = ''
    if ($ao.Count -gt 0) { $acodec = "$($ao[0])".Trim() }

    $dur = 0.0
    $do_ = @(& ffprobe -v error -show_entries format=duration -of csv=p=0 -- $Path)
    if ($do_.Count -gt 0) {
        [double]::TryParse("$($do_[0])".Trim(), [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$dur) | Out-Null
    }

    $bytes = (Get-Item -LiteralPath $Path).Length
    $kbps = 0
    if ($dur -gt 0) { $kbps = [int](($bytes * 8 / 1000) / $dur) }

    return [pscustomobject]@{
        VCodec   = "$($vo[0])".Trim()
        Width    = [int]$vo[1]
        Height   = [int]$vo[2]
        Fps      = $fps
        ACodec   = $acodec
        HasAudio = -not [string]::IsNullOrWhiteSpace($acodec)
        Duration = $dur
        Kbps     = $kbps
    }
}

function Invoke-Native {
    <# Runs a native exe, returns exit code. Keeps stderr from becoming terminating. #>
    param([string]$Exe, [string[]]$Arguments)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments; return $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
}

function Build-EncodeArgs {
    param(
        [string]$Source, [string]$OutFolder, [object]$Info,
        [string]$FileMode, [int]$SegTime
    )

    $a = New-Object System.Collections.Generic.List[string]
    $a.Add('-hide_banner'); $a.Add('-y'); $a.Add('-loglevel'); $a.Add('warning'); $a.Add('-stats')

    # Forward slashes are mandatory: FFmpeg copies the separator verbatim into the
    # master playlist, and "stream_0\playlist.m3u8" is not a valid HLS URI.
    $o = ($OutFolder -replace '\\','/').TrimEnd('/')

    if ($FileMode -eq 'Package') {
        # ---------------- stream copy: no re-encode ----------------
        $a.Add('-i'); $a.Add($Source)
        $a.Add('-map'); $a.Add('0:v:0')
        if ($Info.HasAudio) { $a.Add('-map'); $a.Add('0:a:0') }
        $a.Add('-c:v'); $a.Add('copy')
        if ($Info.HasAudio) {
            if ($Info.ACodec -eq 'aac') {
                $a.Add('-c:a'); $a.Add('copy')
            } else {
                # Only the audio is re-encoded; video still passes through untouched.
                $a.Add('-c:a'); $a.Add('aac'); $a.Add('-b:a'); $a.Add('128k')
                $a.Add('-ac'); $a.Add('2'); $a.Add('-ar'); $a.Add('48000')
            }
        }
        if ($Info.HasAudio) { $vsm = 'v:0,a:0' } else { $vsm = 'v:0' }
        $nStreams = 1
    }
    else {
        # ---------------- full NVENC ABR ladder ----------------
        $rungs = $Ladder
        $n = $rungs.Count
        $nStreams = $n

        $a.Add('-hwaccel'); $a.Add('cuda')
        $a.Add('-i'); $a.Add($Source)

        # A missing audio track breaks -var_stream_map; feed silence instead.
        if (-not $Info.HasAudio) {
            $a.Add('-f'); $a.Add('lavfi')
            $a.Add('-i'); $a.Add('anullsrc=channel_layout=stereo:sample_rate=48000')
        }

        $lbl = @(); for ($i=0; $i -lt $n; $i++) { $lbl += "[vs$i]" }
        $fg = "[0:v]split=$n" + ($lbl -join '')
        for ($i=0; $i -lt $n; $i++) {
            $r = $rungs[$i]
            $fg += ";[vs$i]scale=w=$($r.W):h=$($r.H):force_original_aspect_ratio=decrease:flags=lanczos"
            $fg += ",scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[vo$i]"
        }
        $a.Add('-filter_complex'); $a.Add($fg)

        if ($Info.HasAudio) { $asrc = '0:a:0' } else { $asrc = '1:a:0' }
        for ($i=0; $i -lt $n; $i++) {
            $a.Add('-map'); $a.Add("[vo$i]")
            $a.Add('-map'); $a.Add($asrc)
        }
        if (-not $Info.HasAudio) { $a.Add('-shortest') }

        $a.Add('-c:v'); $a.Add('h264_nvenc')
        $a.Add('-preset'); $a.Add('p6')
        $a.Add('-tune'); $a.Add('hq')
        $a.Add('-rc:v'); $a.Add('vbr')
        $a.Add('-profile:v'); $a.Add('high')
        $a.Add('-pix_fmt'); $a.Add('yuv420p')

        # sc_threshold is the libx264 spelling and NVENC ignores it (it will say so
        # on stderr). no-scenecut/forced-idr are the NVENC equivalents that actually
        # pin the GOP so every segment starts on an IDR frame.
        $a.Add('-g'); $a.Add('48')
        $a.Add('-keyint_min'); $a.Add('48')
        $a.Add('-sc_threshold'); $a.Add('0')
        $a.Add('-no-scenecut:v'); $a.Add('1')
        $a.Add('-forced-idr:v'); $a.Add('1')

        for ($i=0; $i -lt $n; $i++) {
            $r = $rungs[$i]
            $a.Add("-b:v:$i");       $a.Add("$($r.V)k")
            $a.Add("-maxrate:v:$i"); $a.Add("$($r.Max)k")
            $a.Add("-bufsize:v:$i"); $a.Add("$($r.Buf)k")
        }

        if ($Info.HasAudio -and $Info.ACodec -eq 'aac') {
            $a.Add('-c:a'); $a.Add('copy')
        } else {
            $a.Add('-c:a'); $a.Add('aac'); $a.Add('-b:a'); $a.Add('128k')
            $a.Add('-ac'); $a.Add('2'); $a.Add('-ar'); $a.Add('48000')
        }

        $vsmParts = @(); for ($i=0; $i -lt $n; $i++) { $vsmParts += "v:$i,a:$i" }
        $vsm = $vsmParts -join ' '
    }

    $a.Add('-f'); $a.Add('hls')
    $a.Add('-hls_time'); $a.Add("$SegTime")
    $a.Add('-hls_playlist_type'); $a.Add('vod')
    $a.Add('-hls_list_size'); $a.Add('0')
    $a.Add('-hls_flags'); $a.Add('independent_segments')
    $a.Add('-hls_segment_type'); $a.Add('mpegts')
    $a.Add('-hls_segment_filename'); $a.Add("$o/stream_%v/segment_%06d.ts")
    $a.Add('-master_pl_name'); $a.Add('master.m3u8')
    $a.Add('-var_stream_map'); $a.Add($vsm)
    $a.Add('-max_muxing_queue_size'); $a.Add('4096')
    $a.Add("$o/stream_%v/playlist.m3u8")

    return @{ Args = $a.ToArray(); StreamCount = $nStreams }
}

# ---------------------------------------------------------------------------
# R2 upload
# ---------------------------------------------------------------------------

function Initialize-R2Env {
    <#
        Maps R2_* variables onto the RCLONE_S3_* variables rclone reads natively.
        Passing them through the environment (never argv) keeps secrets out of the
        process list, shell history, and this script's logs.
    #>
    $env:RCLONE_S3_PROVIDER          = 'Cloudflare'
    $env:RCLONE_S3_ENDPOINT          = $env:R2_S3_ENDPOINT
    $env:RCLONE_S3_ACCESS_KEY_ID     = $env:R2_ACCESS_KEY_ID
    $env:RCLONE_S3_SECRET_ACCESS_KEY = $env:R2_SECRET_ACCESS_KEY
    $env:RCLONE_S3_REGION            = 'auto'
    $env:RCLONE_S3_FORCE_PATH_STYLE  = 'true'
    $env:RCLONE_S3_NO_CHECK_BUCKET   = 'true'   # do not attempt CreateBucket
}

function Invoke-R2Upload {
    <#
        Two passes so each object gets the right Content-Type. This matters:
        ".ts" is ambiguous (TypeScript) and guessing wrong makes players refuse
        to load segments.
    #>
    param([string]$LocalFolder, [string]$RemotePath)

    $passes = @(
        @{ Include = '*.ts';   Type = 'video/mp2t' },
        @{ Include = '*.m3u8'; Type = 'application/vnd.apple.mpegurl' }
    )

    foreach ($p in $passes) {
        $args = @(
            'copy', $LocalFolder, ":s3:$RemotePath",
            '--include', $p.Include,
            '--header-upload', "Content-Type: $($p.Type)",
            '--no-progress',
            '--retries', '5',
            '--low-level-retries', '10',
            '--transfers', '8',
            '--checkers', '16',
            '--s3-chunk-size', '32M'
        )
        $code = Invoke-Native -Exe 'rclone' -Arguments $args
        if ($code -ne 0) { return $code }
    }
    return 0
}

function Test-R2Upload {
    <#
        Verification is two-layer: rclone check compares every local file against
        the remote by hash (R2 returns MD5 ETags for single-part uploads), and a
        file-count comparison catches anything check might have skipped.
    #>
    param([string]$LocalFolder, [string]$RemotePath)

    $localCount = @(Get-ChildItem -LiteralPath $LocalFolder -Recurse -File).Count

    $checkCode = Invoke-Native -Exe 'rclone' -Arguments @(
        'check', $LocalFolder, ":s3:$RemotePath", '--one-way', '--no-progress'
    )

    $remoteList = & rclone lsf ":s3:$RemotePath" --recursive --files-only 2>$null
    $remoteCount = @($remoteList | Where-Object { $_ }).Count

    return [pscustomobject]@{
        Ok          = ($checkCode -eq 0 -and $remoteCount -ge $localCount)
        LocalCount  = $localCount
        RemoteCount = $remoteCount
        CheckCode   = $checkCode
    }
}

# ============================================================================
# Preflight
# ============================================================================

Write-Host ''
Write-Host '=== HLS pipeline -> Cloudflare R2 ===' -ForegroundColor Cyan
Write-Host "Host OS : Windows 11 / PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor DarkGray

foreach ($t in @('ffmpeg','ffprobe')) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) {
        throw "$t not found on PATH. Install with:  winget install Gyan.FFmpeg"
    }
}

$needUpload = (-not $SkipUpload)
if ($needUpload) {
    if (-not (Get-Command 'rclone' -ErrorAction SilentlyContinue)) {
        Write-Host ''
        Write-Host 'rclone is not installed. Install it with:' -ForegroundColor Yellow
        Write-Host '    winget install Rclone.Rclone' -ForegroundColor White
        Write-Host 'then open a new shell and re-run. Or pass -SkipUpload to encode only.' -ForegroundColor Yellow
        throw 'rclone missing'
    }

    $missing = @()
    foreach ($n in @('R2_S3_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY')) {
        if (-not [Environment]::GetEnvironmentVariable($n)) { $missing += $n }
    }
    if ($missing.Count -gt 0) {
        Write-Host ''
        Write-Host 'Missing required environment variables:' -ForegroundColor Yellow
        $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor White }
        Write-Host ''
        Write-Host 'Set them for this session (values are not stored by this script):' -ForegroundColor Yellow
        Write-Host '    $env:R2_S3_ENDPOINT     = "https://<accountid>.r2.cloudflarestorage.com"' -ForegroundColor White
        Write-Host '    $env:R2_ACCESS_KEY_ID   = "<access key id>"' -ForegroundColor White
        Write-Host '    $env:R2_SECRET_ACCESS_KEY = "<secret access key>"' -ForegroundColor White
        throw 'R2 credentials not configured'
    }
    Initialize-R2Env
}

if (-not $InputDir)  { $InputDir  = Read-Host 'Input directory  (source videos)' }
if (-not $OutputDir) { $OutputDir = Read-Host 'Output directory (HLS bundles)' }
if ($needUpload -and -not $Bucket) { $Bucket = Read-Host 'R2 bucket name' }

$InputDir  = $InputDir.Trim().Trim('"')
$OutputDir = $OutputDir.Trim().Trim('"')

if (-not (Test-Path -LiteralPath $InputDir)) { throw "Input directory not found: $InputDir" }
$InputDir = (Resolve-Path -LiteralPath $InputDir).Path

if (-not (Test-Path -LiteralPath $OutputDir)) {
    if (-not $DryRun) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }
}
if (Test-Path -LiteralPath $OutputDir) { $OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path }

if ($needUpload) {
    Write-Host "R2      : bucket '$Bucket' via $($env:R2_S3_ENDPOINT)" -ForegroundColor DarkGray
    $probe = Invoke-Native -Exe 'rclone' -Arguments @('lsd', ":s3:$Bucket", '--max-depth','1','--no-progress')
    if ($probe -ne 0) { throw "Cannot reach bucket '$Bucket'. Check the endpoint, keys, and bucket name." }
    Write-Host 'R2      : connection OK' -ForegroundColor DarkGray
}

# Match on extension so folder names containing [ ] are handled, and skip macOS
# AppleDouble sidecars (._name.mp4) which are metadata stubs, not media.
$wanted = $Extensions | ForEach-Object { '.' + $_.TrimStart('.').ToLowerInvariant() }
if ($NoRecurse) { $cand = Get-ChildItem -LiteralPath $InputDir -File }
else            { $cand = Get-ChildItem -LiteralPath $InputDir -File -Recurse }

$files = @($cand |
    Where-Object { $wanted -contains $_.Extension.ToLowerInvariant() } |
    Where-Object { -not $_.Name.StartsWith('._') } |
    Sort-Object FullName)

if ($files.Count -eq 0) { Write-Warning "No matching video files in $InputDir"; return }

$srcGb = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1GB), 1)
Write-Host "Sources : $($files.Count) files, $srcGb GB" -ForegroundColor Cyan
Write-Host "Mode    : $Mode" -ForegroundColor Cyan
if ($DryRun) { Write-Host 'DRY RUN : nothing will be encoded or uploaded' -ForegroundColor Yellow }
Write-Host ''

$results = New-Object System.Collections.Generic.List[object]
$i = 0
$batchStart = Get-Date

# ============================================================================
# Main loop
# ============================================================================

foreach ($f in $files) {
    $i++

    # Mirror the source's relative path. Naming folders by basename alone would
    # collide: 432 basenames repeat across this library, one of them 104 times.
    $rel = $f.FullName.Substring($InputDir.Length).TrimStart('\')
    $relDir = [IO.Path]::GetDirectoryName($rel)
    $base = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    if ($relDir) { $relKey = Join-Path $relDir $base } else { $relKey = $base }

    $outFolder = Join-Path $OutputDir $relKey
    $master    = Join-Path $outFolder 'master.m3u8'
    $remoteRel = ($relKey -replace '\\','/')
    if ($Bucket) {
        if ($Prefix) { $remotePath = "$Bucket/$($Prefix.Trim('/'))/$remoteRel" }
        else         { $remotePath = "$Bucket/$remoteRel" }
    } else {
        $remotePath = ''   # -SkipUpload: no bucket was requested
    }

    Write-Host ("[{0}/{1}] {2}" -f $i, $files.Count, $rel) -ForegroundColor White

    $row = [pscustomobject]@{
        Source=$rel; Mode=''; Status=''; Segments=0; SizeMB=0
        Uploaded=$false; Seconds=0; Error='' }
    $t0 = Get-Date

    try {
        $alreadyPackaged = Test-Path -LiteralPath $master

        # -------- encode / package --------
        if ($UploadOnly) {
            if (-not $alreadyPackaged) { Write-Step 'no local bundle; skipping' DarkYellow
                $row.Status='skipped'; $results.Add($row); Write-Host ''; continue }
            $row.Mode = 'existing'
        }
        elseif ($alreadyPackaged -and -not $Overwrite) {
            Write-Step 'already packaged - skipping encode' DarkYellow
            $row.Mode = 'existing'
        }
        else {
            $info = Get-MediaInfo -Path $f.FullName

            switch ($Mode) {
                'Package'   { $fileMode = 'Package' }
                'Transcode' { $fileMode = 'Transcode' }
                default {
                    if ($info.VCodec -eq 'h264' -and $info.Kbps -le $TranscodeAboveKbps) {
                        $fileMode = 'Package'
                    } else { $fileMode = 'Transcode' }
                }
            }
            $row.Mode = $fileMode

            if ($SegmentTime -gt 0) { $segT = $SegmentTime }
            elseif ($fileMode -eq 'Package') { $segT = 6 } else { $segT = 4 }

            Write-Step ("{0}x{1} {2} @ {3} kbps -> {4} (hls_time {5})" -f `
                $info.Width, $info.Height, $info.VCodec, $info.Kbps, $fileMode, $segT) DarkGray

            if ($DryRun) {
                if ($remotePath) { Write-Step "would upload to s3://$remotePath" DarkGray }
                else             { Write-Step 'encode only (no upload configured)' DarkGray }
                $row.Status='dryrun'; $results.Add($row); Write-Host ''; continue
            }

            $built = Build-EncodeArgs -Source $f.FullName -OutFolder $outFolder `
                                      -Info $info -FileMode $fileMode -SegTime $segT

            New-Item -ItemType Directory -Path $outFolder -Force | Out-Null
            for ($s=0; $s -lt $built.StreamCount; $s++) {
                New-Item -ItemType Directory -Path (Join-Path $outFolder "stream_$s") -Force | Out-Null
            }

            $code = Invoke-Native -Exe 'ffmpeg' -Arguments $built.Args

            # CUDA decode can fail on unusual sources; retry once on CPU decode.
            if ($code -ne 0 -and $fileMode -eq 'Transcode') {
                Write-Step 'retrying with software decode' DarkYellow
                $sw = @($built.Args | Where-Object { $_ -ne '-hwaccel' -and $_ -ne 'cuda' })
                $code = Invoke-Native -Exe 'ffmpeg' -Arguments $sw
            }
            if ($code -ne 0 -or -not (Test-Path -LiteralPath $master)) {
                throw "ffmpeg exited $code"
            }
        }

        $row.Segments = @(Get-ChildItem -LiteralPath $outFolder -Recurse -Filter '*.ts' -File).Count
        $row.SizeMB   = [math]::Round(((Get-ChildItem -LiteralPath $outFolder -Recurse -File |
                          Measure-Object Length -Sum).Sum / 1MB), 1)

        # -------- upload --------
        if ($SkipUpload) {
            $row.Status = 'encoded'
        }
        else {
            $attempt = 0; $ok = $false; $lastErr = ''
            while ($attempt -lt $Retries -and -not $ok) {
                $attempt++
                $uc = Invoke-R2Upload -LocalFolder $outFolder -RemotePath $remotePath
                if ($uc -eq 0) {
                    $v = Test-R2Upload -LocalFolder $outFolder -RemotePath $remotePath
                    if ($v.Ok) {
                        $ok = $true
                        Write-Step ("uploaded + verified: {0}/{1} objects" -f $v.RemoteCount, $v.LocalCount) Green
                    } else {
                        $lastErr = "verify failed (local $($v.LocalCount) / remote $($v.RemoteCount), check=$($v.CheckCode))"
                    }
                } else {
                    $lastErr = "rclone exited $uc"
                }
                if (-not $ok -and $attempt -lt $Retries) {
                    $backoff = [math]::Pow(2, $attempt)
                    Write-Step "$lastErr - retry $attempt/$Retries in ${backoff}s" DarkYellow
                    Start-Sleep -Seconds $backoff
                }
            }

            if (-not $ok) { throw "upload failed after $Retries attempts: $lastErr" }

            $row.Uploaded = $true
            $row.Status = 'done'

            if ($DeleteLocalAfterUpload) {
                Remove-Item -LiteralPath $outFolder -Recurse -Force
                Write-Step 'local bundle removed' DarkGray
            }
        }

        $row.Seconds = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
        Write-Step ("{0} | {1} segments | {2} MB | {3}s" -f $row.Status, $row.Segments, $row.SizeMB, $row.Seconds) Green
    }
    catch {
        $row.Status  = 'failed'
        $row.Error   = $_.Exception.Message
        $row.Seconds = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
        Write-Step "FAILED: $($row.Error)" Red
    }

    $results.Add($row)
    Write-Host ''
}

# ============================================================================
# Summary
# ============================================================================

$done   = @($results | Where-Object { $_.Status -eq 'done' }).Count
$enc    = @($results | Where-Object { $_.Status -eq 'encoded' }).Count
$skip   = @($results | Where-Object { $_.Status -eq 'skipped' }).Count
$fail   = @($results | Where-Object { $_.Status -eq 'failed' }).Count
$mins   = ((Get-Date) - $batchStart).TotalMinutes

Write-Host '=== Summary ===' -ForegroundColor Cyan
Write-Host ("{0} uploaded, {1} encoded-only, {2} skipped, {3} failed in {4:N1} min" -f `
    $done, $enc, $skip, $fail, $mins) -ForegroundColor Cyan

$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
$report = Join-Path $OutputDir "r2-report-$stamp.csv"
$results | Export-Csv -LiteralPath $report -NoTypeInformation -Encoding UTF8
Write-Host "Report: $report" -ForegroundColor DarkGray

if ($fail -gt 0) {
    Write-Host ''
    Write-Host 'Failed items (re-run the same command to retry only these):' -ForegroundColor Yellow
    $results | Where-Object { $_.Status -eq 'failed' } |
        Select-Object Source, Error | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
    exit 1
}

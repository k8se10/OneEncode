# Builds a standalone, click-and-run Windows release package: oneencode.exe
# plus every runtime dependency it needs (Node itself via SEA, the built
# dashboard, MediaMTX, and ffmpeg) so the target machine (e.g. the streaming
# PC, per CLAUDE.md's dual-PC target) needs nothing pre-installed.
#
# Licensing, per CLAUDE.md §6 (updated 2026-08-14 to bundle ffmpeg too, at
# the user's explicit direction -- "click and run" over a manual-install
# step):
#   - MediaMTX (MIT) is bundled -- permissive, no redistribution concerns.
#   - ffmpeg is bundled too. A GPL build (`--enable-gpl`, needed for
#     libx264/libx265 -- this project's universal CPU fallback encoder) is
#     legally redistributable as long as GPL's own terms are met: the
#     license text is included and the corresponding source stays publicly
#     available. `ffmpeg-LICENSE.txt` (written into the release folder
#     below) covers both -- FFmpeg's own source is always public upstream,
#     and Windows builds sourced from gyan.dev document their exact build
#     configuration publicly too, so no source needs to be re-bundled here.
#
# Run from the project root: pwsh -File scripts/package-win.ps1
# Optional: -FfmpegPath <path to a real ffmpeg.exe> to override auto-detection.
param(
    [string]$FfmpegPath = ""
)
$ErrorActionPreference = "Stop"

Write-Host "1/8 Building backend (tsc)..."
npm run build

Write-Host "2/8 Building web dashboard..."
npm run web:build

Write-Host "3/8 Bundling to a single CJS file (esbuild) -- SEA needs one entry file, and this project is ESM..."
New-Item -ItemType Directory -Force -Path dist-pkg | Out-Null
npx esbuild src/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist-pkg/bundle.cjs

Write-Host "4/8 Generating the SEA blob..."
@'
{
  "main": "bundle.cjs",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
'@ | Set-Content -Path dist-pkg/sea-config.json
Push-Location dist-pkg
node --experimental-sea-config sea-config.json
Pop-Location

Write-Host "5/8 Copying node.exe and stripping its signature (required before postject can inject into it)..."
$releaseDir = "dist-release/OneEncode"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$exePath = "$releaseDir/oneencode.exe"
$nodeExe = (Get-Command node).Source
Copy-Item -Path $nodeExe -Destination $exePath -Force
$signtool = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\" } | Select-Object -First 1
if ($signtool) {
    & $signtool.FullName remove /s $exePath
} else {
    Write-Warning "signtool.exe not found (Windows SDK) -- skipping signature removal. If the resulting exe won't launch, install the Windows SDK (or Visual Studio's 'Windows SDK Signing Tools' component) and re-run."
}

Write-Host "6/8 Injecting the SEA blob into oneencode.exe..."
npx postject $exePath NODE_SEA_BLOB dist-pkg/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

Write-Host "7/8 Locating and bundling ffmpeg..."
if (-not $FfmpegPath) {
    # Chocolatey installs ffmpeg.exe as a tiny .NET shim on PATH -- the real
    # ~100MB binary lives under its lib folder. Prefer that; only fall back
    # to whatever `ffmpeg` resolves to on PATH if it's actually a real
    # binary (size-sanity-checked, since a shim is a few hundred KB).
    $chocoFfmpeg = Get-ChildItem -Path "C:\ProgramData\chocolatey\lib\ffmpeg\tools" -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($chocoFfmpeg) {
        $FfmpegPath = $chocoFfmpeg.FullName
    } else {
        $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
        if ($cmd -and (Get-Item $cmd.Source).Length -gt 10MB) {
            $FfmpegPath = $cmd.Source
        }
    }
}
if (-not $FfmpegPath -or -not (Test-Path $FfmpegPath)) {
    throw "Could not locate a real ffmpeg.exe to bundle (only found a small PATH shim, or nothing at all). Pass -FfmpegPath '<full path to a real ffmpeg.exe>' explicitly."
}
$ffmpegVersion = & $FfmpegPath -version 2>&1 | Select-Object -First 1
Write-Host "  Bundling: $FfmpegPath"
Write-Host "  $ffmpegVersion"
Copy-Item -Path $FfmpegPath -Destination "$releaseDir/ffmpeg.exe" -Force
# ffmpeg.exe must sit in the SAME folder as oneencode.exe -- src/index.ts
# prepends path.dirname(process.execPath) to PATH at startup specifically
# so Node's spawn() (which, unlike CreateProcess, does not fall back to the
# launching process's own directory) can find a co-located ffmpeg.exe. A
# tools/ffmpeg/ subfolder would NOT be found.
@"
FFmpeg -- bundled with this OneEncode release
==============================================

This build: $ffmpegVersion
Built with: --enable-gpl (plus libx264/libx265 among other GPL-triggering
components) -- see the full configure line via `ffmpeg.exe -version` in
this same folder.

License: GNU General Public License, version 3 (GPLv3), because this
specific build was compiled with --enable-gpl. Full license text:
https://www.gnu.org/licenses/gpl-3.0.txt

Source availability (a GPL requirement): FFmpeg's own complete source is
always publicly available at https://ffmpeg.org/download.html. Windows
builds matching this configuration are published, with their exact build
scripts, by gyan.dev: https://www.gyan.dev/ffmpeg/builds/ -- no source is
re-bundled in this release folder since it's already public at both of
those locations under the same license.

Copyright (c) 2000-2025 the FFmpeg developers.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
This bundling is not an endorsement by or affiliation with the FFmpeg
project.
"@ | Set-Content -Path "$releaseDir/ffmpeg-LICENSE.txt"

Write-Host "8/8 Assembling the rest of the release folder ($releaseDir)..."
if (-not (Test-Path "tools/mediamtx/mediamtx.exe")) {
    throw "tools/mediamtx/mediamtx.exe not found -- download it first (see docs/GETTING_STARTED.md) before packaging a release; it gets bundled into $releaseDir/tools/mediamtx/."
}
New-Item -ItemType Directory -Force -Path "$releaseDir/tools/mediamtx" | Out-Null
Copy-Item -Path "tools/mediamtx/mediamtx.exe" -Destination "$releaseDir/tools/mediamtx/mediamtx.exe" -Force
Copy-Item -Path "tools/mediamtx/LICENSE" -Destination "$releaseDir/tools/mediamtx/LICENSE" -Force

New-Item -ItemType Directory -Force -Path "$releaseDir/config" | Out-Null
Copy-Item -Path "config/legs.example.yaml" -Destination "$releaseDir/config/legs.example.yaml" -Force
Copy-Item -Path "config/legs.default.yaml" -Destination "$releaseDir/config/legs.default.yaml" -Force
Copy-Item -Path "config/secrets.local.example.yaml" -Destination "$releaseDir/config/secrets.local.example.yaml" -Force
Copy-Item -Path "config/platformProfiles.yaml" -Destination "$releaseDir/config/platformProfiles.yaml" -Force
Copy-Item -Path "config/mediamtx.yml" -Destination "$releaseDir/config/mediamtx.yml" -Force

Copy-Item -Path "web/dist" -Destination "$releaseDir/web/dist" -Recurse -Force
Copy-Item -Path "LICENSE" -Destination "$releaseDir/LICENSE" -Force

@'
OneEncode -- standalone Windows release
========================================

Fully self-contained -- click oneencode.exe and go. Bundled: oneencode.exe
(no separate Node.js install needed), the dashboard's built frontend
(web/dist/), MediaMTX (tools/mediamtx/, MIT-licensed, see the LICENSE file
alongside it), and ffmpeg (ffmpeg.exe, GPLv3-licensed, see
ffmpeg-LICENSE.txt in this folder for the license and source-availability
notice).

To run:
  1. Just run oneencode.exe -- no config needed first. If config/legs.local.yaml
     doesn't exist, a safe default (one local-file leg, no real credentials
     needed) is generated automatically so it starts and proves the pipeline
     works; the dashboard shows a banner when you're running on it.
  2. The dashboard opens automatically in your default browser, already
     logged in.
  3. To add real platform destinations instead of the default: copy
     config/legs.example.yaml -> config/legs.local.yaml and
     config/secrets.local.example.yaml -> config/secrets.local.yaml, fill in
     your real renditions/legs/destination URLs (or use the dashboard's
     Configure tab instead of hand-editing). No restart needed -- changes
     apply automatically within about a second (hot-reload).

Run it from a terminal IN THIS FOLDER if you want to see the console output
(everything resolves relative to the current working directory, not the
exe's own location) -- double-clicking also works, console output still
gets mirrored to logs/oneencode-console-<date>.log either way.

Full setup walkthrough: docs/GETTING_STARTED.md in the source repository
(https://github.com/k8se10/OneEncode).
'@ | Set-Content -Path "$releaseDir/README.txt"

Write-Host ""
Write-Host "Done: $releaseDir/ -- fully self-contained, nothing else to install."
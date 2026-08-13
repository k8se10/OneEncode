# Builds a standalone Windows executable (oneencode.exe) using Node's
# built-in Single Executable Application (SEA) feature, so OneEncode can run
# on a machine (e.g. the streaming PC, per CLAUDE.md's dual-PC target) with
# no Node.js install required. ffmpeg and tools/mediamtx/ are still separate,
# required external dependencies -- never bundled, per CLAUDE.md §6.
#
# Run from the project root: pwsh -File scripts/package-win.ps1
$ErrorActionPreference = "Stop"

Write-Host "1/6 Building backend (tsc)..."
npm run build

Write-Host "2/6 Building web dashboard..."
npm run web:build

Write-Host "3/6 Bundling to a single CJS file (esbuild) -- SEA needs one entry file, and this project is ESM..."
New-Item -ItemType Directory -Force -Path dist-pkg | Out-Null
npx esbuild src/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist-pkg/bundle.cjs

Write-Host "4/6 Generating the SEA blob..."
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

Write-Host "5/6 Copying node.exe and stripping its signature (required before postject can inject into it)..."
$nodeExe = (Get-Command node).Source
Copy-Item -Path $nodeExe -Destination oneencode.exe -Force
$signtool = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\" } | Select-Object -First 1
if ($signtool) {
    & $signtool.FullName remove /s oneencode.exe
} else {
    Write-Warning "signtool.exe not found (Windows SDK) -- skipping signature removal. If the resulting exe won't launch, install the Windows SDK (or Visual Studio's 'Windows SDK Signing Tools' component) and re-run."
}

Write-Host "6/6 Injecting the SEA blob into oneencode.exe..."
npx postject oneencode.exe NODE_SEA_BLOB dist-pkg/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

Write-Host ""
Write-Host "Done: oneencode.exe"
Write-Host "To run it standalone elsewhere, it needs (all cwd-relative, same layout as this repo):"
Write-Host "  config/legs.local.yaml, config/secrets.local.yaml, config/mediamtx.yml"
Write-Host "  tools/mediamtx/mediamtx.exe"
Write-Host "  web/dist/ (for the dashboard)"
Write-Host "  ffmpeg on PATH (still a separate required install -- see CLAUDE.md section 6)"

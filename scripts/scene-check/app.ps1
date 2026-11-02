# Runs backdrop.exe against a real scene on a Windows machine with no Steam or Wallpaper Engine: it
# sets up the folders and registry key they would leave behind, and points the config at the scene.
param([string]$Exe, [string]$Out)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $Out | Out-Null
$steam = Join-Path $env:RUNNER_TEMP "steam"
$content = "$steam/steamapps/workshop/content/431960/3299228616"
New-Item -ItemType Directory -Force $content, "$steam/steamapps/common/wallpaper_engine" | Out-Null
git clone -q --depth 1 https://github.com/dearxiwei/dearxiwei.github.io "$env:RUNNER_TEMP/scene"
git clone -q --depth 1 https://github.com/laobamac/MirageWallpaper "$env:RUNNER_TEMP/stock"
Copy-Item "$env:RUNNER_TEMP/scene/repkg/3299228616/*" $content -Recurse
Move-Item "$env:RUNNER_TEMP/stock/assets" "$steam/steamapps/common/wallpaper_engine/assets"
New-Item -Force "HKCU:\Software\Valve\Steam" | Out-Null
Set-ItemProperty "HKCU:\Software\Valve\Steam" SteamPath $steam

# The import itself is covered by unit tests; here the app finds it already unpacked.
$data = "$env:APPDATA/com.anthonyradke.backdrop"
$id = "0123456789abcdef"
$lib = "$data/library/$id/scene"
New-Item -ItemType Directory -Force $lib | Out-Null
node "$PSScriptRoot/unpack.mjs" "$content/scene.pkg" $lib
Copy-Item "$content/project.json" $lib
@{ id = $id; name = "check"; kind = "scene"; file = "scene/project.json"; size = 1; added = 1; tags = @() } | ConvertTo-Json | Set-Content "$data/library/$id/meta.json" -Encoding utf8NoBOM
@{ span = $id; stillFrame = $true } | ConvertTo-Json | Set-Content "$data/config.json" -Encoding utf8NoBOM

$app = Start-Process $Exe -PassThru
Start-Sleep -Seconds 60
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$shot = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
[System.Drawing.Graphics]::FromImage($shot).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$shot.Save("$Out/desktop.png")
"alive: $(-not $app.HasExited)" | Tee-Object "$Out/status.txt"
if (Test-Path "$data/backdrop.log") { Copy-Item "$data/backdrop.log" $Out; Get-Content "$data/backdrop.log" -Tail 40 }
if (Test-Path "$data/library/$id/frame.jpg") { Copy-Item "$data/library/$id/frame.jpg" $Out }
if (-not $app.HasExited) { Stop-Process $app -Force } else { throw "the app exited with code $($app.ExitCode)" }

# Creates the "Mesh Drift" desktop shortcut (pythonw + launch.pyw, custom icon).
$app = Split-Path -Parent $MyInvocation.MyCommand.Path
$pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pyw) { $pyw = Join-Path (Split-Path -Parent (Get-Command python).Source) 'pythonw.exe' }
$desk = [Environment]::GetFolderPath('Desktop')
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut((Join-Path $desk 'Mesh Drift.lnk'))
$lnk.TargetPath = $pyw
$lnk.Arguments = '"' + (Join-Path $app 'launch.pyw') + '"'
$lnk.WorkingDirectory = $app
$lnk.IconLocation = (Join-Path $app 'icon.ico') + ',0'
$lnk.Description = 'Mesh Drift - animated mesh gradients with PNG, WEBP, JPEG, WebM and MP4 export'
$lnk.WindowStyle = 1
$lnk.Save()
Write-Output "Shortcut created: $(Join-Path $desk 'Mesh Drift.lnk')"

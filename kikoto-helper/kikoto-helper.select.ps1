$choice = Read-Host "1. English`n2. 简体中文`nChoose language / 选择语言"
if ($choice -eq '2') { & "$PSScriptRoot\kikoto-helper.zh-Hans.ps1" } else { & "$PSScriptRoot\kikoto-helper.en.ps1" }
exit $LASTEXITCODE

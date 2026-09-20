param([ValidateSet('en','zh')][string]$Language = 'en')
$ErrorActionPreference = 'Stop'
$HelperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = $HelperDir
Set-Location $Root
$Repo = 'yexca/kikoto'
$Version = 'v0.6.0'
$Raw = ('https://' + 'raw.githubusercontent.com/' + $Repo + '/' + $Version)
$script:Lang = $Language

function T([string]$en, [string]$zh) { if ($script:Lang -eq 'zh') { return $zh }; return $en }
function Pause-Helper { Read-Host (T 'Press Enter to continue' '按 Enter 返回') | Out-Null }
function Ask([string]$prompt) { return (Read-Host $prompt).Trim() }
function Select-Folder([string]$description) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = $description
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.SelectedPath }
  } catch { }
  return $null
}
function Confirm([string]$en, [string]$zh) {
  $v = Ask (T "$en [y/N]" "$zh [y/N]")
  return $v -in @('y','Y','yes','Yes','是','1')
}
function Write-Section([string]$text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Read-Secret([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  return (New-Object System.Net.NetworkCredential('', $secure)).Password
}
function Set-EnvValue([string]$name, [string]$value) {
  $path = Join-Path $Root '.env'
  $lines = if (Test-Path $path) { @(Get-Content -LiteralPath $path) } else { @() }
  $escaped = $value.Replace('\', '\\').Replace("'", "\'")
  $replacement = "$name='$escaped'"
  $found = $false
  $lines = @($lines | ForEach-Object {
    if ($_ -match "^\s*#?\s*$([regex]::Escape($name))=") { $found = $true; $replacement } else { $_ }
  })
  if (-not $found) { $lines += $replacement }
  Set-Content -LiteralPath $path -Value $lines -Encoding UTF8
}
function Docker-Available {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  try {
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
    docker compose version 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}
function Ensure-Docker {
  if (Docker-Available) { return $true }
  Write-Host (T 'Docker is not installed or the Docker engine is not running.' '未检测到 Docker，或 Docker 引擎尚未运行。') -ForegroundColor Yellow
  Write-Host (T '1. Open the official Docker Desktop download page' '1. 打开 Docker Desktop 官方下载页面')
  Write-Host (T '2. Exit helper' '2. 退出程序')
  $choice = Ask (T 'Choose [1/2]' '请选择 [1/2]')
  if ($choice -eq '1') {
    Start-Process 'https://docs.docker.com/desktop/setup/install/windows-install/'
    Write-Host (T 'Install Docker Desktop, enable Linux containers, then run this helper again.' '请安装 Docker Desktop、启用 Linux 容器，然后重新运行本程序。')
    if ($script:Lang -eq 'zh') { Write-Host '提示：在中国大陆，下载 Docker 或镜像可能因网络原因缓慢或失败。' -ForegroundColor Yellow }
  }
  return $false
}
function Download-File([string]$name, [string]$target) {
  $tmp = "$target.download"
  try {
    Invoke-WebRequest -Uri "$Raw/$name" -OutFile $tmp -UseBasicParsing
    if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 20) { throw 'download too small' }
    Move-Item -LiteralPath $tmp -Destination $target -Force
    return $true
  } catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Write-Host (T "Download failed: $name" "下载失败：$name") -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor DarkGray
    return $false
  }
}
function Initialize-Project {
  Write-Section (T 'Project initialization' '程序初始化')
  $helperFiles = @('kikoto-helper.cmd','kikoto-helper.core.ps1','kikoto-helper.en.ps1','kikoto-helper.zh-Hans.ps1','kikoto-helper.select.ps1','kikoto-helper.ps1')
  $items = @(Get-ChildItem -Force | Where-Object { $_.Name -notin $helperFiles })
  if ($items.Count -gt 0) {
    Write-Host (T 'This folder is not empty. Existing files may be overwritten.' '当前文件夹不是空文件夹，继续可能造成文件覆盖。') -ForegroundColor Yellow
    if (-not (Confirm 'Continue anyway?' '仍然继续？')) { return }
  }
  foreach ($dir in @('config','data','cache')) { New-Item -ItemType Directory -Force -Path (Join-Path $Root $dir) | Out-Null }
  if (-not (Test-Path (Join-Path $Root '.env'))) {
    if (-not (Download-File '.env.example' (Join-Path $Root '.env'))) { Pause-Helper; return }
  } else { Write-Host (T '.env already exists; keeping it.' '.env 已存在，将保留现有配置。') }
  if (-not (Test-Path (Join-Path $Root 'docker-compose.yml'))) {
    if (-not (Download-File 'docker-compose.yml' (Join-Path $Root 'docker-compose.yml'))) { Pause-Helper; return }
  } else { Write-Host (T 'docker-compose.yml already exists; keeping it.' 'docker-compose.yml 已存在，将保留现有配置。') }
  Write-Host (T 'Initialization completed.' '初始化完成。') -ForegroundColor Green
  Pause-Helper
}
function Configure-Admin {
  Write-Section (T 'Administrator account' '管理员账户')
  if (-not (Test-Path (Join-Path $Root '.env'))) { Write-Host (T 'Run initialization first.' '请先执行程序初始化。'); Pause-Helper; return }
  $dbExists = Test-Path (Join-Path $Root 'config/kikoto.db')
  if (-not $dbExists) {
    $user = Ask (T 'Administrator username (default: root)' '管理员用户名（默认：root）')
    if ($user) { Set-EnvValue 'KIKOTO_ROOT_USERNAME' $user }
  } else { Write-Host (T 'The administrator username is locked after first startup.' '服务首次运行后管理员用户名不可修改。') -ForegroundColor Yellow }
  $p1 = Read-Secret (T 'New administrator password' '新的管理员密码')
  $p2 = Read-Secret (T 'Repeat password' '再次输入密码')
  if ([string]::IsNullOrWhiteSpace($p1) -or $p1 -ne $p2) { Write-Host (T 'Passwords are empty or do not match.' '密码为空或两次输入不一致。') -ForegroundColor Red } else { Set-EnvValue 'KIKOTO_ROOT_PASSWORD' $p1; Write-Host (T 'Password saved. Restart/recreate the service to apply it.' '密码已保存，需重新创建服务后生效。') -ForegroundColor Green }
  Pause-Helper
}
function Get-ExtraMappings {
  $override = Join-Path $Root 'docker-compose.override.yml'
  if (-not (Test-Path $override)) { return @() }
  $result = @()
  foreach ($line in Get-Content -LiteralPath $override) {
    if ($line -match "-\s+'(.+):/data/external-\d+'") { $result += $Matches[1].Replace('/','\') }
  }
  return $result
}
function Save-ExtraMappings([string[]]$paths) {
  $override = Join-Path $Root 'docker-compose.override.yml'
  if (-not $paths -or $paths.Count -eq 0) { Remove-Item $override -Force -ErrorAction SilentlyContinue; return }
  $volumes = @(); $i = 0
  foreach ($path in $paths) { $i++; $volumes += "      - '$($path.Replace('\','/')):/data/external-$i'" }
  @("services:","  kikoto:","    volumes:") + $volumes | Set-Content -LiteralPath $override -Encoding UTF8
}
function Update-Compose-Mappings {
  $defaultData = [IO.Path]::GetFullPath((Join-Path $Root 'data'))
  $extra = @(Get-ExtraMappings)
  Write-Section (T 'Audio folders' '音声文件夹')
  Write-Host (T 'Current mapped folders:' '当前已映射的文件夹：')
  Write-Host ("  1. $defaultData " + (T '(default, cannot be removed here)' '（默认目录，不能在此删除）'))
  for ($n = 0; $n -lt $extra.Count; $n++) { Write-Host ("  {0}. {1}" -f ($n + 2), $extra[$n]) }
  Write-Host ''
  Write-Host (T 'A. Add folder(s)   D. Delete folder   C. Cancel' 'A. 添加文件夹   D. 删除文件夹   C. 取消')
  $action = (Ask (T 'Choose' '请选择')).ToUpperInvariant()
  if ($action -eq 'C' -or $action -eq '') { return }
  if ($action -eq 'A') {
    $pathsToAdd = @()
    $usePicker = Confirm 'Open a folder picker?' '打开文件夹选择窗口？'
    if ($usePicker) {
      while ($true) {
        $picked = Select-Folder (T 'Select an audio folder' '请选择音声文件夹')
        if (-not $picked) { break }
        $pathsToAdd += $picked
        if (-not (Confirm 'Add another folder?' '继续添加其他文件夹？')) { break }
      }
    } else {
      $inputPaths = Ask (T 'Enter folder paths separated by semicolons' '输入文件夹路径，用分号分隔')
      $pathsToAdd = @($inputPaths -split ';')
    }
    foreach ($raw in $pathsToAdd) {
      $p = ([string]$raw).Trim(' "')
      if (-not $p) { continue }
      if (-not (Test-Path -LiteralPath $p -PathType Container)) { Write-Host (T "Folder not found: $p" "文件夹不存在：$p") -ForegroundColor Yellow; continue }
      $full = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $p).Path)
      if ($full -ne $defaultData -and $extra -notcontains $full) { $extra += $full }
    }
    Save-ExtraMappings $extra
    Write-Host (T 'Folder mappings saved.' '文件夹映射已保存。') -ForegroundColor Green
  } elseif ($action -eq 'D') {
    if ($extra.Count -eq 0) { Write-Host (T 'There are no extra folders to delete.' '没有可删除的额外文件夹。'); Pause-Helper; return }
    $number = 0; [int]::TryParse((Ask (T 'Enter the number to delete' '输入要删除的编号')), [ref]$number) | Out-Null
    $index = $number - 2
    if ($index -ge 0 -and $index -lt $extra.Count) { $extra = @($extra | Where-Object { $_ -ne $extra[$index] }); Save-ExtraMappings $extra; Write-Host (T 'Folder mapping deleted.' '文件夹映射已删除。') -ForegroundColor Green } else { Write-Host (T 'Invalid folder number.' '文件夹编号无效。') -ForegroundColor Yellow }
  } else { Write-Host (T 'Unknown choice.' '无法识别的选项。') -ForegroundColor Yellow }
  Pause-Helper
}function Service-Menu {
  while ($true) {
    Write-Section (T 'Service management' '服务管理')
    Write-Host (T '1. Start  2. Stop  3. Upgrade  4. Status  5. Logs  6. Open browser  0. Back' '1. 启动  2. 停止  3. 升级  4. 状态  5. 日志  6. 打开网页  0. 返回')
    $c = Ask (T 'Choose' '请选择')
    if ($c -eq '1') { docker compose config --quiet; if ($LASTEXITCODE -eq 0) { docker compose up -d }; Pause-Helper }
    elseif ($c -eq '2') { docker compose stop; Pause-Helper }
    elseif ($c -eq '3') {
      Write-Host (T 'Pulling the new image before stopping the current service...' '先拉取新镜像，成功后再停止当前服务……')
      docker compose pull
      if ($LASTEXITCODE -eq 0) { docker compose up -d --force-recreate } else { Write-Host (T 'Pull failed; current service was left running.' '拉取失败，当前服务保持运行。') -ForegroundColor Red }
      Pause-Helper
    } elseif ($c -eq '4') { docker compose ps; Pause-Helper }
    elseif ($c -eq '5') { docker compose logs --tail 100; Pause-Helper }
    elseif ($c -eq '6') { Start-Process 'http://127.0.0.1:7655' }
    elseif ($c -eq '0') { return }
  }
}
function Main-Menu {
  while ($true) {
    Write-Section (T 'Kikoto Helper' 'Kikoto 助手')
    Write-Host (T '1. Initialize  2. Administrator  3. Audio folders  4. Service  5. Backup  0. Exit' '1. 程序初始化  2. 管理员账户  3. 音声文件夹  4. 服务管理  5. 备份  0. 退出')
    $c = Ask (T 'Choose' '请选择')
    if ($c -eq '1') { Initialize-Project }
    elseif ($c -eq '2') { Configure-Admin }
    elseif ($c -eq '3') { Update-Compose-Mappings }
    elseif ($c -eq '4') { if (Ensure-Docker) { Service-Menu } else { Pause-Helper } }
    elseif ($c -eq '5') {
      $dest = Join-Path $Root ("backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss')); New-Item -ItemType Directory -Force $dest | Out-Null
      foreach ($n in @('.env','docker-compose.yml','docker-compose.override.yml')) { if (Test-Path $n) { Copy-Item $n $dest -Force } }
      Write-Host (T "Configuration backup saved to $dest" "配置备份已保存到 $dest") -ForegroundColor Green; Pause-Helper
    }
    elseif ($c -eq '0') { return }
  }
}

if (-not (Ensure-Docker)) { Pause-Helper; exit 0 }
Main-Menu


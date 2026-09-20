param([ValidateSet('en','zh')][string]$Language = 'en')
$ErrorActionPreference = 'Stop'
# Windows PowerShell's progress repaint can corrupt wide-character console output.
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $OutputEncoding
[Console]::OutputEncoding = $OutputEncoding
$HelperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = $HelperDir
Set-Location $Root
$Repo = 'yexca/kikoto'
$Version = 'v0.6.0'
$Raw = ('https://' + 'raw.githubusercontent.com/' + $Repo + '/' + $Version)
$script:Lang = $Language

function T([string]$en, [string]$zh) { if ($script:Lang -eq 'zh') { return $zh }; return $en }
function Pause-Helper { Read-Host (T 'Press Enter to continue' '按 Enter 返回') | Out-Null }
function Ask([string]$prompt) {
  Write-Host $prompt
  return ([string](Read-Host)).Trim()
}
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
  Write-Host $prompt
  $secure = Read-Host -AsSecureString
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
function Ensure-Project {
  Write-Section (T 'Deployment environment' '部署环境检查')
  foreach ($dir in @('config','data','cache')) {
    $path = Join-Path $Root $dir
    if ((Test-Path -LiteralPath $path) -and -not (Test-Path -LiteralPath $path -PathType Container)) {
      Write-Host (T "Expected a folder: $dir" "此位置需要是文件夹：$dir") -ForegroundColor Red
      return $false
    }
    if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path | Out-Null }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Root '.env'))) {
    $example = Join-Path $Root '.env.example'
    if (-not (Test-Path -LiteralPath $example)) {
      if (-not (Download-File '.env.example' $example)) { return $false }
    }
    Copy-Item -LiteralPath $example -Destination (Join-Path $Root '.env')
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'docker-compose.yml'))) {
    if (-not (Download-File 'docker-compose.yml' (Join-Path $Root 'docker-compose.yml'))) { return $false }
  }
  Write-Host (T 'Deployment files ready. Existing settings and data are preserved.' '部署文件已就绪，已有配置和数据均保留。') -ForegroundColor Green
  return $true
}
function Show-FolderList($state) {
  Write-Host (T 'Mapped folders (F = folder number)' '已映射目录（F 表示文件夹编号）') -ForegroundColor Cyan
  $line = '+------------------------------------------------------------+'
  Write-Host $line
  if (@($state.folders).Count -eq 0) { Write-Host (T '| No additional folders' '| 尚未添加额外目录'); Write-Host $line }
  for ($i = 0; $i -lt @($state.folders).Count; $i++) {
    Write-Host ("| F{0}" -f ($i + 1)) -ForegroundColor Yellow
    Write-Host ('|   ' + $state.folders[$i])
    Write-Host $line
  }
  if ($state.mode -eq 'multi') {
    Write-Host (T 'Writable /data root:' '可写的 /data 根目录：')
    Write-Host ('  ' + (Join-Path $Root 'data'))
  }
  Write-Host ''
  Write-Host (T 'Actions' '操作菜单') -ForegroundColor Cyan
  Write-Host '--------------------------------------------------------------'
}
function Test-AdminConfigured {
  $path = Join-Path $Root '.env'
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $value = ''
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    if ($line -match '^\s*KIKOTO_ROOT_PASSWORD\s*=(.*)$') { $value = $Matches[1].Trim() }
  }
  # Handles the template and the helper's quoted output without displaying credentials.
  $value = $value.Trim([char]39, [char]34).Trim()
  return $value -notin @('', 'change-me', 'replace-with-a-long-random-password')
}
function Read-NewAdminPassword([switch]$InitialSetup) {
  while ($true) {
    $prompt = if ($InitialSetup) {
      T 'Set administrator password' '设置管理员密码'
    } else {
      T 'New administrator password (blank cancels)' '新的管理员密码（留空取消）'
    }
    $p1 = Read-Secret $prompt
    if ([string]::IsNullOrWhiteSpace($p1)) {
      if (-not $InitialSetup) { return $null }
      Write-Host (T 'Administrator password is required. Please enter a password.' '管理员密码不能为空，请输入密码。') -ForegroundColor Yellow
      continue
    }
    $p2 = Read-Secret (T 'Repeat password' '再次输入密码')
    if ($p1 -ne $p2) {
      Write-Host (T 'Passwords do not match. Try again.' '两次密码不一致，请重新输入。') -ForegroundColor Yellow
      continue
    }
    if ($p1 -ne $p1.Trim() -or $p1.Contains([char]10) -or $p1.Contains([char]13) -or $p1 -in @('change-me','replace-with-a-long-random-password')) {
      Write-Host (T 'Use a non-template password without leading/trailing whitespace or line breaks.' '请使用非模板密码，且不要包含首尾空白或换行。') -ForegroundColor Yellow
      continue
    }
    return $p1
  }
}
function Ensure-Admin {
  if (Test-AdminConfigured) { return $true }
  Write-Section (T 'Initial administrator setup' '首次设置管理员账户')
  # Existing database state must not cause creation of a different root identity.
  $existingDatabase = @(Get-ChildItem -LiteralPath (Join-Path $Root 'config') -Filter '*.db' -File -ErrorAction SilentlyContinue).Count -gt 0
  $username = $null
  if (-not $existingDatabase) {
    $username = Ask (T 'Administrator username (default: root)' '管理员用户名（默认：root）')
    if (-not $username) { $username = 'root' }
  } else {
    Write-Host (T 'Existing database found. Keeping the configured username.' '检测到已有数据库，保留配置中的管理员用户名。')
  }
  $password = Read-NewAdminPassword -InitialSetup
if ($null -ne $username) { Set-EnvValue 'KIKOTO_ROOT_USERNAME' $username }
  Set-EnvValue 'KIKOTO_ROOT_PASSWORD' $password
  Write-Host (T 'Administrator configured. Use Service > Start when ready.' '管理员账户已设置，可在准备完成后通过“服务管理 > 启动”启动服务。') -ForegroundColor Green
  return $true
}
function Recreate-Service {
  Write-Host (T 'Recreating containers to apply configuration. A restart does not reload .env. Service will briefly stop; mounted data is kept.' '正在重建容器以应用配置。重启不会重新加载 .env。服务会短暂中断，挂载的数据保留。')
  docker compose config --quiet
  if ($LASTEXITCODE -ne 0) {
    Write-Host (T 'Configuration validation failed; containers were not recreated.' '配置检查失败，未重建容器。') -ForegroundColor Red
    return
  }
  docker compose up -d --force-recreate --pull never
  if ($LASTEXITCODE -eq 0) {
    Write-Host (T 'Containers recreated with the saved configuration.' '已按保存的配置重建容器。') -ForegroundColor Green
  } else {
    Write-Host (T 'Recreation failed. Configuration is saved; check the Docker error and retry from Service management.' '重建失败。配置已保存，请检查 Docker 错误后从服务管理重试。') -ForegroundColor Red
  }
}
function Change-AdminPassword {
  Write-Section (T 'Change administrator password' '修改管理员密码')
  $password = Read-NewAdminPassword
  if ($null -eq $password) { return }
  Set-EnvValue 'KIKOTO_ROOT_PASSWORD' $password
  Write-Host (T 'Password saved. Recreate the service to apply it; restarting is insufficient. Existing administrator sessions will expire after the new password is applied.' '密码已保存，必须重建服务才能生效，仅重启无效。新密码生效后，管理员的旧登录会话将失效。') -ForegroundColor Green
  if (Confirm 'Recreate the service now (not restart)?' '现在重建服务（不是重启）？') {
    Recreate-Service
  } else {
    Write-Host (T 'Not applied yet. Choose Service > Recreate later.' '尚未应用新密码，请稍后选择“服务管理 > 重建服务”。')
  }
  Pause-Helper
}
function Get-FolderState {
  $default = [IO.Path]::GetFullPath((Join-Path $Root 'data'))
  $override = Join-Path $Root 'docker-compose.override.yml'
  if (-not (Test-Path -LiteralPath $override)) { return [pscustomobject]@{ mode = 'single'; folders = @($default) } }
  $raw = Get-Content -LiteralPath $override -Raw
  try {
    $doc = ($raw -replace '("volumes"\s*:\s*)!override\s+', '$1') | ConvertFrom-Json
    if ($doc.'x-kikoto-helper-mode' -notin @('single','multi')) { throw 'unmanaged' }
    $mounts = @($doc.services.kikoto.volumes)
    $folders = if ($doc.'x-kikoto-helper-mode' -eq 'single') {
      @($mounts | Where-Object target -eq '/data' | ForEach-Object source)
    } else { @($mounts | Where-Object { $_.target -like '/data/external-*' } | ForEach-Object source) }
    return [pscustomobject]@{ mode = $doc.'x-kikoto-helper-mode'; folders = @($folders) }
  } catch {
    $folders = @()
    foreach ($line in $raw -split '\r?\n') {
      if ($line -match "^\s+- '(.+):/data/external-\d+'\s*$") { $folders += [IO.Path]::GetFullPath($Matches[1].Replace('/','\')) }
      elseif ($line.Trim() -notin @('', 'services:', 'kikoto:', 'volumes:')) {
        throw (T 'Custom Compose override detected; review it before using folder management.' '检测到自定义 Compose 覆盖配置，请检查后再使用文件夹管理。')
      }
    }
    return [pscustomobject]@{ mode = 'multi'; folders = $folders }
  }
}
function Save-FolderState($state) {
  $folders = @($state.folders | Select-Object -Unique)
  if ($state.mode -eq 'single' -and $folders.Count -ne 1) { throw 'Single mode requires one folder.' }
  # Replace the base Compose mount list so ./data:/data cannot survive a merge.
  # !override requires Docker Compose 2.24.4 or newer.
  $mounts = @(
    @{ type = 'bind'; source = './config'; target = '/config' },
    @{ type = 'bind'; source = './cache'; target = '/cache' }
  )
  if ($state.mode -eq 'single') {
    $mounts += @{ type = 'bind'; source = $folders[0]; target = '/data'; bind = @{ create_host_path = $false } }
  }
  if ($state.mode -eq 'multi') {
    foreach ($folder in $folders) {
      # Stable targets keep other libraries in place when one mapping is deleted.
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $id = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($folder.ToLowerInvariant()))).Replace('-','').Substring(0,12).ToLowerInvariant() }
      finally { $sha.Dispose() }
      $mounts += @{ type = 'bind'; source = $folder; target = "/data/external-$id"; bind = @{ create_host_path = $false } }
    }
  }
  # Use YAML flow syntax with !override; keep mode and mounts in one file.
  $doc = @{ 'x-kikoto-helper-mode' = $state.mode; services = @{ kikoto = @{ volumes = $mounts } } }
  $path = Join-Path $Root 'docker-compose.override.yml'
  $yaml = ($doc | ConvertTo-Json -Depth 8) -replace '("volumes"\s*:\s*)', '$1!override '
  [IO.File]::WriteAllText("$path.tmp", $yaml, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath "$path.tmp" -Destination $path -Force
}
function Pick-Folders([bool]$multiple) {
  $paths = @()
  do {
    $picked = Select-Folder (T 'Select an audio folder' '请选择音声文件夹')
    if (-not $picked) { break }
    if (-not (Test-Path -LiteralPath $picked -PathType Container)) { continue }
    $full = [IO.Path]::GetFullPath($picked)
    if ($paths -notcontains $full) { $paths += $full }
  } while ($multiple -and (Confirm 'Add another folder?' '继续添加其他文件夹？'))
  return $paths
}
function Update-Compose-Mappings {
  while ($true) {
    $state = Get-FolderState
    Write-Section (T 'Audio folders' '音声文件夹')
    Show-FolderList $state
    if ($state.mode -eq 'single') {
      Write-Host (T '1. Change mode (current: single folder)' '1. 更改模式（当前单文件夹模式）')
      Write-Host (T '2. Change folder' '2. 更改文件夹')
    } else {

      Write-Host (T '1. Change mode (current: multiple folders)' '1. 更改模式（当前多文件夹模式）')
      Write-Host (T '2. Add' '2. 增加')
      Write-Host (T '3. Delete mapping (keeps files)' '3. 删除映射（保留文件）')
    }
    Write-Host (T '0. Cancel / return' '0. 取消 / 返回菜单')
    $action = Ask (T 'Choose' '请选择')
    if ($action -eq '0' -or -not $action) { return }
    if ($action -eq '1') {
      if ($state.mode -eq 'single') {
        $state.mode = 'multi'

        Write-Host (T 'Subfolders add a scan level. Review scan depth in Maintenance.' '子目录映射会增加一层目录，请检查网页维护设置中的扫描深度。')
      } else {
        Write-Host (T 'Select the one folder to mount; other files will not be deleted.' '请选择单文件夹模式使用的目录；其他文件不会被删除。')
        $picked = @(Pick-Folders $false)
        if ($picked.Count -eq 0) { continue }
        $state.mode = 'single'; $state.folders = @($picked[0])
      }
    } elseif ($action -eq '2') {
      $picked = @(Pick-Folders ($state.mode -eq 'multi'))
      if ($picked.Count -eq 0) { continue }
      if ($state.mode -eq 'single') { $state.folders = @($picked[0]) }
      else { $state.folders = @(@($state.folders) + $picked | Select-Object -Unique) }
    } elseif ($action -eq '3' -and $state.mode -eq 'multi') {
      $n = 0
      [int]::TryParse((Ask (T 'Folder number, e.g. F1 (0 cancels)' '文件夹编号，例如 F1（0 取消）')).TrimStart('F','f'), [ref]$n) | Out-Null
      if ($n -lt 1 -or $n -gt @($state.folders).Count) { continue }
      $remove = $state.folders[$n - 1]
      $state.folders = @($state.folders | Where-Object { $_ -ne $remove })
    } else { continue }
    Save-FolderState $state
    Write-Host (T 'Saved. Use Service > Start to apply the mappings.' '已保存。请通过“服务管理 > 启动”应用映射。') -ForegroundColor Green
  }
}
function Get-ServiceVersionText {
  $ErrorActionPreference = 'Continue'
  try {
    $images = @(docker compose config --images kikoto 2>$null)
    if ($LASTEXITCODE -ne 0 -or $images.Count -ne 1 -or -not $images[0]) {
      return (T 'Version unavailable: check Compose configuration.' '无法读取版本：请检查 Compose 配置。')
    }
    $imageName = ([string]$images[0]).Trim()
    $label = docker image inspect --format '{{json .Config.Labels}}' $imageName 2>$null
    if ($LASTEXITCODE -ne 0) {
      docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { return (T 'Version unavailable: Docker is not running or cannot be reached.' '无法读取版本：Docker 未运行或无法连接。') }
      return (T 'No local image. Start the service once first.' '本地无镜像，请先启动一次')
    }
    $labels = $label | ConvertFrom-Json -ErrorAction Stop
    $version = [string]$labels.'org.opencontainers.image.version'
    if ([string]::IsNullOrWhiteSpace($version)) { return (T 'Local image has no version label.' '本地镜像未提供版本号。') }
    if ($version -match '^\d+\.\d+\.\d+') { $version = 'v' + $version }
    $version = $version -replace '[\x00-\x1f\x7f]', ''
    return (T "Local image version: $version" "本地镜像版本：$version")
  } catch {
    return (T 'Version unavailable. Check Docker and Compose configuration.' '无法读取版本，请检查 Docker 和 Compose 配置。')
  }
}
function Show-ServiceVersion {
  Write-Host (Get-ServiceVersionText) -ForegroundColor Cyan
  Write-Host ''
}
function Service-Menu {
  while ($true) {
    Write-Section (T 'Service management' '服务管理')
    Show-ServiceVersion
    Write-Host (T '1. Start  2. Stop  3. Upgrade  4. Status  5. Logs  6. Open browser' '1. 启动  2. 停止  3. 升级  4. 状态  5. 日志  6. 打开网页')
    Write-Host (T '7. Remove containers (keep data)  8. Recreate service  0. Back' '7. 删除容器（保留数据）  8. 重建服务  0. 返回')
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
    elseif ($c -eq '8') { Recreate-Service; Pause-Helper }
    elseif ($c -eq '7') {
      if (Confirm 'Remove this deployment''s containers and Compose network? Configuration and media files will be kept.' '删除本部署的容器和 Compose 网络？配置及音声文件会保留。') {
        docker compose down
        if ($LASTEXITCODE -eq 0) { Write-Host (T 'Containers removed. Use Start to recreate them.' '容器已删除，可通过“启动”重新创建。') -ForegroundColor Green }
        else { Write-Host (T 'Container removal failed. Check the Docker error above.' '删除容器失败，请检查上方 Docker 错误。') -ForegroundColor Red }
        Pause-Helper
      }
    }
    elseif ($c -eq '0') { return }
  }
}
function Main-Menu {
  while ($true) {
    Write-Section (T 'Kikoto Helper' 'Kikoto 助手')
    Write-Host (T '1. Change administrator password  2. Audio folders  3. Service  4. Backup  0. Exit' '1. 修改管理员密码  2. 音声文件夹  3. 服务管理  4. 备份  0. 退出')
    $c = Ask (T 'Choose' '请选择')
    if ($c -eq '1') { Change-AdminPassword }
    elseif ($c -eq '2') { Update-Compose-Mappings }
    elseif ($c -eq '3') { if (Ensure-Docker) { Service-Menu } else { Pause-Helper } }
    elseif ($c -eq '4') {
      $dest = Join-Path $Root ("backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss')); New-Item -ItemType Directory -Force $dest | Out-Null
      foreach ($n in @('.env','docker-compose.yml','docker-compose.override.yml')) { if (Test-Path $n) { Copy-Item $n $dest -Force } }
      Write-Host (T "Configuration backup saved to $dest" "配置备份已保存到 $dest") -ForegroundColor Green; Pause-Helper
    }
    elseif ($c -eq '0') { return }
  }
}

if (-not (Ensure-Docker)) { Pause-Helper; exit 0 }
if (-not (Ensure-Project)) { Pause-Helper; exit 1 }
if (-not (Ensure-Admin)) { Pause-Helper; exit 1 }
Main-Menu

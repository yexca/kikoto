$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('kikoto-helper-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null

function Assert($condition, [string]$message) {
  if (-not $condition) { throw $message }
}

foreach ($language in @('en', 'zh-Hans', 'core')) {
  $source = Join-Path $repository "kikoto-helper/kikoto-helper.$language.ps1"
  $tokens = $null; $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
  Assert ($parseErrors.Count -eq 0) "$language parse errors"
  # Load definitions only: never invoke the entry point or the real Docker engine.
  foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
  }
  $Root = Join-Path $testRoot $language
  New-Item -ItemType Directory -Path $Root | Out-Null
  $script:Lang = 'en'
  $script:versionCase = 'present'
  $script:versionCalls = @()
  function docker {
    $script:versionCalls += ($args -join ' ')
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'compose') {
      if ($script:versionCase -eq 'bad-config') { $global:LASTEXITCODE = 1; return }
      return 'example/kikoto:latest'
    }
    if ($args[0] -eq 'image') {
      if ($script:versionCase -in @('missing','offline')) { $global:LASTEXITCODE = 1; return }
      if ($script:versionCase -eq 'unlabelled') { return 'null' }
      return '{"org.opencontainers.image.version":"0.6.0"}'
    }
    if ($args[0] -eq 'info' -and $script:versionCase -eq 'offline') { $global:LASTEXITCODE = 1 }
  }
  Assert ((Get-ServiceVersionText) -eq 'Local image version: v0.6.0') 'Read concrete version from a latest image label'
  $script:versionCase = 'missing'
  Assert ((Get-ServiceVersionText) -eq 'No local image. Start the service once first.') 'Missing image needs a startup hint'
  $script:versionCase = 'offline'
  Assert ((Get-ServiceVersionText).Contains('cannot be reached')) 'Daemon failure must not be called a missing image'
  $script:versionCase = 'unlabelled'
  Assert ((Get-ServiceVersionText) -eq 'Local image has no version label.') 'Unlabelled image must not invent a version'
  $script:versionCase = 'bad-config'
  Assert ((Get-ServiceVersionText).Contains('check Compose')) 'Invalid configuration should be reported'
  Assert (-not (($script:versionCalls -join ' ') -match '\b(pull|up|run)\b')) 'Version lookup must be read-only'
  function Show-ServiceVersion {}
  function Invoke-WebRequest {
    param([string]$Uri)
    return [pscustomobject]@{ Content = "@echo off`r`nset `"HELPER_VERSION=v0.2.0`"" }
  }
  Assert ((Get-RemoteHelperVersion) -eq 'v0.2.0') 'Helper version must be read from the remote cmd file'
  $script:downloads = @()
  function Download-File($name, $target) {
    $script:downloads += $name
    Set-Content -LiteralPath $target -Value 'synthetic configuration'
    return $true
  }
  Assert (Ensure-Project) 'Fresh deployment should be prepared'
  Assert ($script:downloads.Count -eq 2) 'Fresh deployment should download both templates'
  foreach ($name in @('config', 'data', 'cache', '.env', '.env.example', 'docker-compose.yml')) {
    Assert (Test-Path -LiteralPath (Join-Path $Root $name)) "Missing $name"
  }
  $envPath = Join-Path $Root '.env'
  Set-Content -LiteralPath $envPath -Value 'synthetic user settings'
  $before = [IO.File]::ReadAllBytes($envPath)
  Assert (Ensure-Project) 'Repeated preparation should succeed'
  Assert ($script:downloads.Count -eq 2) 'Repeated preparation must not download again'
  Assert ([Convert]::ToBase64String($before) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath))) 'Existing settings changed'

  # First setup must finish before entering the menu, and must not repeat once saved.
  Set-Content -LiteralPath $envPath -Value 'KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password'
  $script:answers = New-Object 'System.Collections.Generic.Queue[string]'
  $script:answers.Enqueue('synthetic-user')
  function Ask { return $script:answers.Dequeue() }
  $script:secrets = New-Object 'System.Collections.Generic.Queue[string]'
  $script:secrets.Enqueue('synthetic-password'); $script:secrets.Enqueue('synthetic-password')
  function Read-Secret { return $script:secrets.Dequeue() }
  Assert (Ensure-Admin) 'Initial account setup should succeed'
  $accountBefore = Get-Content -LiteralPath $envPath -Raw
  Assert ($accountBefore.Contains("KIKOTO_ROOT_USERNAME='synthetic-user'")) 'Initial username was not saved'
  Assert (Ensure-Admin) 'Existing account must not prompt again'
  Assert ($accountBefore -eq (Get-Content -LiteralPath $envPath -Raw)) 'Existing account was changed on launch'

  $script:commands = @()
  function docker { $script:commands += ($args -join ' '); $global:LASTEXITCODE = 0 }
  function Pause-Helper {}
  function Confirm { return $script:approved }
  foreach ($approved in @($false, $true)) {
    $script:approved = $approved
    $script:secrets.Enqueue('synthetic-new-password'); $script:secrets.Enqueue('synthetic-new-password')
    Change-AdminPassword
    Assert ((Get-Content -LiteralPath $envPath -Raw).Contains("KIKOTO_ROOT_USERNAME='synthetic-user'")) 'Password change modified username'
    Assert ($script:commands.Count -eq (2 * [int]$approved)) 'Recreation choice was ignored'
  }
  Assert ($script:commands[1] -eq 'compose up -d --force-recreate --pull never') 'Password change must recreate without pulling'
  $script:commands = @()
  $script:answers.Enqueue('8'); $script:answers.Enqueue('0')
  Service-Menu
  Assert ($script:commands[1] -eq 'compose up -d --force-recreate --pull never') 'Service menu must offer recreation'
  $script:commands = @()
  function docker { $script:commands += ($args -join ' '); $global:LASTEXITCODE = 1 }
  Recreate-Service
  Assert ($script:commands.Count -eq 1) 'Failed validation must not recreate'

  # First setup requires a password: empty and whitespace inputs retry without cancelling.
  Set-Content -LiteralPath $envPath -Value 'KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password'
  $script:answers.Enqueue('synthetic-user')
  $script:secrets.Enqueue('')
  $script:secrets.Enqueue('   ')
  $script:secrets.Enqueue('synthetic-password'); $script:secrets.Enqueue('synthetic-password')
  $script:prompts = @()
  function Read-Secret($prompt) { $script:prompts += $prompt; return $script:secrets.Dequeue() }
  Assert (Ensure-Admin) 'Initial setup should retry until a password is entered'
  Assert (Test-AdminConfigured) 'Retried initial setup should save the password'
  Assert ($script:prompts[0] -eq 'Set administrator password') 'First setup must use a setup prompt'
  Assert (-not (($script:prompts -join ' ').Contains('cancels'))) 'First setup must not advertise cancellation'
  $before = Get-Content -LiteralPath $envPath -Raw
  $script:secrets.Enqueue('')
  Change-AdminPassword
  Assert ($before -eq (Get-Content -LiteralPath $envPath -Raw)) 'Cancelling a later password change must keep credentials'

  $Root = Join-Path $testRoot ($language + '-failure')
  New-Item -ItemType Directory -Path $Root | Out-Null
  function Download-File { return $false }
  Assert (-not (Ensure-Project)) 'Failed download must stop preparation'
  Assert (-not (Test-Path (Join-Path $Root '.env'))) 'Failed download must not create .env'

  $script:commands = @()
  function docker { $script:commands += ($args -join ' '); $global:LASTEXITCODE = 0 }
  function Pause-Helper {}
  function Ask { return $script:answers.Dequeue() }
  foreach ($approved in @($false, $true)) {
    $script:approved = $approved
    function Confirm { return $script:approved }
    $script:answers = New-Object 'System.Collections.Generic.Queue[string]'
    $script:answers.Enqueue('7'); $script:answers.Enqueue('0')
    Service-Menu
    Assert ($script:commands.Count -eq [int]$approved) 'Removal confirmation was ignored'
  }
  Assert ($script:commands[0] -eq 'compose down') 'Removal must not delete volumes or images'
  $display = (Show-FolderList ([pscustomobject]@{mode='single'; folders=@('Library/RJ00000000')}) 6>&1 | Out-String)
  Assert ($display.Contains('F1') -and $display.Contains('Actions')) 'Folder numbers must be separate from menu actions'

  # Validate real Compose merging: omitting /data from an ordinary override is insufficient.
  $Root = Join-Path $testRoot ($language + '-mounts')
  New-Item -ItemType Directory -Path $Root | Out-Null
  Copy-Item -LiteralPath (Join-Path $repository 'docker-compose.yml') -Destination $Root
  Set-Content -LiteralPath (Join-Path $Root '.env') -Value 'KIKOTO_ROOT_PASSWORD=synthetic-password'
  $libraryA = Join-Path $Root 'Library A'
  $libraryB = Join-Path $Root "Library B's"
  foreach ($scenario in @(
    [pscustomobject]@{mode='multi'; folders=@($libraryA,$libraryB)},
    [pscustomobject]@{mode='multi'; folders=@()},
    [pscustomobject]@{mode='single'; folders=@($libraryA)}
  )) {
    Save-FolderState $scenario
    $reloaded = Get-FolderState
    Assert ($reloaded.mode -eq $scenario.mode -and @($reloaded.folders).Count -eq $scenario.folders.Count) 'Saved mount selection did not round trip'
    $compose = & docker.exe compose --project-directory $Root -f (Join-Path $Root 'docker-compose.yml') -f (Join-Path $Root 'docker-compose.override.yml') config --format json
    Assert ($LASTEXITCODE -eq 0) 'Compose configuration rejected mount override (requires Compose >= 2.24.4)'
    $config = $compose | ConvertFrom-Json
    $mounts = @($config.services.kikoto.volumes)
    Assert (@($mounts | Where-Object type -eq 'volume').Count -eq 0) 'Helper must not introduce a persistent volume'
    Assert (@($mounts | Where-Object { $_.target -in @('/config','/cache') }).Count -eq 2) 'Config and cache mounts must survive'
    Assert ($config.services.kikoto.ports[0].published -eq '7655') 'Port mapping must survive'
    if ($scenario.mode -eq 'multi') {
      Assert (@($mounts | Where-Object target -eq '/data').Count -eq 1) 'Multi mode must keep the host data mount for downloads'
      Assert (@($mounts | Where-Object { $_.target -like '/data/external-*' }).Count -eq $scenario.folders.Count) 'Multi mode must mount only selected folders'
      Assert (@($mounts | Where-Object { $_.source -eq (Join-Path $Root 'data') -or $_.source -eq (Join-Path $Root 'data').Replace('\','/') }).Count -eq 1) 'Multi mode must map the deployment data folder'
    } else {
      Assert (@($mounts | Where-Object target -eq '/data').Count -eq 1) 'Single mode needs one /data mount'
      Assert (@($mounts | Where-Object { $_.target -like '/data/*' }).Count -eq 0) 'Single mode must remove prior subfolder mounts'
    }
  }

  # Regression: old multi-folder overrides could record the deployment data folder
  # both as /data and as an external folder. Repair must keep only the root mount.
  $defaultData = [IO.Path]::GetFullPath((Join-Path $Root 'data'))
  New-Item -ItemType Directory -Force -Path $defaultData | Out-Null
  $legacyMounts = @(
    [ordered]@{ type='bind'; source='./config'; target='/config' },
    [ordered]@{ type='bind'; source='./cache'; target='/cache' },
    [ordered]@{ type='bind'; source='./data'; target='/data' },
    [ordered]@{ type='bind'; source=$defaultData; target='/data/external-legacy' },
    [ordered]@{ type='bind'; source=$libraryA; target='/data/external-library' }
  )
  $legacyDoc = [ordered]@{
    'x-kikoto-helper-mode' = 'multi'
    services = [ordered]@{ kikoto = [ordered]@{ volumes = $legacyMounts } }
  }
  $overridePath = Join-Path $Root 'docker-compose.override.yml'
  $legacyDoc | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $overridePath -Encoding UTF8
  $script:approved = $true
  function Confirm { return $script:approved }
  Repair-MultipleFolders
  $repaired = Get-FolderState
  Assert (@($repaired.folders).Count -eq 1 -and $repaired.folders[0] -eq $libraryA) 'Repair must remove the deployment data folder from external mappings'
  $repairBackups = @(Get-ChildItem -Path (Join-Path $Root 'docker-compose.override.yml.repair-*.bak') -ErrorAction SilentlyContinue)
  Assert ($repairBackups.Count -eq 1) 'Repair must create a Compose override backup'
  $repairedDoc = ((Get-Content -LiteralPath $overridePath -Raw) -replace '("volumes"\s*:\s*)!override\s+', '$1') | ConvertFrom-Json
  $repairedMounts = @($repairedDoc.services.kikoto.volumes)
  Assert (@($repairedMounts | Where-Object target -eq '/data').Count -eq 1) 'Repaired multi mode must keep one host data mount'
  Assert (@($repairedMounts | Where-Object { $_.target -like '/data/external-*' -and [IO.Path]::GetFullPath($_.source) -eq $defaultData }).Count -eq 0) 'Repaired multi mode must not remount host data as external'
  Write-Host "$language helper checks passed"
}

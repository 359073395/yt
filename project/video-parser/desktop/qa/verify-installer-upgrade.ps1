param(
  [Parameter(Mandatory=$true)][string]$PreviousInstaller,
  [Parameter(Mandatory=$true)][string]$CandidateInstaller,
  [Parameter(Mandatory=$true)][string]$PreviousVersion,
  [Parameter(Mandatory=$true)][string]$CandidateVersion,
  [Parameter(Mandatory=$true)][string]$ReceiptPath,
  [Parameter(Mandatory=$true)][string]$SourceSha
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This installer acceptance script runs only on a disposable GitHub-hosted runner.'
}
$installRoot = Join-Path $env:RUNNER_TEMP 'yinglian-install-upgrade-qa'
$localRoot = Join-Path $env:LOCALAPPDATA 'org.yinglian.desktop.preview'
$roamingRoot = Join-Path $env:APPDATA 'org.yinglian.desktop.preview'
if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $localRoot) -or (Test-Path -LiteralPath $roamingRoot)) {
  throw 'Refusing a runner with existing YingLian installation or user state.'
}
$receipt = [ordered]@{
  sourceCommit = $SourceSha
  candidateSha256 = (Get-FileHash -LiteralPath $CandidateInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  environment = 'disposable GitHub-hosted Windows runner'
  previousVersion = $null
  installedVersion = $null
  preservedFiles = @()
  passed = $false
}
function Install-Candidate([string]$Path) {
  $process = Start-Process -FilePath $Path -ArgumentList @('/S', "/D=$installRoot") -PassThru -WindowStyle Hidden
  if (-not $process.WaitForExit(120000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'NSIS silent install timed out.'
  }
  if ($process.ExitCode -ne 0) { throw "NSIS installer exited $($process.ExitCode)." }
}
try {
  Install-Candidate $PreviousInstaller
  $main = Join-Path $installRoot 'paoliang-preview.exe'
  $receipt.previousVersion = (Get-Item -LiteralPath $main).VersionInfo.ProductVersion
  if ($receipt.previousVersion -ne $PreviousVersion) { throw 'Previous installer version mismatch.' }
  $models = Join-Path $env:RUNNER_TEMP 'yinglian-existing-models'
  $media = Join-Path $env:RUNNER_TEMP 'yinglian-existing-media'
  New-Item -ItemType Directory -Path $localRoot,$roamingRoot,$models,$media -Force | Out-Null
  $fixtures = @(
    @{path=(Join-Path $roamingRoot 'library.0.json'); content='{"generation":8,"data":{"version":1,"categories":["升级迁移验收"],"items":[],"tasks":[],"dismissedDeliveries":[]}}'},
    @{path=(Join-Path $roamingRoot 'library.1.json'); content='{"generation":9,"data":{"version":1,"categories":["升级迁移验收","嵌套/分类"],"items":[],"tasks":[],"dismissedDeliveries":[]}}'},
    @{path=(Join-Path $localRoot 'network.1.json'); content='{"generation":1,"config":{"mode":"direct","address":"http://127.0.0.1:10808","overseas_only":true}}'},
    @{path=(Join-Path $localRoot 'model-location.txt'); content=$models},
    @{path=(Join-Path $roamingRoot 'automation.0.json'); content='{"version":1,"generation":4,"subscriptions":[],"deliveries":[],"recordings":[]}'},
    @{path=(Join-Path $models 'model-preservation-fixture.txt'); content='Synthetic model preservation marker; not an ASR model.'},
    @{path=(Join-Path $media 'media-preservation-fixture.txt'); content='Synthetic user media preservation marker; not a video.'}
  )
  foreach ($fixture in $fixtures) { [IO.File]::WriteAllText($fixture.path,$fixture.content,[Text.UTF8Encoding]::new($false)) }
  $before = @{}
  foreach ($fixture in $fixtures) { $before[$fixture.path]=(Get-FileHash -LiteralPath $fixture.path -Algorithm SHA256).Hash }
  Install-Candidate $CandidateInstaller
  $receipt.installedVersion=(Get-Item -LiteralPath $main).VersionInfo.ProductVersion
  if ($receipt.installedVersion -ne $CandidateVersion) { throw 'Candidate installer did not upgrade the application.' }
  foreach ($fixture in $fixtures) {
    if ((Get-FileHash -LiteralPath $fixture.path -Algorithm SHA256).Hash -ne $before[$fixture.path]) {
      throw "Existing data was changed: $([IO.Path]::GetFileName($fixture.path))"
    }
    $receipt.preservedFiles += [IO.Path]::GetFileName($fixture.path)
  }
  $manifests=@(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter 'runtime-manifest.json')
  if ($manifests.Count -ne 1) { throw 'Installed runtime manifest is missing or duplicated.' }
  $manifest=Get-Content -LiteralPath $manifests[0].FullName -Raw | ConvertFrom-Json
  $runtimeCount=0
  foreach ($property in $manifest.files.PSObject.Properties) {
    $path=Join-Path $manifests[0].DirectoryName $property.Name
    if ((Get-Item -LiteralPath $path).Length -ne $property.Value.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value.sha256) {
      throw "Installed runtime mismatch: $($property.Name)"
    }
    $runtimeCount++
  }
  $receipt.installedRuntimeFilesVerified=$runtimeCount
  $receipt.modelLocationPreserved=$true
  $receipt.passed=$true
} catch {
  $receipt.error=$_.Exception.Message
  throw
} finally {
  $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReceiptPath -Encoding utf8NoBOM
  $receipt | ConvertTo-Json -Depth 6 | Write-Output
}

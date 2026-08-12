# ClaudeDeck の配布物を作る。
#
# やることは4つ。
#   1. node.exe を公式から取ってくる（版は固定。ハッシュで中身を確かめる）
#   2. C# ランチャを publish して、アプリ本体を並べる
#   3. vpk で Setup.exe と更新パッケージを作る
#   4. GitHub Releases へ上げる
#
# 版の出どころは package.json の version ただ1つ。
# このスクリプトにも .csproj にも書き写さない。写すと必ず片方が古くなる。
#
# 既定の -Action は pack。3番までで止まり、外へは何も出さない。
# うっかり叩いても GitHub に上がらないようにしてある。
# 公開するときだけ -Action all（または upload）を明示する。
#
# このファイルは UTF-8 BOM 付きで保存すること。BOM を外すと動かなくなる。
# 旧 powershell.exe (5.1) は BOM が無いとファイルを OS の既定コードページで読むため、
# 日本語コメントが化けて構文解析まで壊れる。pwsh (7) は BOM 無しでも通るので気づきにくい。
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Action stage
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Action all
#
# 事前に要るもの:
#   dotnet SDK 10 以降
#   vpk  … dotnet tool install -g vpk
#   gh   … upload のときだけ。認証を済ませておくこと
[CmdletBinding()]
param(
  [ValidateSet('fetch-node', 'stage', 'pack', 'upload', 'all')]
  [string]$Action = 'pack'
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.3 以降は、外部コマンドが非ゼロで終了すると $ErrorActionPreference に従って
# 例外になる。ここでは終了コードを自分で見て、どのコマンドが何番で落ちたかを日本語で出したい。
# この変数が無い版（5.1）では何もしない。
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

# ---- 変えてはいけない値 ----

# node の版はここでだけ決める。パラメータにしない。
# 引数で渡せる形にすると、ビルドした人のその日の気分で配布物の中身が変わる。
# 版を上げるのは意図した1行のコミットであるべきもの。
#
# 22 系（LTS）を使う。package.json の engines は >=18 で、
# 使っているのは fetch / AbortSignal.timeout / node:test なので 22 で足りる。
$NODE_VERSION = '22.23.2'

# 上の版の zip の SHA256。公式の SHASUMS256.txt から取ってここへ焼いた。
#
# 落としたものを、公式の一覧と、この焼いた値の両方に照合する。
# 一覧だけを信じると、一覧ごと差し替えられたときに気づけない。
# 焼いた値だけだと、こちらの写し間違いに気づけない。
# 両方に合うことを求めれば、どちらの事故も入口で止まる。
$NODE_SHA256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'

# Velopack の packId。
#
# ClaudeDeck にしてはいけない。
# インストール先が %LocalAppData%\<packId> になるので、
# データの置き場所 %LOCALAPPDATA%\ClaudeDeck\ とまるかぶりになる。
# アンインストールで config.json（生の Slack Webhook 入り）が黙って消える。
$PACK_ID = 'ClaudeDeckApp'

# 人の目に触れる名前。スタートメニューやショートカットに出る
$PACK_TITLE = 'ClaudeDeck'
$PACK_AUTHORS = 'iyotaA'
$MAIN_EXE = 'ClaudeDeck.exe'
$REPO_URL = 'https://github.com/iyotaA/claude-deck'

# 配布物に入れるもの。除外リストではなく許可リストで持つ。
#
# 除外リストは黙って古くなる。assets/ を除外していても、
# 次に足した大きなフォルダは素通りする。
# 許可リストなら、足し忘れたときにアプリが起動せず、その場で分かる。
#
# ここに無いもの（assets/ test/ launcher/ ClaudeDeck.cmd autostart.*）は入らない。
$APP_INCLUDE = @(
  'server.mjs',
  'cli.mjs',
  'package.json',
  'README.md',
  'src',
  'public',
  'scripts\focus.ps1',             # 実行時に src/os/focus.mjs が呼ぶ。無いと窓の前面化が死ぬ
  'docs\slack-webhook-setup.html'  # README から案内している
)

# ---- 置き場所 ----

$repoRoot = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $repoRoot 'build'
$cacheDir = Join-Path $buildDir 'cache'        # 落とした zip と取り出した node.exe
$stageDir = Join-Path $buildDir 'stage'        # vpk に渡すフォルダ
$releasesDir = Join-Path $buildDir 'releases'  # Setup.exe と nupkg

# ---- 表示 ----

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Note([string]$Text) {
  Write-Host "    $Text"
}

function Write-Warn([string]$Text) {
  Write-Host "    ! $Text" -ForegroundColor Yellow
}

# 途中でやめる。理由を必ず書く
function Stop-Release([string]$Reason) {
  Write-Host ''
  Write-Host "中止: $Reason" -ForegroundColor Red
  Write-Host ''
  exit 1
}

# ---- 外部コマンド ----

# 表示用の1行を作る。トークンは伏せる。
#
# GitHub のトークンを画面にも記録にも出さない。
# Webhook の URL をマスクしてから返すのと同じ考え方で、
# 伏せるのを呼ぶ側の心がけに任せない。
function Format-ToolLine([string]$FilePath, [string[]]$ToolArgs, [string[]]$Secrets) {
  $shown = @($ToolArgs)
  foreach ($secret in $Secrets) {
    if ($secret) {
      $shown = @($shown | ForEach-Object { $_ -replace [regex]::Escape($secret), '***' })
    }
  }
  return "$FilePath $($shown -join ' ')"
}

# 外部のコマンドを呼ぶ。失敗したらそこで止める。
#
# $ErrorActionPreference は exe の失敗を捕まえない（上で明示的に切ってもいる）。
# 終了コードを見ないと、失敗したのに次の工程へ進んで「できたように見える」形になる。
function Invoke-Tool([string]$FilePath, [string[]]$ToolArgs, [string[]]$Secrets = @()) {
  Write-Note (Format-ToolLine $FilePath $ToolArgs $Secrets)
  & $FilePath @ToolArgs
  if ($LASTEXITCODE -ne 0) {
    Stop-Release "$FilePath が失敗しました（終了コード $LASTEXITCODE）"
  }
}

function Assert-Tool([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Stop-Release "$Name が見つかりません。$Hint"
  }
}

# gh が持っているトークンを借りる。無ければ null。
#
# 読み取り（前の版の取り込み）は public リポジトリなので無くても通る。
# ただし未認証だと GitHub の呼び出し回数の上限が厳しいので、あれば使う。
function Get-GitHubToken {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $null }
  $token = & gh auth token 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  if (-not $token) { return $null }
  return "$token".Trim()
}

# ---- 版 ----

# package.json から版を読む。ここが唯一の読み手
function Get-AppVersion {
  $path = Join-Path $repoRoot 'package.json'
  if (-not (Test-Path $path)) { Stop-Release "package.json が見つかりません: $path" }

  $json = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $version = $json.version
  if (-not $version) { Stop-Release 'package.json に version がありません' }

  # 形だけ確かめる。ここを通さないと、打ち間違いがそのまま Setup.exe の名前になる
  if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.\-]+)?$') {
    Stop-Release "version の形が SemVer ではありません: $version"
  }
  return "$version"
}

# ---- 1. node を用意する ----

function Invoke-FetchNode {
  Write-Step "node v$NODE_VERSION を用意します"

  $zipName = "node-v$NODE_VERSION-win-x64.zip"
  $zipUrl = "https://nodejs.org/dist/v$NODE_VERSION/$zipName"
  $zipPath = Join-Path $cacheDir $zipName
  $nodeExe = Join-Path $cacheDir 'node.exe'

  New-Item -ItemType Directory -Force $cacheDir | Out-Null

  if (Test-Path $zipPath) {
    # 版が固定なので、いちど確かめたものは使い回してよい。
    # 中身の照合はこの後で必ず通るので、壊れていればそこで止まる
    Write-Note "取得済みのものを使います: $zipName"
  }
  else {
    # 落とす前に公式の一覧と突き合わせる。食い違うならここで終わり、34MB を無駄にしない
    Write-Note '公式の SHASUMS256.txt と突き合わせています'
    $sums = Invoke-RestMethod "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -TimeoutSec 120
    $line = @($sums -split "`n") | Where-Object { $_ -match ([regex]::Escape($zipName) + '\s*$') } | Select-Object -First 1
    if (-not $line) { Stop-Release "公式の一覧に $zipName がありません" }

    $official = (@($line -split '\s+')[0]).ToLowerInvariant()
    if ($official -ne $NODE_SHA256) {
      Stop-Release @"
公式の SHASUMS256.txt と、このスクリプトに焼いた値が食い違います。
         公式 $official
         焼値 $NODE_SHA256
         版を上げたのなら `$NODE_SHA256 も一緒に直してください。
         身に覚えが無いなら、落とさずに調べてください。
"@
    }
    Write-Note '公式の一覧と一致しました'

    Write-Note "落としています: $zipUrl （34MB ほど）"
    # 進捗の表示を切る。5.1 では進捗を描くだけで何倍も遅くなる
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
      Invoke-WebRequest $zipUrl -OutFile $zipPath -TimeoutSec 600
    }
    finally {
      $ProgressPreference = $prevProgress
    }
  }

  Write-Note '中身を確かめています'
  $actual = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $NODE_SHA256) {
    # 壊れたものを残すと、次回「取得済み」として使ってしまう
    Remove-Item $zipPath -Force
    Stop-Release @"
落としたものが期待と違います（消しました）。
         期待 $NODE_SHA256
         実際 $actual
"@
  }
  Write-Note "SHA256: $actual"

  # 要るのは node.exe 1つだけ。zip 全体を展開すると要らないものが散らかる
  if (-not (Test-Path $nodeExe)) {
    Write-Note 'node.exe を取り出しています'
    try { Add-Type -AssemblyName System.IO.Compression.FileSystem } catch { }

    $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
      $entryName = "node-v$NODE_VERSION-win-x64/node.exe"
      $entry = @($zip.Entries | Where-Object { $_.FullName -eq $entryName }) | Select-Object -First 1
      if (-not $entry) { Stop-Release "zip の中に $entryName がありません" }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $nodeExe, $true)
    }
    finally {
      $zip.Dispose()
    }
  }

  # 取り出したものが本当に動く node か、その場で確かめる。
  # ここを飛ばすと、壊れているのに配布物ができあがってしまう
  $reported = (& $nodeExe --version 2>$null)
  if ($LASTEXITCODE -ne 0) { Stop-Release '取り出した node.exe が動きません' }
  if ("$reported".Trim() -ne "v$NODE_VERSION") {
    Stop-Release "取り出した node.exe の版が違います（$reported）"
  }

  $mb = (Get-Item $nodeExe).Length / 1MB
  Write-Note ('用意できました: {0}  {1:N1} MB' -f "$reported".Trim(), $mb)
}

# ---- 2. 配布物を組み立てる ----

function Invoke-Stage([string]$Version) {
  Write-Step "配布物を組み立てます（版 $Version）"

  # 毎回まっさらにする。前回の残りが混ざると、消したはずのファイルが配布物に残る
  if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
  New-Item -ItemType Directory -Force $stageDir | Out-Null

  # ランチャ。publish を先に走らせる。後から置く runtime\ と app\ を巻き込ませないため
  Invoke-Tool 'dotnet' @(
    'publish',
    (Join-Path $repoRoot 'launcher\ClaudeDeck.csproj'),
    '-c', 'Release',
    '-o', $stageDir,
    "-p:Version=$Version",
    '--nologo'
  )

  $mainExePath = Join-Path $stageDir $MAIN_EXE
  if (-not (Test-Path $mainExePath)) { Stop-Release "$MAIN_EXE ができていません" }

  # node。fetch-node が確かめたものを置く
  $nodeExe = Join-Path $cacheDir 'node.exe'
  if (-not (Test-Path $nodeExe)) {
    Stop-Release 'node.exe がありません。先に -Action fetch-node を走らせてください'
  }
  $runtimeDir = Join-Path $stageDir 'runtime'
  New-Item -ItemType Directory -Force $runtimeDir | Out-Null
  Copy-Item $nodeExe (Join-Path $runtimeDir 'node.exe') -Force

  # アプリ本体。
  # 相対の並びを崩さない。server.mjs は here/public を、
  # src/os/focus.mjs は ../../scripts/focus.ps1 を見ているので、
  # ここを崩すと実行するまで気づけない形で壊れる
  $appDir = Join-Path $stageDir 'app'
  New-Item -ItemType Directory -Force $appDir | Out-Null
  foreach ($rel in $APP_INCLUDE) {
    $src = Join-Path $repoRoot $rel
    if (-not (Test-Path $src)) {
      Stop-Release "配布物に入れるはずのものがありません: $rel"
    }
    $dest = Join-Path $appDir $rel
    $destParent = Split-Path -Parent $dest
    if (-not (Test-Path $destParent)) { New-Item -ItemType Directory -Force $destParent | Out-Null }
    Copy-Item $src $dest -Recurse -Force
  }

  # 何が入ったか出す。publish が思わぬものを吐いていないか、ここで目に入る
  Write-Note '中身:'
  $total = 0
  foreach ($item in @(Get-ChildItem $stageDir | Sort-Object { -not $_.PSIsContainer }, Name)) {
    if ($item.PSIsContainer) {
      $files = @(Get-ChildItem $item.FullName -Recurse -File)
      $size = ($files | Measure-Object -Property Length -Sum).Sum
      if (-not $size) { $size = 0 }
      Write-Host ('      {0,-24} {1,6} 件 {2,8:N1} MB' -f "$($item.Name)\", $files.Count, ($size / 1MB))
    }
    else {
      $size = $item.Length
      Write-Host ('      {0,-24} {1,6}    {2,8:N1} MB' -f $item.Name, '', ($size / 1MB))
    }
    $total += $size
  }
  Write-Note ('合計 {0:N1} MB' -f ($total / 1MB))
}

# ---- 3. パッケージを作る ----

function Invoke-Pack([string]$Version) {
  Write-Step "パッケージを作ります（版 $Version）"

  # 毎回まっさらにする。stage と同じ理由。
  #
  # 残っていると vpk が「同じかそれ以上の版が既にある」と言って断る（実測）。
  # 仮に通せたとしても、今回作っていない版が releases.win.json に載ったまま
  # upload されることになる。
  # 前の版はこのすぐ後で vpk download github が取り直すので、消して困らない。
  if (Test-Path $releasesDir) { Remove-Item $releasesDir -Recurse -Force }
  New-Item -ItemType Directory -Force $releasesDir | Out-Null

  # 前の版を取り込む。
  # 無いと差分（delta）が作れず、更新のたびに丸ごと落とすことになる。
  # 初回はまだ何も上がっていないので、失敗しても止めない
  Write-Note '前の版を探しています'
  $token = Get-GitHubToken
  $downloadArgs = @('download', 'github', '--repoUrl', $REPO_URL, '--outputDir', $releasesDir)
  if ($token) { $downloadArgs += @('--token', $token) }

  Write-Note (Format-ToolLine 'vpk' $downloadArgs @($token))
  & vpk @downloadArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Warn '前の版が取れませんでした。今回は丸ごと1本になります（初回ならこれで正しい）'
  }

  Invoke-Tool 'vpk' @(
    'pack',
    '--packId', $PACK_ID,
    '--packTitle', $PACK_TITLE,
    '--packAuthors', $PACK_AUTHORS,
    '--packVersion', $Version,
    '--packDir', $stageDir,
    '--mainExe', $MAIN_EXE,
    '--icon', (Join-Path $repoRoot 'public\favicon.ico'),
    '--outputDir', $releasesDir
  )
}

# ---- 4. 上げる ----

# 外へ出す前の確認。ここを通らないものは公開しない
function Assert-ReadyToUpload([string]$Version) {
  Write-Step '外へ出す前の確認'

  $dirty = @(git -C $repoRoot status --porcelain)
  if ($dirty.Count -gt 0) {
    Stop-Release "作業ツリーに未コミットの変更が $($dirty.Count) 件あります。先にコミットしてください"
  }
  Write-Note '作業ツリー: きれい'

  # push してあるか。していないと、タグだけが先にリモートへ付いて中身が無い状態になる
  $contains = @(git -C $repoRoot branch -r --contains HEAD)
  if ($contains.Count -eq 0) {
    Stop-Release 'いまの HEAD がリモートにありません。先に push してください'
  }
  Write-Note "HEAD: push 済み（$($contains[0].Trim())）"

  $tag = "v$Version"
  if (@(git -C $repoRoot tag -l $tag).Count -gt 0) {
    Stop-Release "タグ $tag が手元に既にあります。package.json の version を上げてください"
  }

  $remoteTag = @(git -C $repoRoot ls-remote --tags origin "refs/tags/$tag")
  # 通信に失敗したときに「タグは無い」と読み違えない。無いことの確認は、確認できたときだけ成り立つ
  if ($LASTEXITCODE -ne 0) { Stop-Release 'リモートのタグを確認できませんでした（通信の失敗）' }
  if ($remoteTag.Count -gt 0) {
    Stop-Release "タグ $tag がリモートに既にあります。package.json の version を上げてください"
  }
  # ${} で囲む。$tag: と書くと「スコープ付きの変数」と読まれて構文ごと壊れる
  Write-Note "タグ ${tag}: まだ使われていない"
}

function Invoke-Upload([string]$Version) {
  Write-Step "GitHub Releases へ上げます（版 $Version）"

  $token = Get-GitHubToken
  if (-not $token) {
    Stop-Release 'GitHub のトークンが取れません。gh auth login を済ませてください'
  }

  # タグを HEAD に付ける。既定はリポジトリの既定ブランチなので、
  # 別のブランチから上げたときに中身とタグがずれる
  $commit = "$(git -C $repoRoot rev-parse HEAD)".Trim()

  Invoke-Tool 'vpk' @(
    'upload', 'github',
    '--repoUrl', $REPO_URL,
    '--outputDir', $releasesDir,
    '--publish',
    '--tag', "v$Version",
    '--releaseName', "v$Version",
    '--targetCommitish', $commit,
    '--token', $token
  ) @($token)

  Write-Note "上がりました: $REPO_URL/releases/tag/v$Version"
}

# ---- できたものを見せる ----

function Show-Output {
  Write-Step 'できたもの'
  if (-not (Test-Path $releasesDir)) { Write-Warn '何もありません'; return }

  $items = @(Get-ChildItem $releasesDir -File | Sort-Object Name)
  if ($items.Count -eq 0) { Write-Warn '何もありません'; return }

  foreach ($item in $items) {
    Write-Host ('      {0,-48} {1,8:N1} MB' -f $item.Name, ($item.Length / 1MB))
  }
  Write-Host ''
  Write-Note "置き場所: $releasesDir"
}

# ---- ここから本体 ----

$version = Get-AppVersion

Write-Host ''
Write-Host "  ClaudeDeck $version  （-Action $Action）" -ForegroundColor Green
Write-Note '版の出どころ: package.json'

switch ($Action) {
  'fetch-node' {
    Invoke-FetchNode
  }
  'stage' {
    Assert-Tool 'dotnet' 'https://dotnet.microsoft.com/download から SDK 10 以降を入れてください'
    Invoke-FetchNode
    Invoke-Stage $version
  }
  'pack' {
    Assert-Tool 'dotnet' 'https://dotnet.microsoft.com/download から SDK 10 以降を入れてください'
    Assert-Tool 'vpk' 'dotnet tool install -g vpk'
    Invoke-FetchNode
    Invoke-Stage $version
    Invoke-Pack $version
    Show-Output
  }
  'upload' {
    Assert-Tool 'vpk' 'dotnet tool install -g vpk'
    Assert-Tool 'gh' 'https://cli.github.com から入れて gh auth login を済ませてください'
    Assert-ReadyToUpload $version
    Invoke-Upload $version
  }
  'all' {
    Assert-Tool 'dotnet' 'https://dotnet.microsoft.com/download から SDK 10 以降を入れてください'
    Assert-Tool 'vpk' 'dotnet tool install -g vpk'
    Assert-Tool 'gh' 'https://cli.github.com から入れて gh auth login を済ませてください'
    # 先に確認する。作ってから断られるより、作る前に断られるほうがよい
    Assert-ReadyToUpload $version
    Invoke-FetchNode
    Invoke-Stage $version
    Invoke-Pack $version
    Show-Output
    Invoke-Upload $version
  }
}

Write-Host ''
Write-Host '  終わりました' -ForegroundColor Green
Write-Host ''

# ClaudeDeck を Windows のログオン時に自動で起動させる設定をする。
#
# 管理者権限は使わない。
# タスクスケジューラは登録に管理者権限が必要なので、自分用のスタートアップ
# フォルダーにショートカットを置く方式にしている。配布先でもそのまま設定できる。
#
# ショートカットは autostart.mjs を指す。
# autostart.mjs がサーバーを窓なしで起動するので、ログオンのたびに黒い窓が出ない。
#
# このファイルは UTF-8 BOM 付きで保存すること。BOM を外すと動かなくなる。
# 旧 powershell.exe (5.1) は BOM が無いとファイルを OS の既定コードページで読むため、
# 日本語コメントが化けて構文解析まで壊れる。pwsh (7) は BOM 無しでも通るので気づきにくい。
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action status
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action uninstall
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status', 'start', 'stop')]
  [string]$Action = 'install',
  [int]$Port = 4317
)

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$bootstrap = Join-Path $PSScriptRoot 'autostart.mjs'
$startupDir = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startupDir 'ClaudeDeck.lnk'
$logFile = Join-Path $env:LOCALAPPDATA 'ClaudeDeck\autostart.log'

# node の置き場所。ログオン時は PATH が違うことがあるので、絶対パスに直して埋め込む
function Resolve-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  if ($cmd.Source) { return $cmd.Source }
  return $cmd.Path
}

# サーバーが応答するかを尋ねる。応答すれば中身を返す
function Get-DeckHealth([int]$OnPort) {
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:$OnPort/api/health" -UseBasicParsing -TimeoutSec 2
    return ($res.Content | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# そのポートで待ち受けているプロセスを探す
function Get-ListenerProcess([int]$OnPort) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $OnPort -State Listen -ErrorAction Stop
    if (-not $conn) { return $null }
    $owner = @($conn)[0].OwningProcess
    return Get-Process -Id $owner -ErrorAction SilentlyContinue
  } catch {
    return $null
  }
}

switch ($Action) {

  'install' {
    $node = Resolve-NodeExe
    if (-not $node) {
      Write-Host 'node が見つかりません。Node.js 18 以降を入れてから、もう一度実行してください。'
      exit 1
    }
    if (-not (Test-Path $bootstrap)) {
      Write-Host "起動用のファイルが見つかりません: $bootstrap"
      exit 1
    }

    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($linkPath)
    $lnk.TargetPath = $node
    $lnk.Arguments = '"' + $bootstrap + '"'
    $lnk.WorkingDirectory = $appDir
    # 7 は最小化。この窓はすぐ閉じるが、一瞬でも前に出ないようにする
    $lnk.WindowStyle = 7
    $lnk.Description = 'ClaudeDeck をログオン時に裏で起動する'
    # スタートアップの一覧に node の絵が並ぶと何のことか分からないので、アイコンを付ける。
    # ショートカットは .ico しか読めないため、png ではなくこちらを指す
    $icon = Join-Path $appDir 'public\favicon.ico'
    if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Save()

    Write-Host '自動起動を設定しました。'
    Write-Host "  置いた場所: $linkPath"
    Write-Host "  起動するもの: $node `"$bootstrap`""
    Write-Host ''
    Write-Host '次のログオンから、サーバーが裏で立ち上がります。'
    Write-Host "画面を見るときは http://127.0.0.1:$Port/ を開いてください。"
    Write-Host ''
    Write-Host 'いま試すなら   : -Action start'
    Write-Host '状態を見るなら : -Action status'
    Write-Host 'やめるなら     : -Action uninstall'
    Write-Host ''
    Write-Host 'このフォルダーを移動したら、移動後にもう一度実行してください。'
  }

  'uninstall' {
    if (Test-Path $linkPath) {
      Remove-Item $linkPath -Force
      Write-Host '自動起動をやめました。'
      Write-Host "  消した場所: $linkPath"
    } else {
      Write-Host '自動起動は設定されていません。'
    }
    Write-Host 'いま動いているサーバーはそのまま残ります。止めるなら -Action stop を使ってください。'
  }

  'start' {
    $node = Resolve-NodeExe
    if (-not $node) {
      Write-Host 'node が見つかりません。'
      exit 1
    }
    & $node $bootstrap
  }

  'stop' {
    $proc = Get-ListenerProcess $Port
    if (-not $proc) {
      Write-Host "ポート $Port で待ち受けているものはありません。"
      exit 0
    }
    if ($proc.ProcessName -ne 'node') {
      Write-Host "ポート $Port を使っているのは node ではありません（$($proc.ProcessName) / PID $($proc.Id)）。"
      Write-Host '取り違えを避けるため、何もしませんでした。'
      exit 1
    }
    Stop-Process -Id $proc.Id -Force
    Write-Host "止めました（PID $($proc.Id)）。"
  }

  'status' {
    Write-Host '■ 自動起動の設定'
    if (Test-Path $linkPath) {
      $shell = New-Object -ComObject WScript.Shell
      $lnk = $shell.CreateShortcut($linkPath)
      Write-Host '  設定されています'
      Write-Host "  ショートカット: $linkPath"
      Write-Host "  起動するもの  : $($lnk.TargetPath) $($lnk.Arguments)"
      if ($lnk.Arguments -notlike "*$bootstrap*") {
        Write-Host '  ※ 別の場所のフォルダーを指しています。ここで設定し直すなら -Action install'
      }
    } else {
      Write-Host '  設定されていません（-Action install で設定できます）'
    }

    Write-Host ''
    Write-Host '■ いまの状態'
    $health = Get-DeckHealth $Port
    if ($health) {
      Write-Host "  動いています  : http://127.0.0.1:$Port/"
      Write-Host "  読み取り元    : $($health.configDir)"
      Write-Host "  つないでいる窓: $($health.clients)"
      $proc = Get-ListenerProcess $Port
      if ($proc) { Write-Host "  PID           : $($proc.Id)" }
    } else {
      Write-Host "  ポート $Port では動いていません"
    }

    Write-Host ''
    Write-Host '■ 記録'
    if (Test-Path $logFile) {
      Write-Host "  $logFile"
      # node が UTF-8 で書くので、読むときも UTF-8 を指定する。
      # 旧 powershell.exe は既定で OS のコードページで読み、日本語が化ける
      Get-Content $logFile -Tail 5 -Encoding UTF8 | ForEach-Object { Write-Host "  | $_" }
    } else {
      Write-Host '  まだありません（裏で起動したときに作られます）'
    }
  }
}

# 指定した PID の Claude Code が動いているターミナルの窓を前面に出す。
#
# Claude Code 自体は node のプロセスで、窓を持たない。
# そのため親をたどって、窓を持っている祖先（ターミナル）を探す。
#
# このファイルは UTF-8 BOM 付きで保存すること。BOM を外すと動かなくなる。
# 旧 powershell.exe (5.1) は BOM が無いとファイルを OS の既定コードページで読むため、
# 日本語コメントが化けて構文解析まで壊れる。pwsh (7) は BOM 無しでも通るので気づきにくい。
param([Parameter(Mandatory = $true)][int]$TargetPid)

$ErrorActionPreference = 'Stop'

function Find-WindowOwner([int]$StartPid) {
  $current = $StartPid
  for ($i = 0; $i -lt 8; $i++) {
    $proc = Get-Process -Id $current -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { return $proc }

    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
    if (-not $info -or -not $info.ParentProcessId) { return $null }
    $current = [int]$info.ParentProcessId
  }
  return $null
}

$owner = Find-WindowOwner -StartPid $TargetPid
if (-not $owner) {
  Write-Output 'NOWINDOW'
  exit 2
}

Add-Type -Namespace Deck -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@

$hwnd = $owner.MainWindowHandle
# 最小化されていると前面化しても見えないので、先に元の大きさへ戻す（9 = SW_RESTORE）
if ([Deck.Win]::IsIconic($hwnd)) { [Deck.Win]::ShowWindow($hwnd, 9) | Out-Null }

$ok = [Deck.Win]::SetForegroundWindow($hwnd)
if (-not $ok) {
  # 裏で動いているプロセスからの前面化は OS に制限されることがある。COM 経由でもう一度試す
  try {
    (New-Object -ComObject WScript.Shell).AppActivate($owner.Id) | Out-Null
    $ok = $true
  } catch {
    $ok = $false
  }
}

if ($ok) {
  Write-Output "OK $($owner.ProcessName) $($owner.Id)"
} else {
  Write-Output 'FAILED'
  exit 3
}

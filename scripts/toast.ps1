# Windows の通知（トースト）を1枚出す。src/os/toast.mjs が呼ぶ。
#
# 本文の XML は base64 で受け取る。標準入力や素の引数で渡すと、
# Windows PowerShell 5.1 は OEM の既定コードページで読むので日本語が化ける。
# 何を出すかは Node 側（src/notify/toast.mjs）が決める。ここは出すだけ。
#
# AppId は通知の差出人。ランチャが登録した 'ClaudeDeck' か、
# ランチャが無いとき（npm start）に借りる Windows PowerShell のもの。
# 登録の無い AppId で出したトーストは、Windows が何も言わずに捨てる。
#
# このファイルは UTF-8 BOM 付きで保存すること。BOM を外すと動かなくなる。
# 旧 powershell.exe (5.1) は BOM が無いとファイルを OS の既定コードページで読むため、
# 日本語コメントが化けて構文解析まで壊れる。pwsh (7) は BOM 無しでも通るので気づきにくい。
param(
  [Parameter(Mandatory = $true)][string]$XmlB64,
  [Parameter(Mandatory = $true)][string]$AppId
)

$ErrorActionPreference = 'Stop'

try {
  $xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($XmlB64))

  # WinRT の型を読み込む。Windows PowerShell 5.1 の書き方（pwsh 7 では使えない）
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  Write-Output 'OK'
  exit 0
} catch {
  Write-Output "NG $($_.Exception.Message)"
  exit 1
}

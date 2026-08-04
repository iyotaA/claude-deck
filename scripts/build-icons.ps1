# assets\favicon.png から、ブラウザ用のアイコンを焼き出す。
#
# 元絵は 1270px あり、周りに透明な余白と影が付いている。
# そのまま貼るとタブの 16px では中身が小さく潰れるので、オレンジの四角だけを
# 切り出してから縮める。縮小はブラウザに任せず、ここで作った絵を渡す。
#
# 出るもの:
#   public\favicon.ico      16 / 32 / 48 をまとめたもの。タブと Windows のショートカット用
#   public\favicon-192.png  大きく出る場所（アプリとして入れたとき）用
#
# 元絵を差し替えたら、これを実行し直せば作り直せる。
#
# このファイルは UTF-8 BOM 付きで保存すること。BOM を外すと動かなくなる。
# 旧 powershell.exe (5.1) は BOM が無いとファイルを OS の既定コードページで読むため、
# 日本語コメントが化けて構文解析まで壊れる。pwsh (7) は BOM 無しでも通るので気づきにくい。
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\build-icons.ps1
[CmdletBinding()]
param(
  [string]$Source = '',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$appDir = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = Join-Path $appDir 'assets\favicon.png' }
if (-not $OutDir) { $OutDir = Join-Path $appDir 'public' }

if (-not (Test-Path $Source)) {
  Write-Host "元の画像が見つかりません: $Source"
  exit 1
}

# 画素を1つずつ見る処理は PowerShell だと遅すぎるため、C# 側で回す
$code = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class DeckIcon
{
  /// 絵の本体（色の付いた四角）の範囲を返す。透明な余白と、下に伸びる影は外す。
  ///
  /// 影は灰色なので、赤と青の差が小さい。そこで色みのある画素だけを数える。
  /// 中の白い部分は数えないが、外側の枠が色付きなので範囲は変わらない。
  public static int[] FindArt(string path, out int imgW, out int imgH)
  {
    using (Bitmap src = new Bitmap(path))
    {
      imgW = src.Width;
      imgH = src.Height;
      int left = src.Width, top = src.Height, right = -1, bottom = -1;

      BitmapData data = src.LockBits(new Rectangle(0, 0, src.Width, src.Height),
        ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try
      {
        int stride = data.Stride;
        byte[] buf = new byte[stride * src.Height];
        System.Runtime.InteropServices.Marshal.Copy(data.Scan0, buf, 0, buf.Length);

        for (int y = 0; y < src.Height; y++)
        {
          int row = y * stride;
          for (int x = 0; x < src.Width; x++)
          {
            int i = row + x * 4;            // BGRA の順で並んでいる
            if (buf[i + 3] < 200) continue; // ほぼ透明。余白
            if (buf[i + 2] - buf[i] < 60) continue; // 赤と青が近い。影か白い部分
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }
      finally { src.UnlockBits(data); }

      if (right < left || bottom < top) return new int[] { 0, 0, imgW, imgH };
      return new int[] { left, top, right - left + 1, bottom - top + 1 };
    }
  }

  /// 切り出した範囲を正方形に整える。縦横比を変えずに縮めたいので、短い側を広げる。
  public static int[] Squarify(int[] box, int imgW, int imgH)
  {
    int x = box[0], y = box[1], w = box[2], h = box[3];
    int side = Math.Max(w, h);
    x -= (side - w) / 2;
    y -= (side - h) / 2;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + side > imgW) x = imgW - side;
    if (y + side > imgH) y = imgH - side;
    if (side > imgW) { x = 0; side = imgW; }
    if (side > imgH) { y = 0; side = imgH; }
    return new int[] { x, y, side, side };
  }

  /// 指定の範囲を、指定の大きさの PNG にして書き出す。
  public static void WritePng(string src, string dest, int[] box, int size)
  {
    using (Bitmap from = new Bitmap(src))
    using (Bitmap to = new Bitmap(size, size, PixelFormat.Format32bppArgb))
    {
      using (Graphics g = Graphics.FromImage(to))
      {
        g.CompositingMode = CompositingMode.SourceCopy;
        g.CompositingQuality = CompositingQuality.HighQuality;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.SmoothingMode = SmoothingMode.HighQuality;

        using (ImageAttributes attr = new ImageAttributes())
        {
          // 端の画素が外側と混ざって、輪郭に薄い線が出るのを防ぐ
          attr.SetWrapMode(WrapMode.TileFlipXY);
          g.DrawImage(from, new Rectangle(0, 0, size, size),
            box[0], box[1], box[2], box[3], GraphicsUnit.Pixel, attr);
        }
      }
      to.Save(dest, ImageFormat.Png);
    }
  }

  /// PNG を並べて .ico にまとめる。Vista 以降と各ブラウザは PNG 入りの ico を読める。
  public static void WriteIco(string[] pngPaths, string dest)
  {
    List<byte[]> blobs = new List<byte[]>();
    List<int> sides = new List<int>();
    foreach (string p in pngPaths)
    {
      blobs.Add(File.ReadAllBytes(p));
      using (Bitmap b = new Bitmap(p)) sides.Add(b.Width);
    }

    using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write))
    using (BinaryWriter w = new BinaryWriter(fs))
    {
      w.Write((short)0);              // 予約
      w.Write((short)1);              // 種類。1 はアイコン
      w.Write((short)blobs.Count);

      int offset = 6 + 16 * blobs.Count;
      for (int i = 0; i < blobs.Count; i++)
      {
        int side = sides[i];
        w.Write((byte)(side >= 256 ? 0 : side));  // 256 は 0 で表す決まり
        w.Write((byte)(side >= 256 ? 0 : side));
        w.Write((byte)0);             // 色数。フルカラーは 0
        w.Write((byte)0);             // 予約
        w.Write((short)1);            // 面数
        w.Write((short)32);           // 1画素あたりのビット数
        w.Write(blobs[i].Length);
        w.Write(offset);
        offset += blobs[i].Length;
      }
      foreach (byte[] b in blobs) w.Write(b);
    }
  }
}
'@

if (-not ('DeckIcon' -as [type])) {
  Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Drawing'
}

$imgW = 0
$imgH = 0
$box = [DeckIcon]::FindArt($Source, [ref]$imgW, [ref]$imgH)
Write-Host "元の画像: $Source ($imgW x $imgH)"
Write-Host "  中身の範囲: 左=$($box[0]) 上=$($box[1]) 幅=$($box[2]) 高=$($box[3])"

$box = [DeckIcon]::Squarify($box, $imgW, $imgH)
Write-Host "  正方形に整えた: 左=$($box[0]) 上=$($box[1]) 一辺=$($box[2])"

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$temp = Join-Path $env:TEMP 'claude-deck-icons'
New-Item -ItemType Directory -Path $temp -Force | Out-Null

# ico に入れる分。小さい側から順に並べる
$icoSizes = @(16, 32, 48)
$icoFiles = @()
foreach ($s in $icoSizes) {
  $f = Join-Path $temp "icon-$s.png"
  [DeckIcon]::WritePng($Source, $f, $box, $s)
  $icoFiles += $f
}

$icoPath = Join-Path $OutDir 'favicon.ico'
[DeckIcon]::WriteIco($icoFiles, $icoPath)
Write-Host "  書き出し: $icoPath ($($icoSizes -join ' / ') px)"

$pngPath = Join-Path $OutDir 'favicon-192.png'
[DeckIcon]::WritePng($Source, $pngPath, $box, 192)
Write-Host "  書き出し: $pngPath (192 px)"

Remove-Item $temp -Recurse -Force
Write-Host 'できました。'

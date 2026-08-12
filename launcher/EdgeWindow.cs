using System.Diagnostics;
using Microsoft.Win32;

namespace ClaudeDeck;

/// <summary>
/// 画面を出す。
///
/// Edge のアプリモード（--app）を使う。アドレスバーもタブも出ないので、
/// 「ブラウザで開いたページ」ではなく「アプリの窓」に見える。
/// WebView2 を抱えるより軽く、依存も増えない。
///
/// Edge が見つからないときは既定のブラウザで開く。
/// 見た目は諦めることになるが、「押したのに何も起きない」よりはずっとまし。
/// </summary>
static class EdgeWindow
{
    const string AppPathsKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe";

    /// <summary>msedge.exe を探す。見つからなければ null。</summary>
    public static string? Find()
    {
        // App Paths は「そのアプリがどこに入ったか」を OS が持っている場所。
        // 決め打ちのパスより先にこちらを見る（配置は版によって変わりうる）
        foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            try
            {
                using var key = hive.OpenSubKey(AppPathsKey);
                if (key?.GetValue(null) is string path && File.Exists(path)) return path;
            }
            catch
            {
                // 読めないキーは飛ばす
            }
        }

        // 実測では 32bit 側（Program Files (x86)）に入っていた
        foreach (var folder in new[]
        {
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Environment.GetEnvironmentVariable("ProgramFiles"),
        })
        {
            if (string.IsNullOrWhiteSpace(folder)) continue;
            var candidate = Path.Combine(folder, "Microsoft", "Edge", "Application", "msedge.exe");
            if (File.Exists(candidate)) return candidate;
        }

        return null;
    }

    /// <summary>窓を開く。開けたら true。</summary>
    public static bool Open(int port)
    {
        var url = $"http://127.0.0.1:{port}/";
        var edge = Find();

        if (edge is null)
        {
            Log.Line("Edge が見つかりません。既定のブラウザで開きます");
            return OpenWithDefaultBrowser(url);
        }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = edge,
                UseShellExecute = false,
            };
            psi.ArgumentList.Add($"--app={url}");
            psi.ArgumentList.Add($"--user-data-dir={Paths.EdgeProfile}");
            // プロファイルを分けたぶん、初回は歓迎画面や既定ブラウザの確認が出る。両方止める
            psi.ArgumentList.Add("--no-first-run");
            psi.ArgumentList.Add("--no-default-browser-check");
            psi.ArgumentList.Add("--window-size=1280,860");

            Directory.CreateDirectory(Paths.EdgeProfile);
            using var proc = Process.Start(psi);
            Log.Line($"窓を開きました: {url}");
            return true;
        }
        catch (Exception ex)
        {
            Log.Line($"Edge を起動できませんでした: {ex.Message}。既定のブラウザで開きます");
            return OpenWithDefaultBrowser(url);
        }
    }

    static bool OpenWithDefaultBrowser(string url)
    {
        try
        {
            // UseShellExecute = true にすると、OS が URL の関連付けを解決してくれる
            using var proc = Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            Log.Line($"既定のブラウザで開きました: {url}");
            return true;
        }
        catch (Exception ex)
        {
            Log.Line($"ブラウザを開けませんでした: {ex.Message}");
            return false;
        }
    }
}

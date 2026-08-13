using System.Diagnostics;
using System.Runtime.InteropServices;
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
///
/// 開く前に、すでに開いている窓を探して前面に出す。
/// --app を重ねて叩くと窓が増えるのを実測で確かめたため（プロセスは1つのまま増えないので、
/// プロセス数を数える確認では見落とす）。押すたびに窓が積み上がるのは、
/// タスクバーから戻ってくるつもりで押した人にとっていちばん邪魔な壊れ方になる。
/// </summary>
static partial class EdgeWindow
{
    const string AppPathsKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe";

    /// <summary>アプリモードの窓のタイトル。public/index.html の title がそのまま出る。</summary>
    const string WindowTitle = "ClaudeDeck";

    /// <summary>ShowWindow の SW_RESTORE。最小化を元の大きさに戻す。</summary>
    const int SwRestore = 9;

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

    /// <summary>窓を開く。開けたら true。すでに開いていれば、それを前面に出すだけ。</summary>
    public static bool Open(int port)
    {
        var url = $"http://127.0.0.1:{port}/";

        if (RaiseExisting()) return true;

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

    /// <summary>
    /// すでに開いている窓を前面に出す。無ければ false。
    ///
    /// 探し方は「msedge のプロセスが持つメインの窓で、タイトルが ClaudeDeck のもの」。
    /// EnumWindows とコールバックを持ち出さずに Process.MainWindowHandle で足りる。
    /// 窓が2枚あっても1枚見つかれば目的は果たせる（新しく増やさない）。
    ///
    /// ふつうの Edge の窓は " - Microsoft Edge" のように後ろが付くので、
    /// 区切りの " - " を含むものは外す。これでタブで同じページを開いている窓を拾わない。
    ///
    /// 窓がどのポートを指しているかは知る手立てが無い。
    /// ポートがずれた場面（前回と違う番号で立った）では、前面に出た窓の中身が古いままになる。
    /// そこは「更新のときは CLAUDE_DECK_PORT で同じ番号に戻す」で防ぐ約束にしてあり、
    /// ここでは判定しない。代わりに、前面に出したことと URL を記録に残す。
    /// </summary>
    static bool RaiseExisting()
    {
        Process[] processes;
        try
        {
            processes = Process.GetProcessesByName("msedge");
        }
        catch (Exception ex)
        {
            Log.Line($"既存の窓を探せませんでした: {ex.Message}");
            return false;
        }

        try
        {
            foreach (var proc in processes)
            {
                IntPtr hwnd;
                string title;
                try
                {
                    hwnd = proc.MainWindowHandle;
                    title = proc.MainWindowTitle;
                }
                catch
                {
                    // 見ているあいだに終わったプロセス。飛ばす
                    continue;
                }

                if (hwnd == IntPtr.Zero) continue;
                if (!title.StartsWith(WindowTitle, StringComparison.Ordinal)) continue;
                if (title.Contains(" - ", StringComparison.Ordinal)) continue;

                // 最小化されていると前面化しても見えないので、先に戻す（focus.ps1 と同じ作法）
                if (IsIconic(hwnd)) ShowWindow(hwnd, SwRestore);

                if (SetForegroundWindow(hwnd))
                {
                    Log.Line($"すでに開いている窓を前面に出しました（PID {proc.Id}）");
                }
                else
                {
                    // 裏で動いているプロセスからの前面化は OS に制限されることがある。
                    // 前に出せなくても窓はあるので、ここで新しく開いてはいけない
                    Log.Line($"窓は開いていますが前面に出せませんでした（PID {proc.Id}）");
                }
                return true;
            }
        }
        finally
        {
            foreach (var proc in processes) proc.Dispose();
        }

        return false;
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

    // DllImport ではなく LibraryImport を使う。受け渡しのコードが生成されるので trim で消えない
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetForegroundWindow(IntPtr hWnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsIconic(IntPtr hWnd);
}

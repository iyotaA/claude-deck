using System.Runtime.InteropServices;
using System.Text;

namespace ClaudeDeck;

/// <summary>
/// 記録と、人への知らせ。
///
/// ランチャは窓を持たない。だから失敗すると「ダブルクリックしたのに何も起きない」になり、
/// これがいちばん追いにくい壊れ方になる。逃げ道を2つ用意しておく。
///
///  - launcher.log … 全経路の記録。毎回上書きする（autostart.log と同じ作法）
///  - MessageBox   … 人が押して起動したときの致命的な失敗だけ
///
/// 追記のたびに流し込む（AutoFlush）。途中で落ちても、そこまでが残る。
/// </summary>
static partial class Log
{
    static StreamWriter? _writer;

    /// <summary>記録を開き直す。開けなくても続ける（記録が取れないのは致命ではない）。</summary>
    public static void Open()
    {
        try
        {
            Directory.CreateDirectory(Paths.DataDir);
            // 毎回上書き。溜め続けると、いつのものか分からない行を延々読むことになる
            _writer = new StreamWriter(Paths.LauncherLog, append: false, new UTF8Encoding(false))
            {
                AutoFlush = true,
            };
        }
        catch
        {
            _writer = null;
        }
    }

    /// <summary>1行書く。時刻を頭に付ける。</summary>
    public static void Line(string message)
    {
        try
        {
            _writer?.WriteLine($"{DateTime.Now:HH:mm:ss} {message}");
        }
        catch
        {
            // 書けなくても止まらない
        }
    }

    /// <summary>例外を書く。種類・本文・スタックまで残す。</summary>
    public static void Fatal(Exception ex)
    {
        Line($"致命的: {ex.GetType().Name}: {ex.Message}");
        Line(ex.StackTrace ?? "(スタックなし)");
    }

    public static void Close()
    {
        try
        {
            _writer?.Dispose();
        }
        catch
        {
            // 閉じられなくても、もう終わるところなので何もしない
        }
        _writer = null;
    }

    /// <summary>
    /// 人に知らせる。
    ///
    /// 出すのは対話起動での致命的な失敗だけ。
    /// --background（ログオン直後）では呼ばない。誰も見ていない画面にダイアログを残さない。
    /// </summary>
    public static void Box(string title, string body)
    {
        try
        {
            // 0x00000010 = MB_ICONERROR
            MessageBoxW(IntPtr.Zero, $"{body}\n\n詳しくは:\n{Paths.LauncherLog}", title, 0x00000010);
        }
        catch
        {
            // 出せなくても止まらない
        }
    }

    /// <summary>
    /// 呼び出し元のコンソールに乗り移る。--status のときだけ使う。
    ///
    /// WinExe には標準出力の行き先が無いので、そのままだと何も見えない。
    /// -1（ATTACH_PARENT_PROCESS）で、起動した側のターミナルへ書けるようにする。
    /// </summary>
    public static void AttachToParentConsole()
    {
        try
        {
            if (!AttachConsole(-1)) return;

            // 乗り移った後の標準出力を開き直す。既に握られている口は無効なままなので
            var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
            Console.SetOut(stdout);
            Console.OutputEncoding = Encoding.UTF8;
        }
        catch
        {
            // 乗り移れなくても、記録には残るので致命ではない
        }
    }

    // LibraryImport（source generator）を使う。DllImport の反射に頼らないので trim しても消えない
    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AttachConsole(int processId);
}

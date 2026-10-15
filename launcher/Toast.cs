using Microsoft.Win32;

namespace ClaudeDeck;

/// <summary>
/// Windows の通知（トースト）を押したときの行き先と、通知の差出人を Windows に登録する。
///
/// 通知を出すのは Node（src/notify/toast.mjs → scripts/toast.ps1）。ここは登録だけ。
///
/// - **押した先**：<c>claude-deck://open?session=&lt;id&gt;</c>。押されると Windows が
///   <c>"&lt;スタブ&gt;" --open-url "&lt;URL&gt;"</c> でランチャを起こす（Program の RunOpenUrlAsync）
/// - **差出人**：AppUserModelID <c>ClaudeDeck</c> に表示名とアイコンを付ける。
///   **登録の無い名前で出したトーストは、Windows が何も言わずに捨てる**ので、これが無いと通知が出ない
///
/// どちらも HKCU\Software\Classes の下（管理者権限は要らない）。指すのはスタブ
/// （&lt;install&gt;\ClaudeDeck.exe）で、更新でも動かない（Startup と同じ理由）。
///
/// **名前は凍結。** PROTOCOL と APP_ID は Node 側（src/notify/toast.mjs の PROTOCOL / TOAST_APP_ID）と
/// 同じ文字列で照合する。片方だけ変えると、通知が黙って出ないか、押しても何も起きなくなる
/// （test/contract.test.mjs が両側を見ている）。
/// </summary>
static class Toast
{
    /// <summary>押した先の口。Node の PROTOCOL と同じ</summary>
    public const string PROTOCOL = "claude-deck";

    /// <summary>通知の差出人の登録名。Node の TOAST_APP_ID と同じ</summary>
    public const string APP_ID = "ClaudeDeck";

    /// <summary>押されたときに Windows が渡してくる命令。登録したコマンドに入るので凍結</summary>
    public const string OPEN_URL_FLAG = "--open-url";

    const string PROTOCOL_KEY = @"Software\Classes\" + PROTOCOL;
    const string APPID_KEY = @"Software\Classes\AppUserModelId\" + APP_ID;

    /// <summary>押されたときに走らせるもの。%1 に URL が入る</summary>
    static string Command => $"\"{Paths.LauncherExe}\" {OPEN_URL_FLAG} \"%1\"";

    /// <summary>
    /// ふつうの起動のたびに1回。食い違っていれば直す（同じなら書かない）。
    ///
    /// **入れた版でないときは触らない。** 開発中のビルド出力を登録すると、消したとたんに
    /// 死んだ値が残る（Startup.Sync と同じ割り切り）。そのとき差出人 ClaudeDeck は
    /// 登録されないので、開発中のランチャ経由ではトーストが出ない。npm start なら出る。
    /// </summary>
    public static void Sync()
    {
        if (!Paths.IsDeployed)
        {
            Log.Line("入れて使っていないので通知の登録はしません");
            return;
        }
        Register();
    }

    /// <summary>登録する。投げない（起動を止める理由にしない）。</summary>
    /// <returns>書けたら true。</returns>
    public static bool Register()
    {
        try
        {
            using (var key = Registry.CurrentUser.CreateSubKey(PROTOCOL_KEY, writable: true))
            {
                SetIfDiffers(key, "", "URL:ClaudeDeck");
                // この値があると「URL の口」として扱われる。中身は空でよい
                SetIfDiffers(key, "URL Protocol", "");
            }
            using (var icon = Registry.CurrentUser.CreateSubKey(PROTOCOL_KEY + @"\DefaultIcon", writable: true))
            {
                SetIfDiffers(icon, "", $"\"{Paths.LauncherExe}\",0");
            }
            using (var cmd = Registry.CurrentUser.CreateSubKey(PROTOCOL_KEY + @"\shell\open\command", writable: true))
            {
                SetIfDiffers(cmd, "", Command);
            }

            using (var app = Registry.CurrentUser.CreateSubKey(APPID_KEY, writable: true))
            {
                SetIfDiffers(app, "DisplayName", "ClaudeDeck");
                // アイコンは配布物に入っている絵を使う。current\ は更新で中身が替わるが場所は同じ
                var png = Path.Combine(Paths.AppDir ?? Paths.ExeDir, "public", "favicon-192.png");
                if (File.Exists(png)) SetIfDiffers(app, "IconUri", png);
            }
            return true;
        }
        catch (Exception ex)
        {
            Log.Line($"通知の登録ができませんでした: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// 消す。アンインストール直前に呼ぶ。**自分たちを指している口だけ消す。**
    /// 別の場所を指しているなら、それは別の入れ物のものなので触らない。
    /// </summary>
    /// <returns>消したか、もともと無かったら true。</returns>
    public static bool Unregister()
    {
        try
        {
            string? current;
            using (var cmd = Registry.CurrentUser.OpenSubKey(PROTOCOL_KEY + @"\shell\open\command"))
            {
                current = cmd?.GetValue("") as string;
            }
            if (current is not null && !current.Contains(Paths.LauncherExe, StringComparison.OrdinalIgnoreCase))
            {
                Log.Line($"claude-deck:// は別の場所を指しているので触りません: {ForLog(current)}");
                return false;
            }
            Registry.CurrentUser.DeleteSubKeyTree(PROTOCOL_KEY, throwOnMissingSubKey: false);
            Registry.CurrentUser.DeleteSubKeyTree(APPID_KEY, throwOnMissingSubKey: false);
            Log.Line("通知の登録を消しました");
            return true;
        }
        catch (Exception ex)
        {
            Log.Line($"通知の登録を消せませんでした: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// 押された URL からセッションを取り出す。形が違えば null（窓を開くだけにする）。
    ///
    /// 受けるのは <c>claude-deck://open?session=&lt;id&gt;</c> だけ。id はサーバーの
    /// /api/reveal と同じ形（英数字・_・- で 64 字まで）に限る。**それ以外を渡さない**
    /// ―― URL は他のアプリからも叩けるので、ここが外から来る入力の入口になる。
    /// </summary>
    /// <param name="url">Windows が渡してきた URL。</param>
    /// <returns>セッションの ID。取れなければ null。</returns>
    public static string? SessionFromUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)) return null;
        if (!string.Equals(uri.Scheme, PROTOCOL, StringComparison.OrdinalIgnoreCase)) return null;
        if (!string.Equals(uri.Host, "open", StringComparison.OrdinalIgnoreCase)) return null;

        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            if (eq <= 0) continue;
            if (!string.Equals(pair[..eq], "session", StringComparison.Ordinal)) continue;
            var value = Uri.UnescapeDataString(pair[(eq + 1)..]);
            return IsSessionId(value) ? value : null;
        }
        return null;
    }

    /// <summary>セッションの ID の形か。サーバーの /api/reveal と同じ決まり</summary>
    static bool IsSessionId(string value)
    {
        if (value.Length is 0 or > 64) return false;
        foreach (var c in value)
        {
            if (!(char.IsAsciiLetterOrDigit(c) || c == '_' || c == '-')) return false;
        }
        return true;
    }

    /// <summary>
    /// 外から来た文字（押された URL・レジストリの値）をログに書ける形にする。
    /// 改行を空白へ替えて長さを切る。**そのまま書くと、改行入りの URL で
    /// launcher.log に偽の行を作れる**（URL は他のアプリからも叩ける）
    /// </summary>
    public static string ForLog(string? text) =>
        Paper.Clip(text?.Replace('\r', ' ').Replace('\n', ' '), Paper.ERROR_MAX) ?? "(なし)";

    /// <summary>値が違うときだけ書く。毎回の起動で同じ値を書き直さない</summary>
    static void SetIfDiffers(RegistryKey? key, string name, string value)
    {
        if (key is null) return;
        if (key.GetValue(name) as string == value) return;
        key.SetValue(name, value, RegistryValueKind.String);
    }
}

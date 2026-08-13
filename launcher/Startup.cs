using Microsoft.Win32;

namespace ClaudeDeck;

/// <summary>
/// ログオン時の自動起動。
///
/// 登録先は HKCU\...\Run、値はスタブ（&lt;install&gt;\ClaudeDeck.exe）の絶対パス。
/// Velopack は更新のたびに current\ を丸ごと差し替えるが、ルートのスタブは動かない。
/// ここを指しておけば「フォルダが動いて黙って壊れる」が構造的に起きない。
///
/// .lnk を作らないのは COM（IShellLink）が要るため。
/// trim を掛けた single-file と相性が悪く、アイコンが付く代わりに
/// 実行時にだけ落ちる経路を1本増やすことになる。割に合わない。
///
/// 旧方式（スタートアップフォルダの ClaudeDeck.lnk）は**消さずに改名**する。
/// 放っておくと旧フォルダの node と新しい node が二重に立ち、後から立ったほうが
/// 4318 にずれて「画面は出るのに設定が反映されない」という追いにくい形になる。
///
/// 結果は startup.json に書く。読むのは Node（src/startup/state.mjs）だけで、
/// 向きは update.json と同じ一方通行。
/// </summary>
static class Startup
{
    /// <summary>ログオン時に走らせるものを並べる場所。HKCU なので管理者権限は要らない。</summary>
    const string RUN_KEY = @"Software\Microsoft\Windows\CurrentVersion\Run";

    /// <summary>値の名前。これが自分の枠になる。</summary>
    const string VALUE_NAME = "ClaudeDeck";

    /// <summary>旧方式のショートカット。</summary>
    const string LEGACY_NAME = "ClaudeDeck.lnk";

    /// <summary>無効にした後の名前。消さずに残すので、利用者が戻せる。</summary>
    const string DISABLED_NAME = "ClaudeDeck.lnk.disabled";

    /// <summary>紙に載せる理由の長さ。update.json と揃えてある。</summary>
    const int ERROR_MAX = 300;

    /// <summary>登録する中身。窓は出さない（ログオン直後に人は見ていない）。</summary>
    static string Command => $"\"{Paths.LauncherExe}\" --background";

    /// <summary>
    /// ふつうの起動のたびに1回。旧方式を畳み、ずれた登録を直し、紙を書く。
    ///
    /// **登録が無いときは勝手に戻さない。** 利用者が自分で外した可能性があるため。
    /// ただし旧方式をこの場で畳んだときだけは引き継ぐ（外したのではなく、移したので）。
    /// </summary>
    public static void Sync()
    {
        var (legacy, moved) = MigrateLegacy();

        string state;
        string? error = null;

        if (!Paths.IsDeployed)
        {
            // 開発中のビルド出力を登録しても、消したとたんに死んだ値が残るだけ。
            // Run キーには一切触らない
            state = "not-installed";
        }
        else if (moved)
        {
            // 移し替えなので、旧方式で立っていた人はそのまま新方式で立つ
            (state, error) = Register();
        }
        else
        {
            (state, error) = Repair();
        }

        WritePaper(state, legacy, error);
    }

    /// <summary>
    /// 登録する。インストール直後（OnFirstRun）と --install-startup から呼ぶ。
    /// </summary>
    /// <returns>登録できたら true。</returns>
    public static bool Install()
    {
        var (legacy, _) = MigrateLegacy();

        if (!Paths.IsDeployed)
        {
            Log.Line("入れて使っていないので自動起動は登録しません（Setup.exe から入れた ClaudeDeck で実行してください）");
            WritePaper("not-installed", legacy, null);
            return false;
        }

        var (state, error) = Register();
        WritePaper(state, legacy, error);
        return state == "on";
    }

    /// <summary>
    /// 解除する。アンインストール直前（OnBeforeUninstallFastCallback）と
    /// --uninstall-startup から呼ぶ。
    ///
    /// **自分たちを指している値だけ消す。** 別の場所を指しているなら、
    /// それは別の入れ物のものなので触らない。
    /// </summary>
    /// <returns>消したか、もともと無かったら true。</returns>
    public static bool Uninstall()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RUN_KEY, writable: true);
            var current = key?.GetValue(VALUE_NAME) as string;

            if (string.IsNullOrWhiteSpace(current))
            {
                Log.Line("自動起動は登録されていません");
                return true;
            }
            if (!IsOurs(current))
            {
                Log.Line($"自動起動は別の場所を指しているので触りません: {current}");
                return false;
            }

            key?.DeleteValue(VALUE_NAME, throwOnMissingValue: false);
            Log.Line("自動起動を解除しました");

            // 紙も直す。残すと、消したのに画面が「起動します」と言い続ける
            WritePaper("off", Peek().Legacy, null);
            return true;
        }
        catch (Exception ex)
        {
            Log.Line($"自動起動を解除できませんでした: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// いまの様子を読むだけ。直しも書きもしない（--status のため）。
    /// </summary>
    /// <returns>状態と、旧方式の様子。</returns>
    public static (string State, string Legacy) Peek()
    {
        var legacy = LegacyLook();
        if (!Paths.IsDeployed) return ("not-installed", legacy);

        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RUN_KEY);
            var current = key?.GetValue(VALUE_NAME) as string;

            if (string.IsNullOrWhiteSpace(current)) return ("off", legacy);
            return (Same(current, Command) ? "on" : "foreign", legacy);
        }
        catch (Exception ex)
        {
            Log.Line($"自動起動の登録を読めませんでした: {ex.Message}");
            return ("foreign", legacy);
        }
    }

    /// <summary>状態を人の言葉にする。</summary>
    /// <param name="state">Peek や Sync が出した状態。</param>
    /// <returns>1行の説明。</returns>
    public static string Describe(string state) => state switch
    {
        "on" => "ログオン時に起動します",
        "off" => "ログオン時には起動しません",
        "foreign" => "別の場所が登録されています（直せませんでした）",
        "not-installed" => "入れて使っていないので登録していません",
        _ => "分かりません",
    };

    /// <summary>旧方式の様子を人の言葉にする。</summary>
    /// <param name="legacy">Peek や Sync が出した旧方式の様子。</param>
    /// <returns>1行の説明。</returns>
    public static string DescribeLegacy(string legacy) => legacy switch
    {
        "none" => "ありません",
        "active" => "残っています（入れて使っていないので触っていません）",
        "disabled" => $"無効にしました（{DISABLED_NAME} として残してあります）",
        "failed" => "残っていますが、無効にできませんでした",
        _ => "分かりません",
    };

    /// <summary>登録を書く。</summary>
    /// <returns>状態と、失敗したときの理由。</returns>
    static (string State, string? Error) Register()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RUN_KEY, writable: true);
            if (key is null) return ("foreign", "登録先を開けませんでした");

            var before = key.GetValue(VALUE_NAME) as string;
            if (Same(before, Command)) return ("on", null);

            key.SetValue(VALUE_NAME, Command, RegistryValueKind.String);
            Log.Line(string.IsNullOrWhiteSpace(before)
                ? $"自動起動を登録しました: {Command}"
                : $"自動起動を書き直しました: {before} → {Command}");
            return ("on", null);
        }
        catch (Exception ex)
        {
            Log.Line($"自動起動を登録できませんでした: {ex.Message}");
            return ("foreign", Clip(ex.Message, ERROR_MAX));
        }
    }

    /// <summary>
    /// ずれた登録だけ直す。無いものは足さない。
    ///
    /// 直す相手は「値はあるが別の場所を指している」もの。
    /// 入れ直しや置き場所の変更でこうなるので、黙って直すのが親切。
    /// </summary>
    /// <returns>状態と、失敗したときの理由。</returns>
    static (string State, string? Error) Repair()
    {
        string? current;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RUN_KEY);
            current = key?.GetValue(VALUE_NAME) as string;
        }
        catch (Exception ex)
        {
            Log.Line($"自動起動の登録を読めませんでした: {ex.Message}");
            return ("foreign", Clip(ex.Message, ERROR_MAX));
        }

        // 無いものは足さない。自分で外した人の選択を毎回ひっくり返さない
        if (string.IsNullOrWhiteSpace(current)) return ("off", null);
        if (Same(current, Command)) return ("on", null);

        return Register();
    }

    /// <summary>
    /// 旧方式のショートカットを畳む。消さずに改名して、戻せる形を残す。
    ///
    /// 配布形のときだけ触る。開発中に畳むと、新方式を登録しないまま
    /// 旧方式だけ止めることになり、自動起動がまるごと消える。
    /// </summary>
    /// <returns>旧方式の様子と、この場で畳んだかどうか。</returns>
    static (string Legacy, bool Moved) MigrateLegacy()
    {
        var (lnk, disabled) = LegacyPaths();
        if (lnk is null || disabled is null) return ("none", false);

        var hasLnk = SafeExists(lnk);
        var hasDisabled = SafeExists(disabled);

        if (!hasLnk) return (hasDisabled ? "disabled" : "none", false);
        if (!Paths.IsDeployed) return ("active", false);

        try
        {
            File.Move(lnk, disabled, overwrite: true);
            Log.Line($"旧方式の自動起動を無効にしました: {lnk} → {DISABLED_NAME}");
            Log.Line("  （新しい方式で登録し直すので、二重に立つことはありません）");
            return ("disabled", true);
        }
        catch (Exception ex)
        {
            Log.Line($"旧方式の自動起動を無効にできませんでした: {ex.Message}");
            return ("failed", false);
        }
    }

    /// <summary>旧方式の様子を読むだけ。</summary>
    /// <returns>none / active / disabled。</returns>
    static string LegacyLook()
    {
        var (lnk, disabled) = LegacyPaths();
        if (lnk is null || disabled is null) return "none";
        if (SafeExists(lnk)) return "active";
        return SafeExists(disabled) ? "disabled" : "none";
    }

    /// <summary>スタートアップフォルダの2つのパスを出す。取れなければ null。</summary>
    /// <returns>旧ショートカットと、無効にした後の名前。</returns>
    static (string? Lnk, string? Disabled) LegacyPaths()
    {
        try
        {
            var dir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            if (string.IsNullOrWhiteSpace(dir)) return (null, null);
            return (Path.Combine(dir, LEGACY_NAME), Path.Combine(dir, DISABLED_NAME));
        }
        catch
        {
            return (null, null);
        }
    }

    /// <summary>紙を1枚書く。書けなくても起動は続ける。</summary>
    /// <param name="state">自動起動の状態。</param>
    /// <param name="legacy">旧方式の様子。</param>
    /// <param name="error">失敗したときの理由。無ければ null。</param>
    static void WritePaper(string state, string legacy, string? error) =>
        Paper.Write(Paths.StartupFile, writer =>
        {
            writer.WriteString("state", state);
            writer.WriteString("legacy", legacy);
            writer.WriteNumber("checkedAt", Paper.Now());
            Paper.Text(writer, "error", error);
            // パスも登録の中身も載せない。画面に出す用が無いうえ、
            // 置き場所を2箇所に書くことになる（紙は最小に保つ）
        });

    /// <summary>登録されている値が自分たちのものか。</summary>
    /// <param name="value">Run に入っている文字列。</param>
    /// <returns>自分たちのものなら true。</returns>
    static bool IsOurs(string value)
    {
        var exe = ExeOf(value);
        if (exe is null) return false;
        if (SamePath(exe, Paths.LauncherExe)) return true;

        // 入れ替えの途中や版違いで current\ の中を指していることがある。
        // アンインストールで取り残さないよう、置き場所ごと見る
        var root = Path.GetDirectoryName(Paths.ExeDir);
        return root is not null && IsInside(root, exe);
    }

    /// <summary>
    /// 値から実行ファイルのパスだけ取り出す。
    ///
    /// 自分で書くときは必ず引用符で囲むので、ふつうはその中身。
    /// 手で書き換えられていることもあるので、囲みが無い形にも一応備える。
    /// </summary>
    /// <param name="value">Run に入っている文字列。</param>
    /// <returns>実行ファイルのパス。読めなければ null。</returns>
    static string? ExeOf(string value)
    {
        var text = value.Trim();
        if (text.Length == 0) return null;

        if (text[0] == '"')
        {
            var end = text.IndexOf('"', 1);
            return end > 1 ? text[1..end] : null;
        }

        // 囲みが無い形。パスに空白が無い前提でしか切れないので、
        // まず「全部がパス」を試し、駄目なら最初の空白まで
        if (text.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return text;

        var space = text.IndexOf(' ');
        return space > 0 ? text[..space] : text;
    }

    /// <summary>
    /// path が root の中にあるか。
    ///
    /// startsWith で比べない。ドライブレターの大小や末尾の \ の有無で、
    /// 正しいパスを弾いたり、隣のフォルダを中と見なしたりする。
    /// </summary>
    /// <param name="root">親。</param>
    /// <param name="path">中にあるか調べるパス。</param>
    /// <returns>中にあれば true。</returns>
    static bool IsInside(string root, string path)
    {
        try
        {
            var rel = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(path));
            return !rel.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathRooted(rel);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>登録の中身が同じか。大小と前後の空白は見ない。</summary>
    /// <param name="a">片方。null 可。</param>
    /// <param name="b">もう片方。</param>
    /// <returns>同じなら true。</returns>
    static bool Same(string? a, string b) =>
        a is not null && string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);

    /// <summary>パスとして同じか。</summary>
    /// <param name="a">片方。</param>
    /// <param name="b">もう片方。</param>
    /// <returns>同じなら true。</returns>
    static bool SamePath(string a, string b)
    {
        try
        {
            return string.Equals(
                Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>読めない場所を指していても落ちない File.Exists。</summary>
    /// <param name="file">調べるパス。</param>
    /// <returns>あれば true。</returns>
    static bool SafeExists(string file)
    {
        try
        {
            return File.Exists(file);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>長すぎる文字列を切る。切り口がサロゲートペアの途中なら1文字戻す。</summary>
    /// <param name="text">元の文字列。null 可。</param>
    /// <param name="max">残す長さ。</param>
    /// <returns>切った文字列。元が null なら null。</returns>
    static string? Clip(string? text, int max)
    {
        if (text is null || text.Length <= max) return text;

        var end = max;
        if (char.IsHighSurrogate(text[end - 1])) end--;
        return text[..end] + "…";
    }
}

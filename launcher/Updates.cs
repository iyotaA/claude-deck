using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using Velopack;
using Velopack.Sources;

namespace ClaudeDeck;

/// <summary>
/// 更新の確認。判断はここ（C#）だけが持つ。
///
/// 向きは C#（書く）→ update.json → Node（読む）→ 画面 の一方通行。
/// Node 側に写さない理由は2つある。
///
/// 1. 失敗が黙って消える。
///    server.mjs の uncaughtException は記録して続行する作りなので、
///    更新の失敗が「画面は元気なのに何も変わらない」に化ける。
///
/// 2. node 自身が更新の対象。
///    current\runtime\node.exe ごと差し替わるので、
///    自分を置き換える手続きを自分の中に持たせない。
///
/// この段でやるのは確認だけ。落としも入れ替えもしない。
/// 「見えるようになる」と「動くようになる」を混ぜると、
/// 失敗したときに更新の失敗なのか表示の失敗なのか切り分けられなくなる。
/// </summary>
static class Updates
{
    /// <summary>取りに行く先。ここ以外は見ない。</summary>
    const string RepoUrl = "https://github.com/iyotaA/claude-deck";

    /// <summary>
    /// 確認と確認のあいだに空ける時間。
    ///
    /// GitHub の未認証 API は 60回/時。開き直すたびに叩くと、
    /// よく使う日に上限へ当たって「確認できません」だらけになる。
    /// --check-update は force で飛び越えるので、人が確かめたいときは待たされない。
    /// </summary>
    const long MinIntervalMs = 30 * 60 * 1000;

    /// <summary>1回の確認を待つ上限。</summary>
    const int TimeoutMs = 20000;

    /// <summary>更新の説明を載せる上限。画面の帯に出すだけなので長さは要らない。</summary>
    const int NotesMax = 2000;

    /// <summary>失敗の理由を載せる上限。</summary>
    const int ErrorMax = 300;

    /// <summary>InnerException を辿る深さの上限。参照が輪になっていても止まるように。</summary>
    const int CauseDepth = 5;

    /// <summary>
    /// update.json の中身。
    ///
    /// State に入るのはこの6つだけ。
    /// off / not-installed / none / available / unreachable / failed
    ///
    /// 「確認中（checking）」は書かない。途中で殺されると永久に確認中で固まるので、
    /// 終わった状態だけを書く。
    ///
    /// 読む側（src/update/state.mjs）はこれに3つ足す。
    /// idle（紙が無い）・stale（版が食い違う）・unknown（読めない）。
    /// </summary>
    /// <param name="State">いまの状態。上の6つのどれか。</param>
    /// <param name="Current">確認したときに動いていた版。</param>
    /// <param name="Available">見つかった新しい版。無ければ null。</param>
    /// <param name="Notes">更新の説明。無ければ null。</param>
    /// <param name="CheckedAt">確認した時刻（Unix ミリ秒）。</param>
    /// <param name="ChangedAt">状態が変わった時刻（Unix ミリ秒）。</param>
    /// <param name="Error">失敗の理由。成功なら null。</param>
    public record UpdateState(
        string State,
        string Current,
        string? Available,
        string? Notes,
        long CheckedAt,
        long ChangedAt,
        string? Error);

    /// <summary>
    /// 確認して update.json を書く。
    ///
    /// 例外は投げない。呼ぶ側は必ず状態を受け取る。
    /// 「更新を確認できなかった」はアプリが動かなくなる話ではないので、
    /// ここで throw して起動そのものを止める理由が無い。
    /// </summary>
    /// <param name="force">前回からの間隔を無視するか。--check-update は true。</param>
    /// <returns>書いた状態。</returns>
    public static async Task<UpdateState> CheckAsync(bool force)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var previous = ReadState();

        // 止めるためだけの環境変数。画面からは止められない
        // （画面から自分を締め出せる口を作らない）
        if (IsOff()) return Save(previous, Make("off", now));

        if (!force && previous is not null && IsSettled(previous.State))
        {
            var elapsed = now - previous.CheckedAt;
            // 負になるのは時計が巻き戻ったとき。そのときは素直に確かめ直す
            if (elapsed >= 0 && elapsed < MinIntervalMs)
            {
                Log.Line($"更新の確認は省きます（前回から {elapsed / 60000} 分・{previous.State}）");
                return previous;
            }
        }

        try
        {
            var source = new GithubSource(RepoUrl, accessToken: null, prerelease: false);
            var manager = new UpdateManager(source, options: null, locator: null);

            // 配布物として入っていないと、そもそも入れ替える先が無い。
            // 開発中（dotnet run）と Portable はここに落ちる。
            // 通信しない判定なので、間隔の見張りより先に置いても損はしない
            if (!manager.IsInstalled) return Save(previous, Make("not-installed", now));

            var info = await WithTimeoutAsync(manager.CheckForUpdatesAsync());
            // null が「新しいものは無い」の意味。例外ではない
            if (info is null) return Save(previous, Make("none", now));

            var target = info.TargetFullRelease;
            var state = Make("available", now,
                available: target?.Version?.ToString(),
                notes: Clip(target?.NotesMarkdown, NotesMax));

            Log.Line($"新しい版があります: {state.Available ?? "(版が読めない)"}");
            return Save(previous, state);
        }
        catch (Exception ex)
        {
            // 「電波が届かなかった」と「壊れている」を分ける。
            // 分けておくと、画面で書き分けられる（片方は待てば直る、片方は直らない）
            var state = IsNetworkTrouble(ex) ? "unreachable" : "failed";
            Log.Line($"更新を確認できませんでした（{state}）: {ex.GetType().Name}: {ex.Message}");
            return Save(previous, Make(state, now, error: Clip(ex.Message, ErrorMax)));
        }
    }

    /// <summary>
    /// 起動のついでに確認する。失敗しても起動そのものは続ける。
    ///
    /// 戻り値を捨てているのは、ここでの結果が終了コードに混ざってはいけないため。
    /// 「更新を確認できなかったから起動に失敗した」ことにすると、
    /// 回線が細い日にアプリが立たなくなる。
    /// </summary>
    public static async Task CheckQuietlyAsync()
    {
        try
        {
            await CheckAsync(force: false);
        }
        catch (Exception ex)
        {
            // CheckAsync は自分で受け止める作りだが、
            // 受け止め漏れがあっても起動を巻き添えにしない
            Log.Line($"更新の確認で想定外: {ex.Message}");
        }
    }

    /// <summary>
    /// 状態を人の言葉にする。--check-update と --status がコンソールへ出すためのもの。
    ///
    /// 画面に出す日本語は src/update/state.mjs の UPDATE_LABELS が持つ。
    /// 同じ意味を2箇所に書いているので、片方を直したらもう片方も見る。
    /// </summary>
    /// <param name="state">UpdateState.State の値。</param>
    /// <returns>説明の1行。</returns>
    public static string Describe(string state) => state switch
    {
        "off" => "更新の確認は止めてあります（CLAUDE_DECK_UPDATE_OFF）",
        "not-installed" => "この起動の仕方では更新できません（インストールされた版ではありません）",
        "none" => "最新です",
        "available" => "新しい版があります",
        "unreachable" => "更新を確認できませんでした（GitHub に届きませんでした）",
        "failed" => "更新の確認に失敗しました",
        _ => "状態が分かりません",
    };

    /// <summary>
    /// 更新の確認を止めてあるか。
    ///
    /// 語彙は src/notify/config.mjs の isOff と同じにする。
    /// 「止めるための環境変数」の効き方が機能ごとに違うのがいちばん困る。
    /// </summary>
    /// <returns>止めてあれば true。</returns>
    public static bool IsOff()
    {
        var value = Environment.GetEnvironmentVariable("CLAUDE_DECK_UPDATE_OFF");
        if (string.IsNullOrWhiteSpace(value)) return false;

        var normalized = value.Trim().ToLowerInvariant();
        return normalized is not ("0" or "false" or "no");
    }

    /// <summary>update.json を読む。無い・壊れているときは null。</summary>
    /// <returns>前回の状態。読めなければ null。</returns>
    public static UpdateState? ReadState()
    {
        try
        {
            if (!File.Exists(Paths.UpdateFile)) return null;

            using var doc = JsonDocument.Parse(File.ReadAllText(Paths.UpdateFile));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var state = JsonRead.GetString(root, "state");
            if (string.IsNullOrWhiteSpace(state)) return null;

            return new UpdateState(
                state,
                JsonRead.GetString(root, "current") ?? "",
                JsonRead.GetString(root, "available"),
                JsonRead.GetString(root, "notes"),
                JsonRead.GetLong(root, "checkedAt"),
                JsonRead.GetLong(root, "changedAt"),
                JsonRead.GetString(root, "error"));
        }
        catch
        {
            // 書き込みの途中を掴んだ・古い版の形だった。どちらも「前回は無い」に倒す
            return null;
        }
    }

    /// <summary>
    /// 紙に書いて、書いたものを返す。
    ///
    /// state と available が前と同じなら changedAt は据え置く。
    /// 画面が「いつからこの状態か」を出せるようにするため。
    /// checkedAt のほうは毎回動くので、両方を持つ意味がある。
    /// </summary>
    /// <param name="previous">前回の状態。無ければ null。</param>
    /// <param name="next">今回の状態。</param>
    /// <returns>実際に書いた状態。</returns>
    static UpdateState Save(UpdateState? previous, UpdateState next)
    {
        var state = next;
        if (previous is not null && previous.State == next.State && previous.Available == next.Available)
        {
            state = next with { ChangedAt = previous.ChangedAt };
        }

        WriteState(state);
        return state;
    }

    /// <summary>状態を1つ組む。changedAt は Save が必要なら書き戻す。</summary>
    /// <param name="state">状態の語。</param>
    /// <param name="now">いまの時刻（Unix ミリ秒）。</param>
    /// <param name="available">見つかった新しい版。</param>
    /// <param name="notes">更新の説明。</param>
    /// <param name="error">失敗の理由。</param>
    static UpdateState Make(
        string state, long now, string? available = null, string? notes = null, string? error = null) =>
        new(state, Paths.Version, available, notes, now, now, error);

    /// <summary>
    /// 一時ファイル → rename で書く。読む側が半端な JSON を掴まないようにする。
    /// notify/settings.mjs と同じ作法。
    /// </summary>
    /// <param name="state">書く状態。</param>
    static void WriteState(UpdateState state)
    {
        var temp = Paths.UpdateFile + ".tmp";
        try
        {
            Directory.CreateDirectory(Paths.DataDir);

            // JsonSerializer は使わない。反射で型を見る作りなので、
            // PublishTrimmed で必要な情報が黙って削られ、実行時にだけ落ちる。
            // Utf8JsonWriter なら反射を通らず、エスケープも自分で気にせずに済む
            using (var stream = File.Create(temp))
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteString("state", state.State);
                writer.WriteString("current", state.Current);
                WriteText(writer, "available", state.Available);
                WriteText(writer, "notes", state.Notes);
                writer.WriteNumber("checkedAt", state.CheckedAt);
                writer.WriteNumber("changedAt", state.ChangedAt);
                WriteText(writer, "error", state.Error);
                writer.WriteEndObject();
            }

            File.Move(temp, Paths.UpdateFile, overwrite: true);
        }
        catch (Exception ex)
        {
            // 書けなくても起動は続ける。読む側は紙が無ければ idle と読む
            Log.Line($"更新の記録を書けませんでした: {ex.Message}");
            TryDelete(temp);
        }
    }

    /// <summary>
    /// null なら null を、そうでなければ文字列を書く。
    ///
    /// WriteString(name, (string)null) が何を書くかに頼らず、自分で分ける。
    /// キーごと消えると、読む側で「無い」と「null」の区別が付かなくなる。
    /// </summary>
    /// <param name="writer">書き出し先。</param>
    /// <param name="name">キー。</param>
    /// <param name="value">値。null 可。</param>
    static void WriteText(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is null) writer.WriteNull(name);
        else writer.WriteString(name, value);
    }

    /// <summary>
    /// 間隔の見張りを効かせてよい状態か。
    ///
    /// 落ち着いた答え（最新・新しい版がある）が出ているときだけ待たせる。
    /// 失敗している側はすぐ試し直す。回線が戻ったのに30分黙るのは意味がない。
    /// not-installed も毎回見る（通信しない判定なので待たせる理由が無い）。
    /// </summary>
    /// <param name="state">前回の状態。</param>
    /// <returns>待たせてよければ true。</returns>
    static bool IsSettled(string state) => state is "none" or "available";

    /// <summary>
    /// 打ち切りを被せる。
    ///
    /// CheckForUpdatesAsync には CancellationToken の口が無い（実測）ので、
    /// 待つのをやめる形にする。相手は走り続けるが、この工程はすぐ終わって消えるので放っておける。
    /// </summary>
    /// <typeparam name="T">元の戻り値の型。</typeparam>
    /// <param name="task">待つ相手。</param>
    /// <returns>相手の戻り値。</returns>
    static async Task<T> WithTimeoutAsync<T>(Task<T> task)
    {
        var done = await Task.WhenAny(task, Task.Delay(TimeoutMs));
        if (done != task)
        {
            throw new TimeoutException($"{TimeoutMs / 1000} 秒たっても返事がありませんでした。");
        }
        return await task;
    }

    /// <summary>
    /// 通信できなかっただけか。
    ///
    /// Velopack は中の失敗を包んで投げてくるので、InnerException を辿る。
    /// 分からないものは failed に倒す（「待てば直る」と嘘をつくより、直らないと言うほうがまし）。
    /// </summary>
    /// <param name="ex">受け止めた例外。</param>
    /// <returns>通信の問題なら true。</returns>
    static bool IsNetworkTrouble(Exception ex)
    {
        var cause = ex;
        for (var i = 0; i < CauseDepth && cause is not null; i++, cause = cause.InnerException)
        {
            if (cause is HttpRequestException or SocketException
                or OperationCanceledException or TimeoutException)
            {
                return true;
            }
        }
        return false;
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

    /// <summary>消せなくても構わないファイルを消す。</summary>
    /// <param name="file">消すファイル。</param>
    static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch
        {
            // 次に書くとき上書きするので、残っていても実害は無い
        }
    }
}

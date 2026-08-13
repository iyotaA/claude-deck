using System.Text.Json;

namespace ClaudeDeck;

/// <summary>
/// ランチャが Node へ渡す「紙」を書く。
///
/// 向きは C#（書く）→ *.json → Node（読む）→ 画面 の一方通行。
/// いまのところ2枚ある（update.json / startup.json）。
/// 書き方の作法が2箇所に散ると必ず片方が古くなるので、ここ1枚に集める。
///
/// 守っているのは3つ。
///
///  - 一時ファイル → rename。読む側が書きかけの半端な JSON を掴まない
///    （notify/settings.mjs と同じ作法）
///  - JsonSerializer を使わない。反射で型を見る作りなので、
///    PublishTrimmed で必要な情報が黙って削られ、実行時にだけ落ちる。
///    Utf8JsonWriter なら反射を通らず、エスケープも自分で気にせずに済む
///  - 書けなくても起動は続ける。読む側は紙が無ければ「まだ」と読む決まりにしてある
/// </summary>
static class Paper
{
    /// <summary>
    /// 紙を1枚書く。中身の組み立ては呼ぶ側に任せる。
    /// </summary>
    /// <param name="file">書き先。親フォルダが無ければ作る。</param>
    /// <param name="body">オブジェクトの中身を書く処理。開始と終了の括りはこちらで被せる。</param>
    /// <returns>書けたら true。</returns>
    public static bool Write(string file, Action<Utf8JsonWriter> body)
    {
        var temp = file + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file) ?? Paths.DataDir);

            using (var stream = File.Create(temp))
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                body(writer);
                writer.WriteEndObject();
            }

            File.Move(temp, file, overwrite: true);
            return true;
        }
        catch (Exception ex)
        {
            Log.Line($"{Path.GetFileName(file)} を書けませんでした: {ex.Message}");
            TryDelete(temp);
            return false;
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
    public static void Text(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is null) writer.WriteNull(name);
        else writer.WriteString(name, value);
    }

    /// <summary>
    /// 紙に押す時刻（Unix ミリ秒）。
    ///
    /// 読む側（Node）が Date として扱うので、紙ごとに刻み方が違うと困る。
    /// 書く側で1箇所に寄せておく。
    /// </summary>
    /// <returns>Unix ミリ秒。</returns>
    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

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

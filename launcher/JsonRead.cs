using System.Text.Json;

namespace ClaudeDeck;

/// <summary>
/// JSON から値を取り出す小道具。
///
/// JsonSerializer.Deserialize&lt;T&gt; は使わない。あれは反射で型を見る作りなので、
/// PublishTrimmed を掛けたこの実行ファイルでは必要な情報が黙って削られ、
/// 実行時にだけ落ちる形になる。JsonDocument なら反射を通らないので trim しても安全。
///
/// 取れなかったときは既定値（0 / null）を返す。読んでいるのは自分で書いた紙だが、
/// 版が違えば形も違う。「未知の形で落ちない」はここでも守る。
/// </summary>
static class JsonRead
{
    /// <summary>整数を読む。無い・数でないときは 0。</summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    public static int GetInt(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.TryGetInt32(out var n) ? n : 0;

    /// <summary>
    /// 整数を読む。無い・null・数でないときは null。
    ///
    /// GetInt は取れなかったものを 0 にするので、0 に意味がある値（取り寄せの 0%）には使えない。
    /// 「0 と不明を分ける」をこちらで守る。
    /// </summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    public static int? GetIntOrNull(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.TryGetInt32(out var n) ? n : null;

    /// <summary>長い整数を読む。時刻（ミリ秒）はこちら。</summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    public static long GetLong(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.TryGetInt64(out var n) ? n : 0;

    /// <summary>文字列を読む。無い・文字列でないときは null。</summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    public static string? GetString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

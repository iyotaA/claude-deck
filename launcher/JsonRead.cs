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
///
/// **数を読む前に ValueKind を見る。** TryGetInt32 / TryGetInt64 は名前に反して、
/// 値が数でないと false を返さずに InvalidOperationException を投げる。
/// 紙には取り寄せ中以外いつも "progress": null が載るので、見ずに呼ぶと
/// ReadState() が毎回 catch へ落ちて「前回は無い」になっていた（実測。1.2.0 への更新で
/// --restarted が requested を読めず、done を書かないまま「入れ替えています」で止まった）。
/// </summary>
static class JsonRead
{
    /// <summary>整数を読む。無い・数でないときは 0。</summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    public static int GetInt(JsonElement root, string name) =>
        IsNumber(root, name, out var v) && v.TryGetInt32(out var n) ? n : 0;

    /// <summary>
    /// 整数を読む。無い・null・数でないときは null。
    ///
    /// GetInt は取れなかったものを 0 にするので、0 に意味がある値（取り寄せの 0%）には使えない。
    /// 「0 と不明を分ける」をこちらで守る。
    /// </summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    public static int? GetIntOrNull(JsonElement root, string name) =>
        IsNumber(root, name, out var v) && v.TryGetInt32(out var n) ? n : null;

    /// <summary>長い整数を読む。時刻（ミリ秒）はこちら。</summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    public static long GetLong(JsonElement root, string name) =>
        IsNumber(root, name, out var v) && v.TryGetInt64(out var n) ? n : 0;

    /// <summary>文字列を読む。無い・文字列でないときは null。</summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    public static string? GetString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>キーがあり、値が数か。TryGet* を呼んでよいのはこれが true のときだけ。</summary>
    /// <param name="root">読む対象のオブジェクト。</param>
    /// <param name="name">キー。</param>
    /// <param name="value">見つかった値。</param>
    static bool IsNumber(JsonElement root, string name, out JsonElement value) =>
        root.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Number;
}

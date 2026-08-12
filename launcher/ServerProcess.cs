using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace ClaudeDeck;

/// <summary>
/// node（server.mjs）の起動・生存確認・停止。
///
/// 要点は1つ。**port.json を真実として扱わない。**
/// あれは「どこを叩けばいいか」の助言であって、異常終了すると古い紙がそのまま残る。
/// 読んだら必ず GET /api/health で裏を取る。ここを省くと
/// 「死んだポートを叩いて、立ち上がっていないのに立っていると判断する」が起きる。
/// </summary>
static class ServerProcess
{
    /// <summary>起動を待つ上限。</summary>
    const int StartTimeoutMs = 10000;

    /// <summary>停止を待つ上限。</summary>
    const int StopTimeoutMs = 10000;

    /// <summary>待つあいだの見に行く間隔。</summary>
    const int PollMs = 200;

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    /// <summary>port.json の中身。取れなかった項目は既定値のままにする。</summary>
    public record PortInfo(int Port, int Pid, string? Version, long StartedAt);

    /// <summary>/api/health の返事。version は古いサーバーだと入っていない。</summary>
    public record HealthInfo(string? Version, string? ConfigDir, int Clients);

    /// <summary>
    /// port.json を読む。無い・壊れているときは null。
    ///
    /// 書き込みは一時ファイル → rename なので、途中の欠けた JSON を掴むことは無い。
    /// それでも壊れている可能性は捨てない（未知の形で落ちない）。
    /// </summary>
    public static PortInfo? ReadPortFile()
    {
        try
        {
            if (!File.Exists(Paths.PortFile)) return null;

            using var doc = JsonDocument.Parse(File.ReadAllText(Paths.PortFile));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var port = GetInt(root, "port");
            if (port <= 0) return null;

            return new PortInfo(
                port,
                GetInt(root, "pid"),
                GetString(root, "version"),
                GetLong(root, "startedAt"));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>そのポートで ClaudeDeck が応えるか尋ねる。応えなければ null。</summary>
    public static async Task<HealthInfo?> HealthAsync(int port)
    {
        try
        {
            var body = await Http.GetStringAsync($"http://127.0.0.1:{port}/api/health");
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            // ok が真であることまで見る。別のものが同じポートに居る場合を弾く
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True) return null;

            return new HealthInfo(
                GetString(root, "version"),
                GetString(root, "configDir"),
                GetInt(root, "clients"));
        }
        catch
        {
            // 誰も居ない・別のものが居る・応答が JSON でない。どれも「動いていない」に倒す
            return null;
        }
    }

    /// <summary>
    /// 立っていなければ立てる。実ポートを返す。
    ///
    /// 立ち上げられなかったときは例外。呼ぶ側が理由を人に見せる。
    /// </summary>
    public static async Task<int> EnsureRunningAsync()
    {
        var existing = ReadPortFile();
        if (existing is not null)
        {
            var health = await HealthAsync(existing.Port);
            if (health is not null)
            {
                Log.Line($"すでに動いています ポート={existing.Port} 版={health.Version ?? "(不明)"}");
                return existing.Port;
            }
            Log.Line($"port.json はポート {existing.Port} を指していますが、応答がありません。立て直します");
        }

        return await StartAsync(existing?.StartedAt ?? 0);
    }

    /// <summary>node を起こして、応答するまで待つ。</summary>
    static async Task<int> StartAsync(long previousStartedAt)
    {
        if (Paths.NodeExe is null)
        {
            throw new InvalidOperationException(
                "node.exe が見つかりません。配布物なら runtime\\node.exe が欠けています。");
        }
        if (Paths.AppDir is null)
        {
            throw new InvalidOperationException(
                "server.mjs が見つかりません。配布物なら app\\ が欠けています。");
        }

        // 標準出力は cmd に食わせてファイルへ落とす。
        //
        // .NET から直接ファイルへ向ける口が無く、RedirectStandardOutput にすると
        // ランチャが終了した時点でパイプの読み手が消える。相手（node）は書けなくなり、
        // 運が悪いと EPIPE で落ちる。cmd を1枚挟むほうが確実で、余分なのは数百KBのプロセス1つだけ。
        //
        // /s を付けると「最初と最後の引用符を剥がして残りはそのまま」になる。
        // 引用符が二重・三重に絡んだときの解釈揺れを避けられる。
        var inner = new StringBuilder()
            .Append('"').Append(Paths.NodeExe).Append('"')
            .Append(" \"").Append(Paths.ServerMjs).Append('"')
            // --no-open は必ず渡す。渡さないと server 側が既定ブラウザを開き、
            // ランチャが開く Edge の窓と二重になる。窓を開けるのはランチャだけ、と決める
            .Append(" --no-open")
            .Append(" --port-file \"").Append(Paths.PortFile).Append('"')
            .Append(" > \"").Append(Paths.ServerLog).Append("\" 2>&1")
            .ToString();

        var psi = new ProcessStartInfo
        {
            FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
            Arguments = $"/d /s /c \"{inner}\"",
            WorkingDirectory = Paths.AppDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        // server 側はこれがあるときだけ「更新できる起動のされ方だ」と判断する
        psi.Environment["CLAUDE_DECK_LAUNCHER"] = Paths.LauncherExe;

        Directory.CreateDirectory(Paths.DataDir);
        Log.Line($"node を起動します: {Paths.NodeExe}");
        Log.Line($"  作業場所: {Paths.AppDir}");
        Log.Line($"  記録    : {Paths.ServerLog}");

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("node を起動できませんでした。");

        // 待ち方は2段。まず port.json が新しくなるのを待ち、それから health で裏を取る。
        // 紙だけを信じない（古い紙が残っていると、立ってもいないのに立ったことになる）
        var deadline = Environment.TickCount64 + StartTimeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            await Task.Delay(PollMs);

            var info = ReadPortFile();
            if (info is null || info.StartedAt <= previousStartedAt) continue;

            var health = await HealthAsync(info.Port);
            if (health is null) continue;

            Log.Line($"立ち上がりました ポート={info.Port} PID={info.Pid} 版={health.Version ?? "(不明)"}");
            return info.Port;
        }

        throw new TimeoutException(
            $"サーバーが {StartTimeoutMs / 1000} 秒たっても応答しませんでした。{Paths.ServerLog} を見てください。");
    }

    /// <summary>
    /// 止める。行儀よく頼んでから、聞かなければ力ずくで。
    ///
    /// 動いていなかった場合も true（望みの状態にはなっている）。
    /// </summary>
    public static async Task<bool> StopAsync()
    {
        var info = ReadPortFile();
        if (info is null)
        {
            Log.Line("port.json がありません。動いていないものとします");
            return true;
        }

        var health = await HealthAsync(info.Port);
        if (health is null)
        {
            Log.Line($"ポート {info.Port} に応答がありません。前回の名残の port.json を片付けます");
            TryDelete(Paths.PortFile);
            return true;
        }

        // content-type を付けないと書き込みの門番（isTrustedWrite）に断られる
        try
        {
            using var content = new StringContent("{}", Encoding.UTF8, "application/json");
            await Http.PostAsync($"http://127.0.0.1:{info.Port}/api/quit", content);
        }
        catch (Exception ex)
        {
            // 古いサーバーには /api/quit が無い。その場合は下の力ずくに落ちる
            Log.Line($"止める合図が通りませんでした: {ex.Message}");
        }

        var deadline = Environment.TickCount64 + StopTimeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            await Task.Delay(PollMs);
            if (await HealthAsync(info.Port) is null)
            {
                Log.Line($"止まりました（ポート {info.Port}）");
                return true;
            }
        }

        Log.Line("応答が続いています。力ずくで止めます");
        return KillByPid(info.Pid);
    }

    /// <summary>port.json に書かれていた PID を落とす。相手が node でなければ何もしない。</summary>
    static bool KillByPid(int pid)
    {
        if (pid <= 0) return false;
        try
        {
            using var proc = Process.GetProcessById(pid);
            // PID は使い回される。取り違えて別のものを殺さないよう、名前を確かめる
            if (!string.Equals(proc.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
            {
                Log.Line($"PID {pid} は node ではありません（{proc.ProcessName}）。何もしませんでした");
                return false;
            }
            proc.Kill(entireProcessTree: true);
            Log.Line($"止めました（PID {pid}）");
            return true;
        }
        catch (Exception ex)
        {
            Log.Line($"PID {pid} を止められませんでした: {ex.Message}");
            return false;
        }
    }

    static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch
        {
            // 消せなくても実害は無い（読む側は health で裏を取る）
        }
    }

    static int GetInt(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.TryGetInt32(out var n) ? n : 0;

    static long GetLong(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.TryGetInt64(out var n) ? n : 0;

    static string? GetString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace ClaudeDeck;

/// <summary>
/// node（server.mjs）の起動・生存確認・停止。
///
/// 守ることが2つある。どちらも port.json の読み方の話。
///
/// **1. port.json を真実として扱わない。**
/// あれは「どこを叩けばいいか」の助言であって、異常終了すると古い紙がそのまま残る。
/// 読んだら必ず GET /api/health で裏を取る。ここを省くと
/// 「死んだポートを叩いて、立ち上がっていないのに立っていると判断する」が起きる。
///
/// **2. 紙が無いことを「動いていない」と読まない。**
/// port.json を書くようになったのは途中からで、それより前に立ったサーバーは書かない。
/// 紙の有無で決めると、動いているものを見落として二重に起こしに行くことになる。
/// 探すときは必ず FindRunningAsync を通す。
/// </summary>
static class ServerProcess
{
    /// <summary>起動を待つ上限。</summary>
    const int StartTimeoutMs = 10000;

    /// <summary>停止を待つ上限。</summary>
    const int StopTimeoutMs = 10000;

    /// <summary>待つあいだの見に行く間隔。</summary>
    const int PollMs = 200;

    /// <summary>server.mjs の既定のポート。あちらの既定と同じ番号にする。</summary>
    const int DefaultPort = 4317;

    /// <summary>server.log から人に見せるために読む上限。末尾だけあればよい。</summary>
    const int LogTailMax = 8192;

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    /// <summary>port.json の中身。取れなかった項目は既定値のままにする。</summary>
    public record PortInfo(int Port, int Pid, string? Version, long StartedAt);

    /// <summary>/api/health の返事。version は古いサーバーだと入っていない。</summary>
    public record HealthInfo(string? Version, string? ConfigDir, int Clients);

    /// <summary>見つかった、いま動いているサーバー。</summary>
    public record RunningInfo(int Port, HealthInfo Health);

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

            var port = JsonRead.GetInt(root, "port");
            if (port <= 0) return null;

            return new PortInfo(
                port,
                JsonRead.GetInt(root, "pid"),
                JsonRead.GetString(root, "version"),
                JsonRead.GetLong(root, "startedAt"));
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
                JsonRead.GetString(root, "version"),
                JsonRead.GetString(root, "configDir"),
                JsonRead.GetInt(root, "clients"));
        }
        catch
        {
            // 誰も居ない・別のものが居る・応答が JSON でない。どれも「動いていない」に倒す
            return null;
        }
    }

    /// <summary>
    /// いま動いている ClaudeDeck を探す。見つからなければ null。
    ///
    /// **紙が無いことを「動いていない」と読まない。** ここは実測で踏んだ穴。
    ///
    /// 古い版のサーバー（port.json を書かない）が動いているとき、
    /// 紙だけを見ていると「誰も居ない」と判断して node を起こしに行く。
    /// ところが server.mjs 側には二重起動の見張りがあって、
    /// 同じポートの相手が ClaudeDeck だと分かると何もせず終了する。
    /// 結果、紙は永遠に書かれず、ランチャは10秒待ってタイムアウトで死ぬ。
    /// 画面には「サーバーが起動できませんでした」と出るが、実際は最初から動いている。
    /// いちばん分かりにくい壊れ方なので、探す口をここ1つに寄せる。
    /// </summary>
    public static async Task<RunningInfo?> FindRunningAsync()
    {
        foreach (var port in CandidatePorts())
        {
            var health = await HealthAsync(port);
            if (health is not null) return new(port, health);
        }
        return null;
    }

    /// <summary>
    /// 既存を探しに行くポートの候補。同じ番号は1回だけ返す。
    ///
    /// 既定の 4317 まで見るので、実質1〜3回で済む。
    /// 埋まっていたときにずれる先（+1 を12回）までは追わない。
    /// server.mjs は「相手が ClaudeDeck ならずらさずに終わる」ので、
    /// ずれた先に ClaudeDeck が居ることはない。
    /// </summary>
    static IEnumerable<int> CandidatePorts()
    {
        var seen = new HashSet<int>();
        foreach (var port in new[] { ReadPortFile()?.Port ?? 0, EnvPort(), DefaultPort })
        {
            if (port > 0 && seen.Add(port)) yield return port;
        }
    }

    static int EnvPort() =>
        int.TryParse(Environment.GetEnvironmentVariable("CLAUDE_DECK_PORT"), out var n) ? n : 0;

    /// <summary>
    /// 立っていなければ立てる。実ポートを返す。
    ///
    /// 立ち上げられなかったときは例外。呼ぶ側が理由を人に見せる。
    /// </summary>
    public static async Task<int> EnsureRunningAsync()
    {
        var running = await FindRunningAsync();
        if (running is not null)
        {
            Log.Line($"すでに動いています ポート={running.Port} 版={running.Health.Version ?? "(不明)"}");

            // 版が食い違うのは、別の場所の server.mjs が動いているとき
            // （リポジトリ直下から npm start したもの、旧方式の自動起動で立ったもの）。
            //
            // 勝手に止めない。何日も動いているものを別のプロセスが黙って落とすほうが行儀が悪い。
            // 代わりにここへ残す。画面の中身が古いことに気づいたとき、理由をここから辿れる
            if (running.Health.Version != Paths.Version)
            {
                Log.Line($"  ※ このランチャは {Paths.Version} です。別の場所の server.mjs が動いています");
            }
            return running.Port;
        }

        return await StartAsync(ReadPortFile()?.StartedAt ?? 0);
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
            if (info is not null && info.StartedAt > previousStartedAt)
            {
                var health = await HealthAsync(info.Port);
                if (health is not null)
                {
                    Log.Line($"立ち上がりました ポート={info.Port} PID={info.Pid} 版={health.Version ?? "(不明)"}");
                    return info.Port;
                }
            }

            // 相手がもう終わっているなら、これ以上待つ意味がない。
            // proc は cmd で、cmd は node を待ってから終わる。つまり cmd の終了＝node の終了。
            // 10秒待ち切ってから「応答がありません」と言うより、理由を添えてすぐ止まるほうがよい
            if (proc.HasExited)
            {
                throw new InvalidOperationException(
                    $"サーバーがすぐに終了しました（終了コード {proc.ExitCode}）。{ReadServerLogTail()}");
            }
        }

        throw new TimeoutException(
            $"サーバーが {StartTimeoutMs / 1000} 秒たっても応答しませんでした。{ReadServerLogTail()}");
    }

    /// <summary>
    /// server.log の末尾を読んで、人に見せる文の一部にする。
    ///
    /// 「server.log を見てください」で済ませない。
    /// 答えはそこに書いてあるのに、読むために別の窓を開かせることになる。
    /// 書いている相手が居るあいだに読むので FileShare.ReadWrite で開く。
    /// </summary>
    /// <param name="lines">末尾から何行ぶん見せるか。</param>
    /// <returns>そのまま文の後ろへ付けられる1文。読めなくても文にして返す。</returns>
    static string ReadServerLogTail(int lines = 6)
    {
        try
        {
            if (!File.Exists(Paths.ServerLog)) return $"記録もありません（{Paths.ServerLog}）。";

            using var stream = new FileStream(
                Paths.ServerLog, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (stream.Length > LogTailMax) stream.Seek(-LogTailMax, SeekOrigin.End);
            using var reader = new StreamReader(stream);

            var tail = reader.ReadToEnd()
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => !string.IsNullOrWhiteSpace(line))
                .TakeLast(lines)
                .ToArray();

            if (tail.Length == 0) return $"記録は空です（{Paths.ServerLog}）。";

            return $"サーバーの言い分:{Environment.NewLine}{string.Join(Environment.NewLine, tail)}";
        }
        catch (Exception ex)
        {
            return $"記録を読めませんでした（{Paths.ServerLog}）: {ex.Message}";
        }
    }

    /// <summary>
    /// 止める。行儀よく頼んでから、聞かなければ力ずくで。
    ///
    /// 動いていなかった場合も true（望みの状態にはなっている）。
    /// </summary>
    public static async Task<bool> StopAsync()
    {
        // ここも紙で決めない。紙を書かない古いサーバーを「動いていない」と見て、
        // 止めたつもりで残す形になる（--stop したのに画面が生きている）
        var running = await FindRunningAsync();
        if (running is null)
        {
            Log.Line("動いていません");
            if (File.Exists(Paths.PortFile))
            {
                Log.Line("前回の名残の port.json を片付けます");
                TryDelete(Paths.PortFile);
            }
            return true;
        }

        // content-type を付けないと書き込みの門番（isTrustedWrite）に断られる
        try
        {
            using var content = new StringContent("{}", Encoding.UTF8, "application/json");
            await Http.PostAsync($"http://127.0.0.1:{running.Port}/api/quit", content);
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
            if (await HealthAsync(running.Port) is null)
            {
                Log.Line($"止まりました（ポート {running.Port}）");
                return true;
            }
        }

        Log.Line("応答が続いています。力ずくで止めます");
        var pid = ReadPortFile()?.Pid ?? 0;
        if (pid <= 0)
        {
            Log.Line("PID が分かりません（port.json を書かない古いサーバーです）。手で止めてください");
            return false;
        }
        return KillByPid(pid);
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
}

using Velopack;

namespace ClaudeDeck;

/// <summary>終了コード。-Action status などから機械的に読めるように意味を持たせる。</summary>
static class ExitCode
{
    public const int Ok = 0;
    public const int ServerFailed = 1;
    public const int WindowFailed = 2;
    public const int UpdateFailed = 3;
    public const int NotImplemented = 8;
    public const int Fatal = 9;
}

static class Program
{
    /// <summary>
    /// 入口。ここは同期のまま保つ。
    ///
    /// async Task&lt;int&gt; Main にしてはいけない。
    /// コンパイラが本体を状態機械へ畳むので、Run() の呼び出しが
    /// &lt;Main&gt;d__0::MoveNext() の中へ移る。
    /// vpk pack がそれを見つけて「入口に見えない」と警告を出す（実測）。
    /// 同期で受けて続きを別のメソッドへ渡せば、Run() は正真正銘いちばん最初になる。
    ///
    /// WinExe には既定の SynchronizationContext が無いので、
    /// GetResult() で待っても行き詰まらない。
    /// </summary>
    static int Main(string[] args)
    {
        // ここが最初。ちょうど1回。
        //
        // インストール・更新・アンインストールのときに Velopack が --veloapp-* を付けて
        // 自分自身を呼ぶ。その処理はここで済んで、そのまま exit する。
        // 自前の引数解析をこれより前に置くと、その引数を「未知のもの」として扱ってしまう。
        VelopackApp.Build().Run();

        return MainAsync(args).GetAwaiter().GetResult();
    }

    static async Task<int> MainAsync(string[] args)
    {
        Log.Open();
        Log.Line($"ClaudeDeck {Paths.Version} 引数=[{string.Join(' ', args)}]");
        Log.Line($"  自分    : {Environment.ProcessPath}");
        Log.Line($"  app     : {Paths.AppDir ?? "(見つからない)"}");
        Log.Line($"  node    : {Paths.NodeExe ?? "(見つからない)"}{(Paths.NodeBundled ? "（同梱）" : "")}");

        try
        {
            return await DispatchAsync(args);
        }
        catch (Exception ex)
        {
            Log.Fatal(ex);
            // 人が押して起動したときだけ知らせる。
            // --background（ログオン直後）で、誰も見ていない画面にダイアログを残さない
            if (!IsBackground(args))
            {
                Log.Box("ClaudeDeck を起動できませんでした", ex.Message);
            }
            return ExitCode.Fatal;
        }
        finally
        {
            Log.Close();
        }
    }

    static async Task<int> DispatchAsync(string[] args)
    {
        // 最初に見つかった --… を命令として扱う。順番に意味を持たせない
        var command = args.FirstOrDefault(a => a.StartsWith("--", StringComparison.Ordinal)) ?? "";

        return command switch
        {
            "" => await RunNormalAsync(openWindow: true),
            "--background" => await RunNormalAsync(openWindow: false),
            "--open" => await RunNormalAsync(openWindow: true),
            "--stop" => await RunStopAsync(),
            "--status" => await RunStatusAsync(),
            "--check-update" => await RunCheckUpdateAsync(),

            // ここから下は段を分けて足す。いまは「無い」と正直に言う。
            // 黙って 0 を返すと、呼んだ側は成功したと思い込む
            "--apply-update" or "--restarted"
                or "--install-startup" or "--uninstall-startup" => NotImplemented(command),

            _ => NotImplemented(command),
        };
    }

    /// <summary>ふつうの起動。立っていなければ立てて、必要なら窓を開く。</summary>
    static async Task<int> RunNormalAsync(bool openWindow)
    {
        int port;
        try
        {
            port = await ServerProcess.EnsureRunningAsync();
        }
        catch (Exception ex)
        {
            Log.Fatal(ex);
            if (openWindow) Log.Box("ClaudeDeck を起動できませんでした", ex.Message);
            return ExitCode.ServerFailed;
        }

        var code = ExitCode.Ok;
        if (openWindow && !EdgeWindow.Open(port)) code = ExitCode.WindowFailed;

        // 窓を開けてから確認する。逆にすると、回線が細い日に窓が最大20秒遅れて出る。
        // 結果は終了コードに混ぜない。更新を確認できないことは起動の失敗ではないので、
        // ここで 0 以外を返すと「回線が細いとアプリが立たない」に化ける
        await Updates.CheckQuietlyAsync();

        return code;
    }

    /// <summary>
    /// 更新を確認して結果を出すだけ。落としも入れ替えもしない。
    ///
    /// 人が自分で叩いたときは前回からの間隔を無視する。
    /// 「いま確かめたい」に「30分待って」と返す道具は使い物にならない。
    /// </summary>
    static async Task<int> RunCheckUpdateAsync()
    {
        Log.AttachToParentConsole();

        var state = await Updates.CheckAsync(force: true);

        Console.WriteLine(Updates.Describe(state.State));
        Console.WriteLine($"  いまの版: {state.Current}");
        if (state.Available is not null) Console.WriteLine($"  新しい版: {state.Available}");
        if (state.Error is not null) Console.WriteLine($"  理由    : {state.Error}");
        Console.WriteLine($"  記録    : {Paths.UpdateFile}");

        // 確認そのものができなかったときだけ 0 以外を返す。「最新だった」は失敗ではない
        return state.State is "unreachable" or "failed" ? ExitCode.UpdateFailed : ExitCode.Ok;
    }

    static async Task<int> RunStopAsync()
    {
        return await ServerProcess.StopAsync() ? ExitCode.Ok : ExitCode.ServerFailed;
    }

    /// <summary>
    /// 診断。何がどこにあり、いま何が動いているかを出す。
    ///
    /// 配布物が壊れているとき（app\ や runtime\ が欠けているとき）に、
    /// どこまで揃っているかを人が確かめられる場所がこれ1つになる。
    /// </summary>
    static async Task<int> RunStatusAsync()
    {
        Log.AttachToParentConsole();

        Console.WriteLine($"ClaudeDeck ランチャ {Paths.Version}");
        Console.WriteLine();
        Console.WriteLine("■ 置き場所");
        Console.WriteLine($"  自分        : {Environment.ProcessPath}");
        Console.WriteLine($"  app         : {Paths.AppDir ?? "(見つからない)"}");
        Console.WriteLine($"  node        : {Paths.NodeExe ?? "(見つからない)"}{(Paths.NodeBundled ? "（同梱）" : "（PATH から）")}");
        Console.WriteLine($"  更新の入口  : {Paths.LauncherExe}");
        Console.WriteLine($"  書き込み先  : {Paths.DataDir}");
        Console.WriteLine($"  Edge        : {EdgeWindow.Find() ?? "(見つからない。既定のブラウザで開きます)"}");

        Console.WriteLine();
        Console.WriteLine("■ 実ポートの記録");
        var info = ServerProcess.ReadPortFile();
        if (info is null)
        {
            Console.WriteLine("  ありません（起動すると書かれます）");
        }
        else
        {
            Console.WriteLine($"  {Paths.PortFile}");
            Console.WriteLine($"  ポート {info.Port} / PID {info.Pid} / 版 {info.Version ?? "(不明)"}");
        }

        Console.WriteLine();
        Console.WriteLine("■ いまの状態");
        // 紙が無くても探す。ここを紙だけで決めると、
        // 紙を書かない古いサーバーが動いていても「動いていません」と出る
        var running = await ServerProcess.FindRunningAsync();
        if (running is null)
        {
            Console.WriteLine("  動いていません");
            if (info is not null)
            {
                Console.WriteLine("  ※ 記録は残っていますが応答がありません。前回の名残です");
            }
        }
        else
        {
            Console.WriteLine($"  動いています  : http://127.0.0.1:{running.Port}/");
            Console.WriteLine($"  版            : {running.Health.Version ?? "(返していない = 入れ替え前のもの)"}");
            Console.WriteLine($"  読み取り元    : {running.Health.ConfigDir}");
            Console.WriteLine($"  つないでいる窓: {running.Health.Clients}");
            if (info is null)
            {
                Console.WriteLine("  ※ port.json がありません。入れ替え前のサーバーが動いています");
            }
        }

        Console.WriteLine();
        Console.WriteLine("■ 更新");
        // ここでは取りに行かない。前回の記録を読むだけ（--status を通信で待たせない）
        var update = Updates.ReadState();
        if (update is null)
        {
            Console.WriteLine(Updates.IsOff()
                ? "  確認は止めてあります（CLAUDE_DECK_UPDATE_OFF）"
                : "  まだ確認していません");
        }
        else
        {
            Console.WriteLine($"  {Updates.Describe(update.State)}");
            Console.WriteLine($"  いまの版: {update.Current}");
            if (update.Available is not null) Console.WriteLine($"  新しい版: {update.Available}");
            if (update.Error is not null) Console.WriteLine($"  理由    : {update.Error}");
        }

        return ExitCode.Ok;
    }

    static int NotImplemented(string command)
    {
        var message = string.IsNullOrEmpty(command)
            ? "その引数は知りません。"
            : $"{command} はこの版にはまだありません。";
        Log.Line(message);
        Log.AttachToParentConsole();
        Console.WriteLine(message);
        Console.WriteLine("使えるもの: (引数なし) / --background / --open / --stop / --status / --check-update");
        return ExitCode.NotImplemented;
    }

    static bool IsBackground(string[] args) =>
        args.Contains("--background", StringComparer.Ordinal);
}

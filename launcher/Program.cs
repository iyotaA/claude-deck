using Velopack;

namespace ClaudeDeck;

/// <summary>終了コード。-Action status などから機械的に読めるように意味を持たせる。</summary>
static class ExitCode
{
    public const int OK = 0;
    public const int SERVER_FAILED = 1;
    public const int WINDOW_FAILED = 2;
    public const int UPDATE_FAILED = 3;
    public const int STARTUP_FAILED = 4;
    public const int NOT_IMPLEMENTED = 8;
    public const int FATAL = 9;
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
        // ログは Run() より前に開ける。
        //
        // 下のフック（OnFirstRun / OnBeforeUninstallFastCallback）は Run() の中で走る。
        // Log.Line は開く前でも例外にならず**黙って捨てる**ので、後で開けても落ちはしない。
        // 落ちない代わりに「登録した」「解除した」の記録が1行も残らなくなる。
        // 初回起動では Run() の後に MainAsync が append:false で開き直すため、
        // 仮に残っていても上書きで消える。
        //
        // これは引数の解析ではないので、すぐ下のきまりには触れない。
        Log.Open();
        Log.Line($"ClaudeDeck {Paths.Version} 引数=[{string.Join(' ', args)}]");
        Log.Line($"  自分    : {Environment.ProcessPath}");
        Log.Line($"  app     : {Paths.AppDir ?? "(見つからない)"}");
        Log.Line($"  node    : {Paths.NodeExe ?? "(見つからない)"}{(Paths.NodeBundled ? "（同梱）" : "")}");

        // ここが最初。ちょうど1回。
        //
        // インストール・更新・アンインストールのときに Velopack が --veloapp-* を付けて
        // 自分自身を呼ぶ。その処理はここで済んで、そのまま exit する。
        // 自前の引数解析をこれより前に置くと、その引数を「未知のもの」として扱ってしまう。
        //
        // フックの中で投げると、インストーラ側から見て「入れられなかった」になる。
        // 自動起動は入れられなくても本体は使えるので、Startup 側で全部飲んで真偽で返す。
        //
        // OnFirstRun は**入れた直後の1回だけ**で、更新では呼ばれない。
        // 登録先は動かないスタブなので、更新のたびに書き直す必要も無い。
        // ずれたときは通常起動の Startup.Sync() が直す。
        //
        // OnBeforeUninstallFastCallback は走り終えると Velopack が
        // そのまま Environment.Exit を呼ぶ（30秒の制限つき）。
        // Log は AutoFlush なので、Close を通らなくても記録は残る。
        VelopackApp.Build()
            .OnFirstRun(_ => Startup.Install())
            .OnBeforeUninstallFastCallback(_ => Startup.Uninstall())
            .Run();

        return MainAsync(args).GetAwaiter().GetResult();
    }

    static async Task<int> MainAsync(string[] args)
    {
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
            return ExitCode.FATAL;
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
            "--apply-update" => await Updates.ApplyAsync(WaitPid(args)),
            "--restarted" => await RunRestartedAsync(),
            "--install-startup" => RunStartup(install:true),
            "--uninstall-startup" => RunStartup(install:false),

            _ => NotImplemented(command),
        };
    }

    /// <summary>
    /// --wait-pid の値を取り出す。
    ///
    /// server が自分の process.pid を書いて渡してくる。
    /// 掴んだままのファイルは差し替えられないので、これが消えてから入れ替える。
    /// </summary>
    /// <param name="args">コマンドラインの引数すべて。</param>
    /// <returns>待つ PID。指定が無い・読めないときは 0。</returns>
    static int WaitPid(string[] args)
    {
        var at = Array.IndexOf(args, "--wait-pid");
        if (at < 0 || at + 1 >= args.Length) return 0;
        return int.TryParse(args[at + 1], out var pid) && pid > 0 ? pid : 0;
    }

    /// <summary>
    /// 自動起動を登録・解除する。人が手で叩くためのもの。
    ///
    /// 画面からは触らせない。押した結果を返せないため。
    /// スタブ（&lt;install&gt;\ClaudeDeck.exe）は子の終了コードを伝えないので（実測）、
    /// server から叩いても成否が分からず、いつも「できました」と言うことになる。
    /// </summary>
    /// <param name="install">true なら登録、false なら解除。</param>
    /// <returns>終了コード。</returns>
    static int RunStartup(bool install)
    {
        Log.AttachToParentConsole();

        var ok = install ? Startup.Install() : Startup.Uninstall();
        var (state, legacy) = Startup.Peek();

        Console.WriteLine(install
            ? (ok ? "自動起動を登録しました。" : "自動起動を登録できませんでした。")
            : (ok ? "自動起動を解除しました。" : "自動起動を解除できませんでした。"));
        Console.WriteLine($"  いま        : {Startup.Describe(state)}");
        Console.WriteLine($"  前のやり方  : {Startup.DescribeLegacy(legacy)}");
        Console.WriteLine($"  記録        : {Paths.LauncherLog}");

        return ok ? ExitCode.OK : ExitCode.STARTUP_FAILED;
    }

    /// <summary>ふつうの起動。立っていなければ立てて、必要なら窓を開く。</summary>
    static async Task<int> RunNormalAsync(bool openWindow)
    {
        // サーバーより先にやる。ここで転んでも起動は止めない作りなので順番に危険は無く、
        // 逆に後ろへ置くと、サーバーが立たなかった日に旧方式が畳まれないまま残る。
        // 旧方式が残っていると次のログオンで node が二重に立ち、
        // 後から立ったほうが 4318 へずれて「画面は出るのに設定が反映されない」になる
        Startup.Sync();

        int port;
        try
        {
            port = await ServerProcess.EnsureRunningAsync(preferPort: 0);
        }
        catch (Exception ex)
        {
            Log.Fatal(ex);
            if (openWindow) Log.Box("ClaudeDeck を起動できませんでした", ex.Message);
            return ExitCode.SERVER_FAILED;
        }

        var code = ExitCode.OK;
        if (openWindow && !EdgeWindow.Open(port)) code = ExitCode.WINDOW_FAILED;

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
        return state.State is "unreachable" or "failed" ? ExitCode.UPDATE_FAILED : ExitCode.OK;
    }

    /// <summary>
    /// 入れ替わった後の起き直し。Velopack がこの引数で呼んでくる。
    ///
    /// ふつうの起動と3つ違う。
    ///
    /// 1. 版の照合を先にやる。
    ///    入れ替えそのものは Velopack の中で走るので、成否を見る手立ては
    ///    「起き直した自分の版」しかない。
    ///
    /// 2. **更新の確認をしない。**
    ///    done は IsSettled に入っていないので、ここで CheckQuietlyAsync を呼ぶと
    ///    間隔の見張りが効かず即座に確認が走る。結果 none で上書きされて、
    ///    「入れ替えました」の帯が一度も出ないまま消える。
    ///
    /// 3. **窓を開かない。**
    ///    更新を押せたということは、押した窓が生きている。
    ///    同じポートに戻せば人が何もしなくても復帰するので、開き直すと2つになる。
    /// </summary>
    /// <returns>終了コード。</returns>
    static async Task<int> RunRestartedAsync()
    {
        var prevPort = Updates.ConfirmRestart();

        try
        {
            var port = await ServerProcess.EnsureRunningAsync(preferPort: prevPort);

            // 戻せなかったときだけ窓を開ける。開いたままの窓は前の URL を叩き続けるので、
            // 番号が変わったなら誰かが開き直すしかない。人にやらせるより自分でやる
            if (prevPort > 0 && port != prevPort)
            {
                Log.Line($"前のポート {prevPort} に戻せませんでした（いま {port}）。窓を開き直します");
                if (!EdgeWindow.Open(port)) return ExitCode.WINDOW_FAILED;
            }
            else
            {
                Log.Line($"ポート {port} で戻りました。窓は開きません（押した窓がそのまま復帰します）");
            }

            return ExitCode.OK;
        }
        catch (Exception ex)
        {
            Log.Fatal(ex);
            // 押した本人が画面を見ている場面なので、--background と違って黙らない。
            // 何も出さないと「更新したら二度と開かなくなった」になる
            Log.Box("更新後にサーバーを起動できませんでした", ex.Message);
            return ExitCode.SERVER_FAILED;
        }
    }

    static async Task<int> RunStopAsync()
    {
        return await ServerProcess.StopAsync() ? ExitCode.OK : ExitCode.SERVER_FAILED;
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
        var running = await ServerProcess.FindRunningAsync(preferPort: 0);
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
            // 手で立てたものが混ざっていると、更新ボタンが押せない理由がこれになる。
            // 「動いているのに更新できない」を診断でそのまま説明できるようにする
            if (running.Health.StartedBy == ServerProcess.STARTED_BY_MANUAL)
            {
                Console.WriteLine("  ※ 手で立てた server.mjs です（npm start など）。更新はこの起動には当てられません");
            }
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

        Console.WriteLine();
        Console.WriteLine("■ 自動起動");
        // ここも読むだけ。--status で状態を変えない（見に来ただけで登録が動くと驚く）
        var (startup, legacy) = Startup.Peek();
        Console.WriteLine($"  {Startup.Describe(startup)}");
        Console.WriteLine($"  前のやり方: {Startup.DescribeLegacy(legacy)}");
        if (startup is "off")
        {
            Console.WriteLine("  ※ 登録するには ClaudeDeck.exe --install-startup");
        }

        return ExitCode.OK;
    }

    static int NotImplemented(string command)
    {
        var message = string.IsNullOrEmpty(command)
            ? "その引数は知りません。"
            : $"{command} はこの版にはまだありません。";
        Log.Line(message);
        Log.AttachToParentConsole();
        Console.WriteLine(message);
        Console.WriteLine("使えるもの: (引数なし) / --background / --open / --stop / --status");
        Console.WriteLine("            --check-update / --apply-update [--wait-pid <PID>] / --restarted");
        Console.WriteLine("            --install-startup / --uninstall-startup");
        return ExitCode.NOT_IMPLEMENTED;
    }

    static bool IsBackground(string[] args) =>
        args.Contains("--background", StringComparer.Ordinal);
}

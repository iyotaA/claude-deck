using System.Reflection;

namespace ClaudeDeck;

/// <summary>
/// どこに何があるかを決める唯一の場所。
///
/// 開発中と配布後で並びが変わるので、ここで吸収する。
///
///   配布後   &lt;install&gt;\current\ClaudeDeck.exe   … app\ と runtime\ が隣にいる
///   開発中   launcher\bin\Debug\...\ClaudeDeck.exe … リポジトリ直下に server.mjs がいる
///
/// どちらでも同じ呼び方で使えるようにしておく。
/// でないと「dotnet run では動くのに配布物では動かない」を毎回踏むことになる。
///
/// 書き込み先は src/shared/appdata.mjs と同じ %LOCALAPPDATA%\ClaudeDeck。
/// あちらは LOCALAPPDATA → XDG_STATE_HOME → HOME → アプリ直下の順に見るが、
/// ここは Windows 専用なので前の2つだけで足りる。
/// </summary>
static class Paths
{
    /// <summary>自分（ClaudeDeck.exe）が置かれている場所。</summary>
    public static string ExeDir { get; }

    /// <summary>server.mjs がある場所。見つからなければ null。</summary>
    public static string? AppDir { get; }

    /// <summary>node.exe の場所。同梱を先に見て、無ければ PATH。見つからなければ null。</summary>
    public static string? NodeExe { get; }

    /// <summary>node.exe が配布物に同梱されていたか。--status で出すためだけに持つ。</summary>
    public static bool NodeBundled { get; }

    /// <summary>
    /// 更新のときに叩く自分の入口。
    ///
    /// 配布後は &lt;install&gt;\ClaudeDeck.exe（スタブ。更新でも動かない）を指す。
    /// server 側はこれを CLAUDE_DECK_LAUNCHER で受け取り、
    /// 「更新できる起動のされ方だ」の判断に使う（リポジトリから npm start したときは無い）。
    /// </summary>
    public static string LauncherExe { get; }

    /// <summary>
    /// 入れて使われているか（&lt;install&gt;\current\ の中にいるか）。
    ///
    /// 自動起動の登録は配布形のときだけやる。開発中のビルド出力を
    /// ログオン時に立てても、次に消したら二度と立たない値が残るだけになる。
    /// </summary>
    public static bool IsDeployed { get; }

    /// <summary>書き込み先。ここだけは何があっても消さない（利用者のもの）。</summary>
    public static string DataDir { get; }

    public static string ServerMjs => Path.Combine(AppDir ?? ExeDir, "server.mjs");
    public static string PortFile => Path.Combine(DataDir, "port.json");
    public static string LauncherLog => Path.Combine(DataDir, "launcher.log");
    public static string ServerLog => Path.Combine(DataDir, "server.log");

    /// <summary>
    /// 更新の確認結果を置く紙。
    ///
    /// 書くのはここ（C#）だけ、読むのは Node（src/update/state.mjs）だけ。
    /// 向きを一方通行にしてあるので、両側に同じ判断を持たずに済む。
    /// </summary>
    public static string UpdateFile => Path.Combine(DataDir, "update.json");

    /// <summary>
    /// 自動起動の様子を置く紙。update.json と同じ向き（C# が書き、Node が読む）。
    ///
    /// レジストリを Node からも見に行けば1枚減らせるが、
    /// そうすると「どこに何を登録したか」の知識が C# と Node の2箇所に生きる。
    /// 片方が古くなる形は作らない。
    /// </summary>
    public static string StartupFile => Path.Combine(DataDir, "startup.json");

    /// <summary>
    /// Edge に持たせるプロファイル。
    ///
    /// 普段のプロファイルと分ける。画面側が localStorage に配色・onlyLive・
    /// 時系列の向きを覚えているので、同居させると閲覧データを消したときに
    /// 画面の状態まで一緒に消える。普段の Edge を全部閉じたときの巻き添えも避けられる。
    /// </summary>
    public static string EdgeProfile => Path.Combine(DataDir, "edge-profile");

    /// <summary>この実行ファイルの版。release.ps1 が渡した値。開発ビルドでは 0.0.0-dev。</summary>
    public static string Version { get; }

    static Paths()
    {
        ExeDir = Path.GetDirectoryName(Environment.ProcessPath ?? "") ?? Directory.GetCurrentDirectory();
        AppDir = FindAppDir(ExeDir);
        (NodeExe, NodeBundled) = FindNode(ExeDir);
        (LauncherExe, IsDeployed) = FindLauncherExe(ExeDir);
        DataDir = FindDataDir();
        Version = FindVersion();
    }

    /// <summary>server.mjs を探す。配布形を先に見て、無ければ上へ辿る。</summary>
    static string? FindAppDir(string exeDir)
    {
        // 配布形。app\ の中の相対関係は staging で崩さないと決めてある
        var bundled = Path.Combine(exeDir, "app");
        if (File.Exists(Path.Combine(bundled, "server.mjs"))) return bundled;

        // 開発形。bin\Debug\net10.0-windows\win-x64\ から4つ上がリポジトリ直下。
        // 構成（Debug/Release）や RID の有無で深さが変わるので、余裕を持って辿る
        var dir = new DirectoryInfo(exeDir);
        for (var i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "server.mjs"))) return dir.FullName;
        }
        return null;
    }

    /// <summary>node.exe を探す。同梱を優先する（配布先の node の版に左右されないため）。</summary>
    static (string?, bool) FindNode(string exeDir)
    {
        var bundled = Path.Combine(exeDir, "runtime", "node.exe");
        if (File.Exists(bundled)) return (bundled, true);

        // 開発中はここに落ちる。PATH を順に見る（where.exe を起動するより速い）
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var entry in path.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(entry.Trim().Trim('"'), "node.exe");
                if (File.Exists(candidate)) return (candidate, false);
            }
            catch
            {
                // PATH に壊れた値が混ざっていても、次を見るだけ
            }
        }
        return (null, false);
    }

    /// <summary>更新のときに叩く入口と、配布形かどうかを決める。</summary>
    /// <param name="exeDir">自分が置かれている場所。</param>
    /// <returns>入口のパスと、配布形なら true。</returns>
    static (string, bool) FindLauncherExe(string exeDir)
    {
        // 配布形かどうかは、自分が current\ の中にいるかで見る。
        // パスの存在だけで判断すると、開発中に隣の何かを拾う余地が残る
        var isDeployed = string.Equals(
            new DirectoryInfo(exeDir).Name, "current", StringComparison.OrdinalIgnoreCase);

        if (isDeployed)
        {
            var stub = Path.GetFullPath(Path.Combine(exeDir, "..", "ClaudeDeck.exe"));
            // スタブが実在するときだけ配布形と認める。
            // ここを指せば、更新で current\ が丸ごと入れ替わっても登録は動かない
            if (File.Exists(stub)) return (stub, true);
        }
        return (Environment.ProcessPath ?? "", false);
    }

    static string FindDataDir()
    {
        var baseDir = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (string.IsNullOrWhiteSpace(baseDir))
        {
            baseDir = Environment.GetEnvironmentVariable("XDG_STATE_HOME");
        }
        if (string.IsNullOrWhiteSpace(baseDir))
        {
            baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        }
        return Path.Combine(baseDir, "ClaudeDeck");
    }

    static string FindVersion()
    {
        // AssemblyInformationalVersion には prerelease タグ（-dev）まで入る。
        // AssemblyVersion は 4桁の数値しか持てず、0.0.0-dev が 0.0.0 に丸まってしまう
        var attr = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>();
        var value = attr?.InformationalVersion;
        return string.IsNullOrWhiteSpace(value) ? "0.0.0-dev" : value;
    }
}

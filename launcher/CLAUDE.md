# ランチャ（C#）と配布・更新

> `launcher/` と `scripts/release.ps1` を触るとき、版を上げるとき、配布物を作るときに読む。
> Node 側が紙を読む話は `src/update/CLAUDE.md`。
> 全体の地図と横断の約束はルートの `CLAUDE.md` にある。

## ファイルの一覧

窓を出すのと更新を当てるのだけが仕事。10枚ある。

| ファイル | 役割 |
|---|---|
| `ClaudeDeck.csproj` | ビルドの設定。単一ファイル・トリム・自己完結 |
| `Program.cs` | 入口。`VelopackApp` を起こしてから引数を振り分ける |
| `Paths.cs` | 場所を決める。`current\` とデータフォルダの境目はここだけ |
| `ServerProcess.cs` | node の起動・生存確認・停止 |
| `EdgeWindow.cs` | Edge を探してアプリモードで開く。無ければ既定のブラウザ |
| `Updates.cs` | 確認・落とす・当てる。`update.json` を書く |
| `Startup.cs` | HKCU Run への登録と、前の方式の `.lnk` の無効化 |
| `Log.cs` | `launcher.log` と、人が押したときだけ出すダイアログ |
| `Paper.cs` | 紙を書く（一時ファイル → rename） |
| `JsonRead.cs` | 紙を読む（`JsonDocument`） |

**`src/` の下に置かない。** 上の表は Node のモジュールを前提にしていて、
そこへ C# を混ぜると層の向きの話が通じなくなる。ルート直下なら表に1行足すだけで済む。

`.sln` は作らない。`dotnet publish launcher\ClaudeDeck.csproj` で足りる。


## 更新（新しい版へ入れ替える）

`launcher/` と `src/update/`。直すたびにフォルダを配り直す形をやめるための機能。
使う人が増えるほど古い版が残り続けるので、そこを埋める。

**2回目以降は delta だけが降りる。実測 37.2KB**（0.2.0 → 0.2.1）。
full は 42.7MB なので 1/1000 以下になる。
`vpk` のログは `0086 files. 0005 patched, 0081 unchanged, 0000 new, 0000 removed`。

node.exe（83MB）を同梱しているが、**更新のたびにそれが落ちてくるわけではない。**
差し替わらなかったファイルは前の版から持ってくる。
だから `vpk download github` を pack の前に必ず通す（前の版が手元に無いと、毎回 full になる）。

### 器を2つに分けてある

**`--packId ClaudeDeckApp` ／ `--packTitle ClaudeDeck`。**

Velopack の既定のインストール先は `%LOCALAPPDATA%\{packId}`。
ここを `ClaudeDeck` にすると `shared/appdata.mjs` の書き込み先とまるかぶりになり、
**アンインストールで `config.json`（生の Slack Webhook 入り）が黙って消える。**

| 場所 | 中身 | 消えるとき |
|---|---|---|
| `%LOCALAPPDATA%\ClaudeDeckApp\` | `ClaudeDeck.exe`（スタブ） `Update.exe` `current\` `packages\` | アンインストールで消える |
| `%LOCALAPPDATA%\ClaudeDeck\` | `config.json` `port.json` `update.json` `startup.json` 各ログ | 何があっても消さない |

分けた副作用として、`appdata.mjs` を1行も触らずに済んでいる。


### 紙が2枚（書く側）

どちらも `%LOCALAPPDATA%\ClaudeDeck\` に置く。書くのは `launcher/Paper.cs` だけ。

| 紙 | 書く人 | 読む人 |
|---|---|---|
| `update.json` | `launcher/Updates.cs` | `src/update/state.mjs` |
| `startup.json` | `launcher/Startup.cs` | `src/startup/state.mjs` |

書き方は**一時ファイル → rename**（`notify/settings.mjs` と同じ作法）。
読む側が書きかけの半端な JSON を掴まない。
語彙と読み方は `src/update/CLAUDE.md` にある。
### 自動起動

登録先は `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。
指すのは**スタブの絶対パス**（`%LOCALAPPDATA%\ClaudeDeckApp\ClaudeDeck.exe --background`）。

スタブは更新でも動かないので、「フォルダが動いて黙って壊れる」という
前の方式（`.lnk` に node.exe とアプリの絶対パスを焼き込む）の弱点が構造的に消える。

`.lnk` を作るには COM（`IShellLink`）が要り、**トリムを掛けた単一ファイルと相性が悪い。**
`Microsoft.Win32.Registry` なら2行で済む。アイコンが付かないのは惜しいが、割に合わない。

前の方式の `.lnk` は、通常起動のたびに見に行く。あれば**消さずに `.disabled` へ改名する。**
放っておくと2つのサーバーがポートを取り合い、
「画面は出るのに設定が反映されない」という追いにくい形になる。

**画面に登録・解除の口は作らない。** スタブは子の終了コードを伝えない（実測）ので、
画面から叩いても成否が分からず、いつも「できました」と言うことになる。
入切は `ClaudeDeck.exe --install-startup` / `--uninstall-startup` の役目。

### 版の出どころは1箇所

```
package.json "version"
     ├─→ src/shared/appinfo.mjs   起動時に1回読む。/api/health と /api/update が返す
     └─→ scripts/release.ps1      ここが唯一の読み手
              ├─→ dotnet publish -p:Version=<v>
              └─→ vpk pack --packVersion <v>
```

3つが同期するのではなく、**2つが1つから派生する。**
C# 側に版を書き写さない。`vpk` に手で打たない。

## 触るときに壊してはいけないこと（ランチャ・配布）

- **packId を `ClaudeDeck` にしない。** Velopack の既定の入れ先は `%LocalAppData%\{packId}` なので、書き込み先の `%LOCALAPPDATA%\ClaudeDeck\` とまるかぶりになり、アンインストールで `config.json`（**生の Webhook URL 入り**）が黙って消える。`--packId ClaudeDeckApp` ＋ `--packTitle ClaudeDeck` で分ける
- **Edge の窓を閉じない。** 他アプリの窓を勝手に殺すのは行儀が悪い。`CLAUDE_DECK_PORT` に前のポートを渡して立て直し、開いたままの窓が自力で戻れるようにする
- **画面に自動起動の登録・解除の口を作らない。** スタブ（`<install>\ClaudeDeck.exe`）は子の終了コードを伝えない（実測）ので、押した結果を返せず、いつも「できました」と言うことになる。入切は `--install-startup` / `--uninstall-startup` の役目
- **旧方式の `.lnk` を消さない。** `ClaudeDeck.lnk.disabled` へ改名するだけにする。利用者がいつでも戻せる形を残す
- **C# 側で `JsonSerializer` / `Deserialize<T>` を使わない。** 反射を通るので `PublishTrimmed` で黙って削られ、**実行時にだけ**落ちる。書くのは `Utf8JsonWriter`（`Paper.cs`）、読むのは `JsonDocument`（`JsonRead.cs`）
- **Velopack のフックは `On*`。** `VelopackApp.Build().OnFirstRun(...).OnBeforeUninstallFastCallback(...).Run()`。`With*` ではない
- **`VelopackApp.Run()` より前に自前の引数解析を置かない。** `--veloapp-*` を未知の引数として扱ってしまう。`Main` の最初、ちょうど1回
- **`--no-open` を外さない。** 窓を開けるのはランチャだけと決めてある。外すと `openBrowser` が既定ブラウザを開き、Edge のアプリ窓と二重になる
- **`port.json` を真実として扱わない。** 必ず `/api/health` で裏を取る。異常終了で古いファイルが残るのは正常な状態
- **`port.json` を書く・消すのは `--port-file` を渡された起動だけ。** 紙は1枚しかないので、同じマシンで2本立つと後から立ったほうが上書きし、先に止めたほうが消す。実際に踏んだ（インストール版が 4317 で動いているのに紙だけ消えた。開発側の `npm start` を Ctrl+C した後始末が巻き添えにしていた）。判定は `hasPortFileFlag`。**`CLAUDE_DECK_PORT` で分岐してはいけない** — 更新後の再起動でランチャ自身が `CLAUDE_DECK_PORT=prevPort` を渡すので、インストール版でも立つ。書き先の分岐に使うと更新直後だけ別の場所に書くことになる
- **配布物は許可リストで組む。** 除外リストは黙って古くなる（`assets/` を除いていても、次に足した大きなフォルダは素通りする）。許可リストなら足し忘れたときにアプリが起動せず、その場で分かる
- **版の出どころを増やさない。** `package.json` の `version` の1箇所から `appinfo.mjs` と `release.ps1` が派生する。3つが同期するのではなく、2つが1つから派生する形にする。C# 側に版を書き写さない・`vpk` に手で打たない

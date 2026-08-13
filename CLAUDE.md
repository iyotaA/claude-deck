# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このプロジェクトは何か

並行して動かしている Claude Code のセッションを、一覧と詳細で見るローカルダッシュボード。

`~/.claude` 配下に Claude Code 自身が書いているファイルを **読み取り専用** で解析する。
目的は2つに絞られている。

- どのセッションが自分の返事を待っているか（ボールの所在）
- そのセッションで自分が何を判断したか（選んだ選択肢とその説明）

外部パッケージはゼロ。Node.js 18 以降の標準モジュールだけで動く。

配るときだけ C# のランチャ（`launcher/`）が付く。
窓を出すのと、更新を当てるのがその仕事。
**本体はそれが有っても無くても同じように動く**（`node server.mjs` で C# は1行も通らない）。

## コマンド

```
npm start                        サーバー起動＋ブラウザを開く（= node server.mjs）
npm run serve                    サーバーだけ起動（= node server.mjs --no-open）
npm run list                     一覧をターミナルに1回出す
npm test                         回帰テストを走らせる（= node --test）
node cli.mjs --live              3秒ごとに出し直す
node cli.mjs --all               終了したものも含めて全部出す
ClaudeDeck.cmd                   フォルダごとコピーで渡した先の起動口。ダブルクリック用
```

配布物を作るのと、アイコンの作り直しは PowerShell スクリプト。

```
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Action all
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Action fetch-node|stage|pack|upload
powershell -ExecutionPolicy Bypass -File scripts\build-icons.ps1
```

`release.ps1` は `package.json` の `version` を唯一の出どころにする。
C# 側にも `vpk` にも版を書き写さない。**手で打つ口を作らない。**

`-Action upload` は pack し直さない。既存の `build\releases\` をそのまま上げる。
だから upload の前に、master と作業ツリーが一致していることを確かめる。

前の方式（フォルダごとコピー）の自動起動も残してある。
新しく入れた人には要らないが、既に使っている人の手元で生きている。

```
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action status
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action start|stop|uninstall
```

インストールした版は exe が窓口になる。

```
ClaudeDeck.exe                   立っていなければ立てて、窓を開く
ClaudeDeck.exe --background      窓を出さずに立てる（自動起動が使う）
ClaudeDeck.exe --open            窓だけ開く
ClaudeDeck.exe --stop            POST /api/quit で止める
ClaudeDeck.exe --status          診断。コンソールへ出す
ClaudeDeck.exe --install-startup / --uninstall-startup
```

置き場所は `%LOCALAPPDATA%\ClaudeDeckApp\ClaudeDeck.exe`。
**これはスタブで、更新でも動かない。** 自動起動が指すのはここ。

ポートは既定 4317。`CLAUDE_DECK_PORT` で変えられる。
埋まっていたら 12 回まで +1 してずらす。

### テスト・リンタ

テストは `node:test`（Node 18 以降に入っている標準のもの）で書いてある。
`npm test` で `test/` 配下が走る。外部パッケージは足していない。

**リンタは無い。** 設定していない。

```
npm test                         全部走らせる
node --test test/state.test.mjs  1ファイルだけ走らせる
```

`node --test test/` のようにフォルダを渡す形は使えない。
Node 22 以降は引数をグロブとして解釈するため、フォルダ名では見つからないと言われる。
引数なしの `node --test` が両方の版で動く。

見ているのは解析側と、判断だけを切り出した純関数。

| ファイル | 対象 |
|---|---|
| `state.test.mjs` | `deriveState` の分岐すべて（このアプリの心臓部） |
| `entries.test.mjs` | ログ1行から中身を取り出す小道具 |
| `digest.test.mjs` | 詳細の時系列。回答の抽出と間引き |
| `meta.test.mjs` | ログから拾う情報（`ai-title` などの実測した形） |
| `summary.test.mjs` | 見出しの出どころ。古い自己申告を見出しに使わないこと |
| `archive.test.mjs` | 書庫のクエリの丸め方 |
| `entry.test.mjs` | 原文を出すときに伏せる・切る判断 |
| `plans.test.mjs` | プランのパス検証と本文の突き合わせ |
| `subagents.test.mjs` | サブエージェントの記録と呼び出しの突き合わせ |
| `appdata.test.mjs` | 書き込み先の解決。ログと設定が同じ場所を指すこと |
| `appinfo.test.mjs` | 版の出どころ。読めないときに 0 でなく null を返すこと |
| `portfile.test.mjs` | `--port-file` の受け取り方と、既定の場所 |
| `origin.test.mjs` | 書き込み口の門番。どのヘッダの組み合わせを断るか |
| `notify-watch.test.mjs` | いつ何を送るかの状態機械（通知の本丸） |
| `notify-message.test.mjs` | 通知の本文。載せないものと、URL のマスク |
| `notify-config.test.mjs` | 設定の優先順と URL の検証 |
| `notify-settings.test.mjs` | 画面から来た設定の検証と併合。書き込む側の本丸 |
| `notify-slack.test.mjs` | Slack の応答をどう読むか |
| `notify-index.test.mjs` | 通知の配線。とくに失敗したときのふるまい |
| `update-state.test.mjs` | 更新の紙の読み方。stale の判定と、無い紙を異常にしないこと |
| `startup-state.test.mjs` | 自動起動の紙の読み方。紙が無いことを「動いていない」と読まないこと |

`digest.test.mjs` が呼ぶのは `buildDigest` だけ。
`parse/digest/` の4枚はその中から呼ばれるので、入口経由で見ていることになる。
分けたときにテストを1行も直さずに通ったのはこのため。
ここを分け直すときも、入口の名前と応答の形を変えなければテストは無変更で通る。

テストデータは `test/helpers.mjs` で組む。
実物の `~/.claude` は読まない。環境によって中身が変わり、前提にできないため。

ディスクを触る側（`listSubagents` / `readPlanFile` / `readHead` / `listArchive`）にはテストが無い。
`configDir` が import 時に一度だけ評価される定数なので、差し替えるには import 順の細工が要る。
代わりに**判断（純関数）と I/O（薄い殻）を分ける形**にして、判断だけをテストできるようにしてある。
`read/` 側に残っているのは「readdir して、名前で絞って、stat して、try/catch で飲む」だけ。

読み取り層（`read/`）と画面側にはテストが無い。
そこは実物で確かめる。

- ロジック側 … `node cli.mjs` を叩いて一覧が崩れないか見る
- 画面側 … サーバーを起動してブラウザで見る
- 見た目をヘッドレスで撮るときは `?nolive=1` を付ける（SSE がつながったままだとロード完了を待ち続ける）
- 「ターミナルを前面に」は実際に押す（`focus.ps1` へのパスはテストで拾えない）

`/api/health` が `{ok:true}` を返すかどうかが、生きているかの最短の確認。

## ファイルの置き場所

`src/` は役割ごとに8つに分けてある。
import は上から下へ一方向にだけ流れる。逆向きに import したくなったら、置き場所が間違っている。

| 場所 | 役割 | 中身 |
|---|---|---|
| `src/read/` | `~/.claude` を読む | `paths` `cache` `registry` `transcript` `tasks` `plans` `subagents` |
| `src/parse/` | ログを解釈する | `entries` `meta` `state` `digest` ＋ `digest/`（`limits` `answers` `waits` `trim`） |
| `src/view/` | API 応答を組む | `sessions`（一覧） `detail` `summary` `shape` `archive`（書庫） `entry`（原文） `plans`（プランの系譜） `subagent`（調査記録） |
| `src/notify/` | 回答待ちを外へ知らせる | `index`（配線） `watch`（状態機械） `message`（本文） `config`（読む） `settings`（書く） `slack`（送信） |
| `src/update/` | ランチャが書いた更新の紙を読む | `state` |
| `src/startup/` | ランチャが書いた自動起動の紙を読む | `state` |
| `src/shared/` | どの層からも使う小道具 | `text`（`oneLine` / `clip`） `tools`（`describeTool`） `appdata`（書き込み先） `origin`（書き込み口の門番） `appinfo`（版） `portfile`（`port.json`） |
| `src/os/` | OS を叩く | `focus` |

流れは `read` → `parse` → `view` → `notify`。
`shared` はどこからでも使えるが、逆に `shared` から他を import してはいけない。

`notify/` は末端に足した層で、**`view/` を import しない。**
`listSessions()` が返した行（ただの JSON）を受け取るだけにしてある。
これで向きが一方向のまま保たれ、テストも行のリテラルを渡すだけで書ける。

`update/` と `startup/` も末端で、どの層も import しない（`shared/appdata.mjs` だけ）。
やるのは「紙を1枚読んで、画面に出せる形に整える」だけ。
**判断はしない。** 更新を当てるかどうかも、自動起動を登録するかどうかも決めるのは C# 側で、
こちらは結果を読むだけにしてある。理由は「更新」の節に書いた。

入口は6つだけ。ここの名前と応答の形は変えない。

- `view/sessions.mjs:listSessions`
- `view/detail.mjs:getSessionDetail`
- `notify/index.mjs:createNotifier`
- `update/state.mjs:loadUpdateState`
- `startup/state.mjs:loadStartupState`
- `os/focus.mjs:focusTerminal`

`digest.mjs` に残しているのは走査の本体（`buildDigest`）と、走査の前に1回だけ作る索引だけ。
走査から呼ぶ判断は `digest/` の4枚に分けてある。`buildDigest` 本体は分けない
（1つのループで `items` と `files` と `stats` を同時に埋めているため）。

画面側は `public/` の下に2つ。

| 場所 | 役割 | 中身 |
|---|---|---|
| `public/css/` | 見た目 | 9枚。`<link>` の並びがそのまま重ね順になる |
| `public/js/` | 画面の組み立て | 18枚 ＋ `timeline/` 7枚 |

こちらも import は一方向。層の一覧と、循環を切っている4箇所は「画面側」に書いてある。

`assets/favicon.png` はアイコンの元絵。1.3MB あるので `src/` には置かない。

### `launcher/`（C#）

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

## データの流れ

読み取り元は `src/read/paths.mjs` が解決する。`CLAUDE_CONFIG_DIR` があればそちらを優先する。

| 場所 | 中身 |
|---|---|
| `sessions/<PID>.json` | 稼働中セッションの登録簿 |
| `projects/<スラッグ化した cwd>/<セッションID>.jsonl` | 会話ログ |
| `tasks/<セッションID>/<番号>.json` | TODO の状態 |

一覧と詳細で経路が分かれている。ここが性能設計の中心。

```
一覧  read/registry.mjs（登録簿）＋ read/transcript.mjs:indexTranscripts
      → readTail（末尾 64KB だけ。足りなければ4倍ずつ広げる）
      → parse/state.mjs:deriveState ＋ parse/meta.mjs:extractMeta
      → view/sessions.mjs:listSessions が行を組んで状態順に並べる

詳細  readAll（全文。詳細を開いたときだけ）
      → parse/digest.mjs:buildDigest（時系列を決定論的に組む）
      → read/tasks.mjs:readTasks ＋ view/summary.mjs:summarize
      → view/detail.mjs:getSessionDetail
```

`read/cache.mjs` がサイズと mtime を印にしてパース結果を memo する。
会話ログは追記しか起きないので、印が同じなら前回の値を使い回せる。
一覧を毎秒引いても重くならないのはこの土台のおかげ。

`parse/entries.mjs` が会話ログ1行から中身を取り出す共通の小道具。
`state.mjs` と `digest.mjs` と `meta.mjs` が使うので、形の解釈はここに集約する。

一覧と詳細で同じ項目（`name` や `project` など）は `view/shape.mjs` が組む。
以前は両方が別々に組んでいて、片方だけにフォールバックが付いている状態になっていた。

## 状態判定（このアプリの心臓部）

`src/parse/state.mjs`。会話ログは「assistant がツールを呼ぶ → 結果の行が来る」の繰り返しで進む。

結果の来ていない呼び出しが残ったまま追記が止まっていれば、それは Claude が止まっている状態。
これを **dangling** と呼ぶ。判定はこの1点を軸に組み立てている。

誤判定を避けるための段階は次の順で見る。

1. `AskUserQuestion` / `ExitPlanMode` の dangling … 「あなたを待つ」以外の用途が無いので即確定
2. 登録簿の `status` が待ち系（`idle` / `waiting` 等）＋ 追記停止 … 従う
3. 登録簿が `busy` ＋ 追記が直近 … 実行中
4. ふつうのツールの dangling … 15秒（`APPROVAL_MS`）止まっていれば承認待ち。長く走る Bash と区別するため
5. dangling 無し ＋ 末尾が assistant の発言 … 返信待ち

判定結果には `reason` と `confident` を必ず持たせる。
自信が無いものは画面側で印を付ける。断定して外すより、迷っていると伝えたほうが役に立つ。

`STATE_RANK` が一覧の並び順。小さいほど上、つまり先に手をつけるべきもの。

同じ状態のあいだは `idleMs` の昇順、つまり動きが新しいものを上に出す。
`idleMs` が取れないものは「不明」なので末尾へ寄せる（0 に丸めると最新扱いで先頭に出てしまう）。

## 通知（回答待ちを Slack へ）

`src/notify/`。席を外している間に質問が出て止まっても、戻るまで気づけない。
そこを埋めるためだけの機能で、**設定しなければ何も起きない。**

このアプリ初の外向き通信なので、`view/summary.mjs` 冒頭の作法をそのまま守る。
鍵が無ければ黙って何もしない。失敗しても本体を落とさない。

### どの状態を送るか

`notify/watch.mjs` の `NOTIFY_RULES` が一覧。状態ごとに扱いが違う。

| 状態 | 落ち着き待ち | 追加の条件 |
|---|---|---|
| `needs-answer`（質問待ち） | 6秒 | なし |
| `needs-plan-approval`（プラン承認待ち） | 6秒 | なし |
| `needs-approval`（承認待ち） | 6秒 | `byStatus` が真のときだけ |
| `awaiting-reply`（返信待ち） | 2分 | `stateConfident` が真のときだけ |

**質問待ちは、ほぼ発火しない。**
実測（2026-08-06）で、Claude Code は質問を出しているあいだ
`tool_use(AskUserQuestion)` の行をディスクに書かないことが分かった。
書かれるのは答えたときで、それまでは直前の地の文までしか載っていない。

Claude Code は assistant の1ターンを thinking / text / tool_use と
別々の行に分けて書く。質問中はその text の行までで止まる。
だから dangling が見つからず、2分8秒の待ちがまるごと `awaiting-reply` に見えていた。
500ms 間隔で 494 回の観測を取り、そのあいだ一度も `tool=AskUserQuestion` が出なかった。
ログを行860（質問の直前の地の文）で切ると、サーバーが出し続けていた
`awaiting-reply / 応答を返し終えて停止` が理由の文字列まで完全に再現できる。

**なので実際に鳴るのは `awaiting-reply` の経路。**
質問待ちの2行は、Claude Code 側が書くようになったときに先に立って速く鳴るための備え。
ここを消さない。

`needs-approval` に条件が付いているのは、経路が2つあるため。

- 登録簿の status が待ち系 ＋ 静か ＋ dangling → `byStatus` が真。Claude が自分で「動いていない」と言っている
- dangling が15秒（`APPROVAL_MS`）放置 → `byStatus` は偽。**50秒走る Bash も同じ形になる**（実測）

auto mode で Claude が自分で承認した分はそもそも止まらないので、
`byStatus` の側だけを見れば「人に聞きに来て止まっている」ものだけが残る。

### 何を「1つの待ち」と数えるか

**鍵は `sessionId` ＋ `tool_use.id`。この鍵1つにつき生涯1通。**

待っているツールが無い `awaiting-reply` は `tool_use.id` を持たない。
そこは `deriveState` が出す `anchorId`（ログの最後の行の uuid）で代える。
**セッション ID だけで鍵を作ってはいけない。** 鍵が生涯1つになり、
1通鳴ったきり2回目以降の返信待ちが黙って落ちる。
追記が止まっているのが返信待ちの条件なので、待っているあいだ錨は動かない。

`lastActivityAt` を鍵にしてはいけない。
`Math.max(tail.mtimeMs, 最終エントリ時刻)` で作られる値なので、
サブエージェントが走って親ログに追記が続くと、質問は同じなのに鍵が変わる。

`id` を鍵にすると、次の3つが同時に解ける。

- 状態のばたつき … `registry.mjs` は書き込み途中の壊れた JSON を飛ばす。飛ぶと `ended` に落ち、次の走査で戻る。鍵が同じなら何度往復しても1通
- セッションの復活 … PID は使い回されるので鍵に使えない。`sessionId` は `--resume` しても同じ
- 連続した質問 … Q1 に答えてすぐ Q2 が出ても、`id` が違うので別の待ちになる

### 時計とタイミング

| 定数 | 既定 | 理由 |
|---|---|---|
| `SETTLE_MS` | 6000 | `POLL_MS` の3倍。最低2回の独立した走査で「まだ待っている」を確認する。目の前にいて即答した分はここで落ちる |
| `IDLE_SETTLE_MS` | 120000 | 返信待ちだけの落ち着き待ち。席を外したときだけ鳴らしたいので長く取る。短くすると、目の前で少し考えているだけで鳴る。0 で返信待ちを丸ごと切れる |
| `FLUSH_MS` | 1000 | 送信タイマ。`refresh()` とは別の時計で回す |
| `GRACE_MS` | 10000 | 起動から10秒以内に見えた待ちは種まき（送らず既通知にする） |
| `MAX_PER_HOUR` | 30 | 暴走止め。超えたら止めて、止めたこと自体を1通だけ送る |
| `TIMEOUT_MS` | 5000 | `askRunning` の 1500ms は localhost 向けで、社外 HTTPS には短い |
| 再送 | 1回・4秒後 | 429・5xx・ネットワークのみ。400・401・403 は再送しない。404・410 は1回で止める |
| `FAIL_LIMIT` | 5 | 連続5通失敗で停止。理由を `/api/health` に出す |
| `QUEUE_MAX` | 20 | 溢れたら古いほうを捨て、捨てた数を次に届いた通知の末尾に添える |

種まきがあるのは、ログオン時の自動起動が前提だから。
これが無いと朝ログオンするたびに昨夜からの待ちが全部飛ぶ。
単に「30秒黙る」より優れているのは、種まきした鍵と新しい待ちの鍵が別物なので、
起動3秒後に始まった待ちを取りこぼさない点。

### 設定

**画面から保存した値がいちばん強い。**

```
値は  画面（config.json） > 環境変数 > 既定
```

以前は逆（環境変数が勝つ）だった。
画面から設定できるようにした時点で反転している。
保存したのに環境変数に負ける、では設定画面の意味が無い。

読むのは `notify/config.mjs`、書くのは `notify/settings.mjs`。
書き先は `%LOCALAPPDATA%\ClaudeDeck\config.json` だけ。

反転で穴が1つ空く。環境変数で通知を止める手段が無くなる。
`config.json` に URL が入っている限り、環境変数を空にしても止まらない。
そこを埋めるために、**止めるためだけの環境変数**を1本持たせてある。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `CLAUDE_DECK_NOTIFY_OFF` | なし | **何より強い。** `1` で全部止める。値は上書きできないが、機能ごと止めることはできる |
| `CLAUDE_DECK_SLACK_WEBHOOK` | なし | Webhook URL。画面でまだ設定していないときの初期値 |
| `CLAUDE_DECK_NOTIFY_SETTLE` | 6 | 落ち着き待ちの秒数。0 で即時 |
| `CLAUDE_DECK_NOTIFY_IDLE` | 2 | 返信待ちの落ち着き待ちの分。0 で返信待ちを通知しない |
| `CLAUDE_DECK_NOTIFY_REMIND` | 0 | 放置リマインドの分。0 で無効 |
| `CLAUDE_DECK_NOTIFY_DETAIL` | full | `none` にすると質問文を落とす |

```json
{ "notify": { "slackWebhookUrl": "https://hooks.slack.com/services/...", "settleSec": 6, "idleMin": 2, "remindMin": 0, "detail": "full",
              "states": { "needs-answer": true, "needs-plan-approval": true, "needs-approval": true, "awaiting-reply": true } } }
```

`states` は画面と `config.json` にしか無い。**環境変数を用意しない。**
組み合わせを1本の文字列で表す環境変数は、書き間違えても気づけないため。

`config.json` を手で書き換えたときは再起動が要る。ファイルの監視はしていない。
画面から保存したぶんは `applyConfig()` を通るので、再起動せずに効く。

`CLAUDE_DECK_NOTIFY_IDLE` を 0 にすると、実質すべての通知が止まる。
上に書いたとおり、実際に鳴っているのは返信待ちの経路だけだから。
うるさいと感じたときは 0 にする前に、まず分を伸ばすほうを試す。

Webhook の作り方は `docs/slack-webhook-setup.html` にある。

設定ミスに気づけるよう、有効なら起動時に1行出す。URL はマスク済みしか出さない。
自動起動されたサーバーにはターミナルで `set` した環境変数が届かないので、
`/api/health` の `notify` が裏で動いているサーバーの設定を確かめる唯一の手段になる。

画面側は `sources`（どこから来た値か）と `envSet`（立っているが負けている環境変数）を受け取り、
両方が立っているときは「環境変数もあるが画面の値が勝っている」と書く。
黙って勝つと、前に踏んだ「設定したのに鳴らない」と同じ迷い方をすることになる。

## 更新（新しい版へ入れ替える）

`launcher/` と `src/update/`。直すたびにフォルダを配り直す形をやめるための機能。
使う人が増えるほど古い版が残り続けるので、そこを埋める。

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

### 判断は C# 側に置く。Node には持たせない

理由が2つある。どちらも「失敗が黙る」経路を塞ぐためのもの。

- `server.mjs` の `uncaughtException` は**記録して続行**する作り。
  ここに更新処理を置くと、失敗が「画面は元気なのに何も変わらない」に化ける
- **node 自身が更新の対象**（`current\runtime\node.exe` ごと差し替わる）。
  自分を置き換える手続きを、自分の中に持たせない

加えて `releases.win.json` の形・チャネルの解き方・delta の連鎖・staging の置き場所は
Velopack の内部の取り決めで、Node に写すと必ず片方が古くなる。

向きは **C#（書く）→ `*.json` → Node（読む）→ 画面** の一方通行。
`read` → `parse` → `view` と同じ向きで、逆流させない。

### 紙が2枚

どちらも `%LOCALAPPDATA%\ClaudeDeck\` に置く。書くのは `launcher/Paper.cs` だけ。

| 紙 | 書く人 | 読む人 |
|---|---|---|
| `update.json` | `launcher/Updates.cs` | `src/update/state.mjs` |
| `startup.json` | `launcher/Startup.cs` | `src/startup/state.mjs` |

書き方は**一時ファイル → rename**（`notify/settings.mjs` と同じ作法）。
読む側が書きかけの半端な JSON を掴まない。

**`JsonSerializer` / `Deserialize<T>` を使わない。** あれは反射で型を見る作りなので、
`PublishTrimmed` を掛けたこの実行ファイルでは必要な情報が黙って削られ、**実行時にだけ落ちる。**
書くのは `Utf8JsonWriter`、読むのは `JsonDocument`。どちらも反射を通らない。

状態の語彙は `update/state.mjs` の `UPDATE_LABELS` と
`startup/state.mjs` の `STARTUP_LABELS` / `LEGACY_LABELS` にある。
**ランチャが書く語と、Node 側で足す語を分けて並べてある。**

Node 側で足すのは3つ（`idle` / `stale` / `unknown`）。

- `idle` … 紙がまだ無い。**一度も確認していないだけで、異常ではない**
- `stale` … 紙はあるが、書かれたときの版といまの版が食い違う
- `unknown` … 読めない・形が違う

`stale` を `available` のときだけ見るのは、ほかの状態では害が無いため。
「最新です」の紙が1つ前の版のものでも、次の確認で上書きされるだけで誰も困らない。
対して「0.2.1 があります」の紙が古いと、**すでに 0.2.1 で動いているのに更新を勧め続ける。**

**知らない状態が来ても、状態そのものは通して言い方だけ落とす。**
勝手に `unknown` へ潰すと、ランチャが先に新しい語を書くようになったときに
「読めませんでした」と嘘をつくことになる。

### 押してから戻るまで

```
1. 画面     「更新」を押す → POST /api/update/apply
2. server    CLAUDE_DECK_LAUNCHER が無ければ 409「この起動の仕方では更新できません」
             あれば ClaudeDeck.exe --apply-update --wait-pid <自分の PID> を切り離して起こす
             spawn に失敗したら 500 をそのまま返す（ここで {ok:true} を返さない）
             成功したら 202
3. 画面      紙を見ながら進み方を出し、120秒で見切りを付ける
4. ランチャ  落とす → update.json に requested と prevPort を書く
             POST /api/quit で止める → health が沈黙するまで最大10秒
             まだ生きていれば --wait-pid に任せる（最後の保険）
             当てて、--restarted で起き直す
5. ランチャ  CLAUDE_DECK_PORT=prevPort を渡して node を立てる
             → URL が変わらないので、開いたままの窓がそのまま復帰する
             版を照合して update.json に done か failed を書く
```

**窓は閉じない。** 他アプリの窓を勝手に殺すのは行儀が悪い。
代わりにポートを固定して戻し、開いたままの窓が自力で戻れるようにする。

### 黙って成功したように見えないための4点

1. 実処理を **node の外**（C# の別プロセス）で走らせる。握り潰しの射程外に出す
2. **再起動後に版を照合する。** `requested` と実際の版が違えば `failed`。
   *これが「当てたと言ったのに何も起きていない」を捕まえる唯一の網*
3. 画面側に**120秒の見切り**。無音のまま終わらせない
4. `POST /api/update/apply` は spawn の成否をそのまま返す。**作業の前に `{ok:true}` を書かない**

### 止める手段

```
CLAUDE_DECK_UPDATE_OFF=1     確認そのものをしない。紙は state:'off'
```

`CLAUDE_DECK_NOTIFY_OFF` と同じ語彙・同じ判定（`0` `false` `no` は「立っていない」）。
**画面からは止められない。** 画面から自分を締め出せる口は作らない。

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

## サーバー

`server.mjs`。`node:http` だけで静的配信・JSON API・SSE をやる。

| エンドポイント | 用途 |
|---|---|
| `GET /api/sessions` | 一覧を1回返す |
| `GET /api/sessions/:id` | 詳細（ログ全文を読む） |
| `GET /api/sessions/:id/entry/:uuid` | ログの1行を原文で返す。鍵らしい値は伏せ、長さと深さで切る。ファイルパスは返さない |
| `GET /api/sessions/:id/subagents/:agentId` | サブエージェント1件の記録。応答は詳細と同じ形（`digest` ＋ `log`）。ファイルパスは返さない |
| `GET /api/archive` | 書庫（終了したものも含む一覧）。`page` `per` `sort` `q` `deep` `project` `days` |
| `GET /api/stream` | SSE。`sessions` / `tick` / `error` イベント |
| `GET /api/health` | 生存確認。二重起動の判定にも使う。版・通知の設定と数え・**自動起動の様子**もここに出る |
| `GET /api/settings/notify` | 通知の設定。URL はマスク済み。出どころ（`sources` / `envSet`）も返す |
| `GET /api/update` | 更新の状態。ランチャが書いた紙 ＋ `canApply`（いまの起動のされ方で当てられるか） |
| `POST /api/focus?pid=N` | ターミナルの窓を前面に出す |
| `POST /api/settings/notify` | 保存して即反映。応答は GET と同じ形 |
| `POST /api/settings/notify/test` | テスト送信を1通。3秒のクールダウン付き |
| `POST /api/update/apply` | ランチャを起こして更新を当てさせる。202 を返して以降は関与しない |
| `POST /api/quit` | 行儀よく止まる。ランチャが更新前に使う |

**自動起動には専用の窓口を作っていない。** `/api/health` の `startup` に丸ごと載せてある。
設定モーダルの1行もそこから組む。
短い形にすると、裏で動いているサーバーの登録状態を見る手段が消える。

`/api/update` は毎回そのつど紙を読み直す。
起動時に1回だけ持つ形にすると、ランチャが裏で書き換えても画面が古いまま固まる。

`canApply` は紙の中身ではなく「いまの起動のされ方」の話なので、
`parseUpdateState` には持たせず `server.mjs` 側で足している。
これが無いと、`npm start` した画面にも押せない更新ボタンが出る。

### 書き込み口の門番

**`GET` と `HEAD` 以外はすべて `shared/origin.mjs` の `isTrustedWrite()` を通す。**
`server.mjs` の分岐は1箇所（`handleWrite`）に寄せてあり、窓の前面化も設定の保存も同じ扱い。

`127.0.0.1` で listen していても、ブラウザで開いた**任意のページ**がここへ POST できる。
`<form method="post">` は CORS の事前確認なしに飛ぶ。
放っておくと、悪意のあるページが Webhook を自分のものに書き換えられる。
以後の質問文がまるごとそちらへ流れるので、実害のある穴として塞いである。

見るのは4つ。

- `content-type` が `application/json` で始まること（`<form>` はこれを名乗れない）
- `origin` があるなら `127.0.0.1:<port>` か `localhost:<port>` であること（`'null'` は自分ではないので断る）
- `host` が同じであること（DNS 再バインド対策）
- `sec-fetch-site` があるなら `same-origin` か `none` であること

照合に使うポートは `boundPort`。`server.listen` のコールバックで代入する。
定数の `PORT` を使ってはいけない。埋まっていたらずらす作りなので、実際に listen した番号と食い違う。

本文は 8KB（`BODY_MAX`）を超えたら受け取らない。
**そこで `req.destroy()` を呼ばない。** 断りの 400 を書く前に接続が切れて、
呼び出し側には「応答が空」としか見えなくなる。溜めるのをやめて捨てるだけにする。

### 落ちない口の作り方

`async` の窓口には**必ず失敗の受け皿を付ける。** 付け忘れると unhandled rejection になり、
Node 18 以降はプロセスごと終わる。画面が死ぬだけでなく通知も黙って止まるので、
「返事待ちに気づけない」を埋めるための道具が、気づけないまま止まることになる。

実際に1件そうなっていた。`serveStatic` の `decodeURIComponent(pathname)` は
`/%ZZ` のような壊れた `%` で `URIError` を投げる。呼び出し側が `.catch()` を付けていなかったため、
**この1行でサーバーが即死した**（実測。`/api/health` も応答しなくなる）。

これは GET なので**書き込みの門番を通らない。** 他所のページに
`<img src="http://127.0.0.1:4317/%ZZ">` が1行あるだけで撃てる。
`<img>` は CORS の事前確認なしに飛ぶので、読めなくても届けば成立する。
いまは復号を `try` で囲んで 400 を返し、呼び出し側にも `.catch()` を付けてある。

受け皿は最上位にも1枚置いてある（`uncaughtException` / `unhandledRejection` で記録して続行）。
一般には「状態が壊れたまま走らせるな」で終了が正しいが、ここは読み取り専用のローカル画面で、
壊れて困る書き込み中の状態を持たない。唯一の例外である設定の保存は一時ファイル ＋ `rename`。

更新の押し出しは差分判定つき。`idleMs` と `lastActivityAt` は毎回変わるので比較対象から外す。
入れてしまうと内容が同じでも毎秒 push することになる。

通知の差し込みは4箇所だけ。`createNotifier()`・`refresh()` の1行・`FLUSH_MS` のタイマ・`/api/health`。
`refresh()` の中の `notifier.observe()` は `try/catch` で囲む。これは任意ではなく必須で、
外すと通知側のバグが `refresh()` の catch まで抜けて `broadcast('error')` になり、画面が空白になる。

監視は `fs.watch` と2秒ポーリングの二重。watch が効かない環境でもポーリングで動く。

同じポートで既に動いていたら、`/api/health` を叩いて相手が ClaudeDeck か確かめる。
そうならブラウザを開くだけにして終わる（自動起動と手動起動がぶつかる場面のため）。

## 画面側

バニラ JS。フレームワークもビルドも無い。`index.html` が読む `<script>` は1本だけ。

```html
<script type="module" src="js/main.js"></script>
```

ESM なので**読み込み順を人が守る必要はない。** import が解決の順を決める。
素の `<script>` を2本並べていた頃は、順番を入れ替えると立ち上がらず、
トップレベルに同じ名前を2つ置くと SyntaxError で丸ごと落ちていた。その危険は無くなっている。

拡張子は `.js` のままにする。`.mjs` を `public/` に置くと `server.mjs` の `MIME` に無く、
`octet-stream` で返るのでブラウザが module として読まない。

`public/js/` は 18枚 ＋ `timeline/` 7枚。**import は上から下へ一方向にだけ流す。**
逆向きに import したくなったら、置き場所が間違っている。

| 層 | ファイル | 役割 |
|---|---|---|
| 0 | `util.js` | 小道具（`el`・時刻・数値・`fact`） |
| 0 | `perf.js` | 描画にかかった時間。`window.deckPerf()` |
| 0 | `timeline/kinds.js` | 時系列の語彙。種類のラベルと、隠す種類の既定 |
| 1 | `store.js` | 画面側の状態・DOM 参照・URL クエリの同期 |
| 1 | `panel.js` | 詳細ペインの共通部品（器・見出し・折りたたみ） |
| 1 | `detail-head.js` | 詳細ペインの頭。パネルより前に出るもの |
| 2 | `rows.js` | 一覧の行の導出 |
| 2 | `drawer.js` | 狭い画面の一覧（引き出し） |
| 2 | `timeline/` | 時系列。外からは `index.js` の1枚として見る |
| 3 | `detail-wait.js` | 「あなたの番」のパネル |
| 3 | `detail-panels.js` | 詳細ペインに積むパネル |
| 3 | `agents.js` | サブエージェントの記録のパネル |
| 4 | `detail.js` | 詳細ペインの組み立て |
| 5 | `session.js` | 詳細の取得・保持・選択 |
| 6 | `list.js` | 稼働中の一覧と、上のバーのまとめ |
| 7 | `archive.js` | 書庫と、左のペインのタブ |
| 7 | `stream.js` | SSE でつなぎ、届いた一覧を画面へ流す |
| 7 | `settings.js` | 通知の設定モーダル |
| 7 | `update.js` | 更新のお知らせの帯と、押したあとの見張り |
| 8 | `main.js` | 入口。配線・テーマ・キー操作・起動 |

`timeline/` の中も同じで、`kinds` `waits` → `search` → `blocks` → `item` → `view` → `index` の順。
**`timeline/` の中のファイルを、外から直に import しない。** 呼びたくなったら `index.js` の口に足すか、
そもそも時系列の仕事かを考え直す。例外は `kinds.js` だけで、`store.js` が直に見る。

**循環を切っている所が4つある。動かすと立ち上がらない。**

| 切り方 | 切っている循環 |
|---|---|
| `hideQueryValue` は隠す種類を引数で受け取る | `store` → `kinds` → `store` |
| `store.js` は `timeline/kinds.js` を直に見る（`index.js` を経由しない） | `index` → `view` → `store` |
| `detailErrorNow` は `rows.js` に置く | `detail` ⇄ `session` |
| `setListOpen` は `drawer.js` に置く | `list` → `main` → `list` |

ふるまいで気をつけている所。

- SSE でつなぎ、`apply()` が一覧・まとめを描き直す。詳細は `renderDetailIfNeeded()` を通し、`detailKeyOf()` の値が動いたときだけ作り直す（毎回作り直すと開いた `<details>` と入力中の caret が消える）
- 時系列だけは `Timeline.render()` が `.tl-host` を差し替える。絞り込みの帯は器の外に置く（中に入れると1文字ごとに入力欄が作り直される）
- 描く先は `Timeline.attach()` で預け、`Timeline.detach()` で外す。外から時系列の内部状態を触らない
- 詳細は `detailCache`（`logSize` を印にした8件のキャッシュ）。中身が変わっていなければ取り直さない。印が `0`（不明）なら必ず取り直す
- 取り直しのあいだは `silent` で前の内容を出したままにする
- 狭い画面（860px 以下）では一覧が引き出しになる。閉じているあいだは `inert` で丸ごと触れなくする
- URL クエリで開き方を指定できる … `?session=<id>` `?theme=dark|light` `?only=1` `?nolive=1` `?tab=archive` `?aq=` `?asort=` `?tq=` `?hide=`
- `?hide=` は「キーが無い」と「空で付いている」を分けて見る。空は「何も隠さない」の指定なので既定に戻さない
- 隠している種類だけは `localStorage` に覚えさせない。開き直したら既定（足跡を隠す）に戻す。覚えさせると、足跡をいちど押して中を見ただけで既定が永久に壊れる
- 種類を隠すときは、その種類だけを数えた省略の目印（`elided`）も一緒に落とす。残すと「20 件を省略しました　足跡 20」の文字だけが並び、隠れていないように見える（実測で窓 120 件のうち 36 件がこれだった）
- **省略は絞り込みのチップに出さない。** 上の通り、出るか出ないかは他のチップ側で決まるので、独立したチップにすると件数が嘘になる。実測では「省略 74」と出しながら1行も出ない状態になっていた（74 件すべてが足跡だけの区間で、足跡は既定で隠れる）。その状態で他を全部隠すと時系列が空になる。目印ごと消す指定は URL に残してある（`?hide=elided`）
- 窓（`TL_FIRST` = 4 で開き、`TL_MORE` = 60 ずつ継ぎ足す）の外にしか無い種類は名前で伝える。足跡は新しい 200 件だけが残るので、古い順で見ていると窓の中に1件も入らないことがある。黙っていると「押しても変わらない」に見える
- 描画にかかった時間は `window.deckPerf()` で見る（目安は `renderDetail` が 50ms 未満、時系列の描き直しが 16ms 未満）。測る入れ物は `perf.js` の1つに保つ（2つに割ると `deckPerf()` が片方しか見えない）
- 設定モーダルは `<dialog>` ＋ `showModal()`。Esc・背面の膜・焦点の閉じ込めがタダで付く。中身は**開いたときに1回だけ**引く。ここを毎秒更新しない
- モーダルを `<form>` で囲まない。囲うと入力欄で Enter を押した瞬間に閉じる（保存したつもりで消える）。Enter → 保存は `settings.js` が自分で拾う
- URL の入力欄は常に空で開き、いまの値はマスクして `placeholder` に出す。`****` のような偽の値を `value` に置くと、それをそのまま保存して URL を壊す。空欄＝「変えない」、消すのは「消す」ボタンだけの役目
- 数値の欄も空ならキーごと送らない。サーバー側が「キーが無い＝触らない」なので、そこに乗る
- `.settings` に `padding` を持たせない。持たせるとその余白を押したのが背面を押したのと区別できず、`ev.target === dialog` での判定が崩れる
- 更新の帯は、押したあとの見張りを画面側が持つ。当てる作業はサーバの外（C# の別プロセス）で走り、しかも途中でサーバ自身が落ちて起き直る。「押したのに何も起きない」を捕まえられるのは画面側しかないので、無音で終わらせず `STUCK_MS`（120秒。`server.mjs` の `APPLY_GUARD_MS` と同じ）で必ず時間切れを出す
- 開いた直後にもう1回だけ引き直す（`RECHECK_MS` = 10秒）。ランチャは窓を開けてから更新を確認するので、最初に引いた時点の紙はまだ前回の結果か、そもそも無い
- `/api/update` が 404 のとき（サーバーが古い）だけは、画面側で `outdated` を組む。それ以外の判断はサーバー側に置く

状態ラベルの日本語は画面側に持たない。
`/api/sessions` の `meta.stateLabels`（`STATE_LABELS` そのまま）から引く。
状態を1つ増やすときに直すのは `parse/state.mjs` だけで済む。

CSS は `public/css/` に9枚ある。`index.html` の `<link>` の並びが、そのまま重ね順になる。

| ファイル | 中身 |
|---|---|
| `tokens.css` | 色の実体（`--l-*` / `--d-*`）・意味トークン・暗いほうへの差し替え |
| `base.css` | リセット・全体の骨・上のバー・共通のボタン |
| `list.css` | 一覧と書庫のカード |
| `detail.css` | 詳細ペイン・パネルの器・待ち・判断・facts |
| `timeline.css` | 時系列 |
| `panels.css` | TODO・サブエージェントの記録・ファイル |
| `settings.css` | 通知の設定モーダル |
| `update.css` | 更新のお知らせの帯 |
| `narrow.css` | 狭い窓向け（`@media (max-width: 860px)`） |

**`<link>` の順番を入れ替えない。** CSS は宣言順で勝ち負けが付く。
`narrow.css` は上の8枚を上書きするので、必ず最後に読む。

`settings.css` は狭い窓向けの指定を自分で持つ（`min()` と `max-width: 34rem` のグリッド畳み）。
モーダルの都合を `narrow.css` に散らさないため。`<dialog>` の既定は `canvas` / `canvastext` という
別系統の色を使うので、意味トークンで塗り替えないと配色を暗くしてもモーダルだけ白く残る。

ライト／ダーク両対応。
色の値は `--l-*`（明）と `--d-*`（暗）に1回だけ書き、`--bg` などの意味トークンがそこを指す。
画面側は意味トークンだけを使う。

`@media (prefers-color-scheme: dark)` の側には `:not([data-theme="light"])` を付ける。
閲覧側の切り替えが両方向で勝つことを、順序や詳細度に頼らず示すため。
これがあるので `[data-theme="light"]` のブロックは要らない。

## 触るときに壊してはいけないこと

このプロジェクトは制約のほうが設計を決めている。以下は理由つきで守る。

- **`~/.claude` 配下へ書き込まない。** 読み取り専用が前提。書き込み先は `%LOCALAPPDATA%\ClaudeDeck\`。場所の決め方は `src/shared/appdata.mjs` の1箇所に寄せてある（2箇所に書くと必ず片方が古くなり、設定したのに読まれない事故になる）
- **listen は `127.0.0.1` 固定。** 会話ログに業務内容が入るため、社内ネットから見えてはいけない
- **`GET` と `HEAD` 以外はすべて `isTrustedWrite()` を通す。** `127.0.0.1` は守りではない。ブラウザで開いた任意のページが `<form method="post">` で届く。通す口を増やすときは `handleWrite` の中に足す（門番の外側に窓口を作らない）
- **依存パッケージを増やさない。** 同僚にフォルダごと渡して動くことが要件。`dependencies` は空のまま
- **未知の形で落ちない。** 読んでいるのは Claude Code の内部データで公開仕様ではない。未知のキー・未知の `status`・書き込み途中の壊れた JSON が来ても、黙って飛ばして進む
- **`async` の窓口を `.catch()` 無しで呼ばない。** 拾われなかった拒否は Node 18 以降でプロセスを殺す。実測で `GET /%ZZ` の1発が `serveStatic` の `decodeURIComponent` からサーバーを落としていた。GET は門番を通らないので、他所のページの `<img src>` だけで撃てる（詳しくは「落ちない口の作り方」）
- **`ClaudeDeck/` を `.gitignore` から外さない。** リポジトリは public。`appdata.mjs` は `LOCALAPPDATA` も `XDG_STATE_HOME` も `HOME` も無いときアプリ直下へ倒れるので、そこに落ちる `config.json`（**生の Webhook URL 入り**）が `git add -A` で公開リポジトリに乗る
- **`innerHTML` を使わない。** ログ本文をそのまま画面に出すので、必ず `textContent` で入れる
- **`timeline/` の中のファイルを外から直に import しない。** 口は `timeline/index.js` の1枚に絞る。例外は `kinds.js`（層0の語彙）だけで、`index.js` を経由させると `index` → `view` → `store` → `index` の循環になる
- **`public/` に `.mjs` を置かない。** `server.mjs` の `MIME` に無いので `octet-stream` で返り、ブラウザが module として読まない。画面側の拡張子は `.js`
- **生死の判定は PID の存在確認だけ。** 登録簿の `updatedAt` は状態が変わったときしか書かれない。古さで終了扱いにすると稼働中のセッションが一覧から消える
- **`slugifyCwd` の結果からパスを復元しない。** 英数字以外がすべて `-` になる不可逆変換。cwd は登録簿とログの各行から直接取る
- **`.ps1` は UTF-8 BOM 付きで保存する。** 旧 `powershell.exe` (5.1) は BOM が無いと OS の既定コードページで読み、日本語コメントが化けて構文解析まで壊れる。`pwsh` (7) は通るので気づきにくい
- **改行は `.gitattributes` が決める。** 既定は LF、`.cmd` と `.ps1` だけ CRLF。手元の `core.autocrlf` に関わらずこちらが勝つので、設定を揃えてもらう必要は無い。BOM は git が触らないので、改行を変換しても残る
- **`ClaudeDeck.cmd` は ASCII のみ。** `cmd.exe` は解析時のコンソールコードページで読むため、日本語を置くと shift-jis 環境で壊れる。日本語のメッセージは node 側から出す
- **状態色は点と細いバーだけに使い、面は塗らない。** 全面を塗ると全部が同じ重さに見えて、どれから手をつけるか分からなくなる。色は必ず CSS 変数経由で取る
- **0 と「不明」を分ける。** 取れなかったものを 0 と書かない。キャッシュの目印にも同じで、`logSize` が `0` なら「不明」として必ず取り直す
- **`digest.mjs` の `agents.push(rec)` をコピーに変えない。** `items` と同じオブジェクト参照を共有していて、間引きで `items` から消えても `agents` には残る。サブエージェントの一覧がこの参照に依存している
- **`indexTranscripts` を再帰にしない。** 今は2階層固定なので `<セッションID>/subagents/agent-*.jsonl` を弾けている。再帰にすると 148 ファイルが「セッション」として一覧に流れ込む
- **`listSubagents` に memo を掛けない。** 印に使えるのはディレクトリの mtime だが、NTFS はファイルが増えたときは変わるのに、既存ファイルが太ったときは変わらない。走っているサブエージェントの大きさが固まって表示が伸びなくなる
- **サブエージェントの `agentId` をパスに連結しない。** 開くファイルは常に `readdir` が返した名前にする。だからパストラバーサルの検証が要らない。`server.mjs` の正規表現は入口の粗いふるいであって、安全の根拠ではない
- **プランのファイルは `plansDir` の中を指すことを確かめてから開く。** `filePath` はログ由来の外部入力。比較は `path.relative` で行う（`startsWith` はドライブレターの大小で正しいパスを弾く）
- **プランの mtime だけで「提出後に変わった」と断定しない。** 実測45件で、ファイルのほうが古い例が28件あった。本文の一致を主判定にする。`planWasEdited` はキーが無いことを「編集なし」と読み替えない
- **一覧の経路（毎秒走る）に重い処理を足さない。** ここに何かを足すときは、まず「払わずに済む行」を先に落とす。サブエージェントの件数がその形で、`indexTranscripts` が `withFileTypes` でタダで拾った `hasSessionDir` を見て、`<セッションID>/` が無い行は `readdir` を1回も出さずに 0 と決める。実測 168 件中 48 件しか持っていない。全件を数えると `indexTranscripts` が 39.0ms → 78.2ms になり、一覧全体（48.8ms）を超える
- **件数を数えるのに `listSubagents` を呼ばない。** 一覧は `countSubagents`（`readdir` 1回だけ）。`listSubagents` は 1件ごとに `stat` と `.meta.json` を読むので、詳細を開いたときだけ
- **通知の本文に `cwd`・`logFile`・`gitBranch`・`title`・`lastPrompt` を載せない。** 載せてよいのは `project`（フォルダ名だけ）まで。`watch.mjs` の `snapshot()` が写し取る時点で落としてあるので、`message.mjs` からは載せようがない。安全装置がそこにあることを知らずに `snapshot()` へ項目を足さない
- **Webhook の URL を戻り値のどこにも入れない。** 表に出るのは `maskWebhook()` を通したものだけ。`fetch` の失敗メッセージには URL が埋め込まれ得るので、`postToSlack` は理由を返す前に自分で `scrubError()` を通す（呼ぶ側に伏せ忘れの余地を残さない）。弾いた URL も返さない。別サービスの鍵を貼り間違えている可能性がある
- **`/api/settings/notify` の応答に生の URL を入れない。** GET も POST も同じ。ここが漏れると、モーダルを開いただけで鍵がブラウザの履歴とメモリに乗る。だから画面側は「変えない（空欄）」と「消す（空文字）」の2つだけで足り、生の値を持たずに済んでいる
- **送り先は `hooks.slack.com` に固定する。** タイポで別のホストへ業務内容を POST する事故を、機能として防ぐ。この検証を緩めない
- **`notify/watch.mjs` に I/O を入れない。** 時刻も外から `now` で渡す。ここが純粋だから「送るかどうか」の全分岐をテストで通せる。`observe()` は同期に保つ（`await` を挟むと `refresh()` が `refreshing` を立てている区間が延びる）
- **返信待ちの鍵をセッション ID だけで作らない。** `anchorId`（ログの最後の行の uuid）を混ぜる。混ぜないと鍵が生涯1つになり、1通鳴ったきり2回目以降が黙って落ちる。この壊れ方はテストを書いていないと気づけない（鳴らないだけで、どこにもエラーが出ない）
- **`needs-approval` を `byStatus` の裏づけ無しで通知しない。** しきい値だけが根拠の側は、長く走る Bash と区別がつかない（実測で50秒の Bash が同じ形になった）。auto mode で Claude が自分で承認した分を誤報として送ることになる
- **設定を変えても `watch.mjs` を作り直さない。** 値だけ差し替える（`configure()`）。作り直すと送信済みの記憶（`known`）が消えて、いま待っているぶんが保存した瞬間に全部もう一度鳴る。無効から有効へ変わったときだけ `rearm()` で種まきし直す（これが無いと、何時間も待っていたセッションが一斉に飛ぶ）
- **通知済みの記録をファイルに残さない。** メモリだけで足りる。種まきで重複は消えるので、書き込み失敗・壊れた JSON・古い記録の掃除という失敗経路を3つ増やす価値がない
- **packId を `ClaudeDeck` にしない。** Velopack の既定の入れ先は `%LocalAppData%\{packId}` なので、書き込み先の `%LOCALAPPDATA%\ClaudeDeck\` とまるかぶりになり、アンインストールで `config.json`（**生の Webhook URL 入り**）が黙って消える。`--packId ClaudeDeckApp` ＋ `--packTitle ClaudeDeck` で分ける
- **更新の判断を Node に持たせない。** `server.mjs` の `uncaughtException` は記録して続行するので、ここに更新の実処理を置くと失敗が「画面は元気なのに何も変わらない」に化ける。node 自身が更新の対象（`current\runtime\node.exe` ごと差し替わる）でもある。判断は C# のランチャ側、Node は紙を読むだけ
- **`POST /api/update/apply` は spawn の成否をそのまま返す。** 作業の前に `{ok:true}` を書かない。spawn するパスは `CLAUDE_DECK_LAUNCHER` から取り、**リクエスト本文からは絶対に取らない**（`POST /api/focus` が PowerShell を spawn している前例と同じ守り方）
- **再起動したあとに版を照合する。** `requested` と実際の版が違えば `failed` にする。「当てましたと言ったのに何も起きていない」を捕まえる網はここだけ
- **Edge の窓を閉じない。** 他アプリの窓を勝手に殺すのは行儀が悪い。`CLAUDE_DECK_PORT` に前のポートを渡して立て直し、開いたままの窓が自力で戻れるようにする
- **紙が無いことを「動いていない」と読み替えない。** `update.json` も `startup.json` も、ランチャを通していないときは誰も書かない。無いのは `idle`（正常）、壊れているのが `unknown`（異常）。読み替えると `npm start` で起こすたびに「登録されていません」と出て、実際は登録されているのに解除を勧めることになる
- **知らない状態を `unknown` へ潰さない。** 状態そのものは通したまま、言い方だけ落とす。潰すと、ランチャが先に新しい語を書くようになったとき「読めませんでした」と嘘になる
- **画面に更新の確認を止める口を作らない。** 止めるのは `CLAUDE_DECK_UPDATE_OFF=1` だけ。画面から自分を締め出せる口を作らない
- **画面に自動起動の登録・解除の口を作らない。** スタブ（`<install>\ClaudeDeck.exe`）は子の終了コードを伝えない（実測）ので、押した結果を返せず、いつも「できました」と言うことになる。入切は `--install-startup` / `--uninstall-startup` の役目
- **旧方式の `.lnk` を消さない。** `ClaudeDeck.lnk.disabled` へ改名するだけにする。利用者がいつでも戻せる形を残す
- **C# 側で `JsonSerializer` / `Deserialize<T>` を使わない。** 反射を通るので `PublishTrimmed` で黙って削られ、**実行時にだけ**落ちる。書くのは `Utf8JsonWriter`（`Paper.cs`）、読むのは `JsonDocument`（`JsonRead.cs`）
- **Velopack のフックは `On*`。** `VelopackApp.Build().OnFirstRun(...).OnBeforeUninstallFastCallback(...).Run()`。`With*` ではない
- **`VelopackApp.Run()` より前に自前の引数解析を置かない。** `--veloapp-*` を未知の引数として扱ってしまう。`Main` の最初、ちょうど1回
- **`--no-open` を外さない。** 窓を開けるのはランチャだけと決めてある。外すと `openBrowser` が既定ブラウザを開き、Edge のアプリ窓と二重になる
- **`port.json` を真実として扱わない。** 必ず `/api/health` で裏を取る。異常終了で古いファイルが残るのは正常な状態
- **配布物は許可リストで組む。** 除外リストは黙って古くなる（`assets/` を除いていても、次に足した大きなフォルダは素通りする）。許可リストなら足し忘れたときにアプリが起動せず、その場で分かる
- **版の出どころを増やさない。** `package.json` の `version` の1箇所から `appinfo.mjs` と `release.ps1` が派生する。3つが同期するのではなく、2つが1つから派生する形にする。C# 側に版を書き写さない・`vpk` に手で打たない

## 要約を AI に差し替えるとき

`src/view/summary.mjs` の `summarize()` が唯一の差し替え点。`detail.mjs` は結果の形しか見ていない。

差し替えるときは以下を守る（理由はファイル冒頭のコメントに詳しく書いてある）。

- 既定では通信しない。鍵が無ければ黙って素の要約に戻す
- ログ本文を外へ送る処理になるため、使うかどうかは利用者が環境変数などで明示的に選ぶ形にする
- 失敗しても詳細ビュー全体を落とさない
- 素の要約（`plainSummary`）を捨てない。AI 側が落ちたときの表示になる

## コードの書き方

- ESM（`"type": "module"`）。拡張子は `.mjs`
- インデントはスペース2つ、シングルクォート、セミコロンあり
- **コメントと UI 文言は日本語。** 「なぜそうしたか」を書く。実測で分かった Claude Code のデータ形式は、その場のコメントに残す（公開仕様が無いため、それが唯一の記録になる）
- 関数には JSDoc を付ける。引数の意味が自明でないものは `@param` を書く

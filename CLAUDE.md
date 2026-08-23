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
| `usage.test.mjs` | 数値の集計。重複の潰し方と、0 と不明の分け方（数値の本丸） |
| `usage-view.test.mjs` | 横断集計のクエリ・走査上限・直近の中央値 |
| `stream.test.mjs` | stream-json の行の読み書き。未知の型と壊れた行で落ちないこと |
| `run-spec.test.mjs` | 起動指定の関所。cwd の許可・語彙・argv の完全一致・切り替えの併合（**実行に関わる本丸**） |
| `run-event.test.mjs` | 速報1行の畳み方。切り詰めと、生の行を外へ出さないこと |
| `run-ledger.test.mjs` | 台帳の状態機械。全分岐と、`rows()` に毎秒動く値が載らないこと。一覧への合流 |
| `run-index.test.mjs` | 実行の配線。断る番号・停止の3段・二重確定の防ぎ方・切り替えは畳む前に断ること |
| `claude-cli.test.mjs` | CLI の探し方・版の読み方・stdout の行の割り方・最後の後始末（同期版） |
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
| `src/parse/` | ログを解釈する | `entries` `meta` `state` `digest` ＋ `digest/`（`limits` `answers` `waits` `trim`） `usage`（数値） `stream`（実行中の行） |
| `src/view/` | API 応答を組む | `sessions`（一覧） `detail` `summary` `shape` `archive`（書庫） `entry`（原文） `plans`（プランの系譜） `subagent`（調査記録） `usage`（数値） |
| `src/notify/` | 回答待ちを外へ知らせる | `index`（配線） `watch`（状態機械） `message`（本文） `config`（読む） `settings`（書く） `slack`（送信） |
| `src/run/` | 画面から起こすセッション | `index`（配線） `ledger`（台帳と状態機械） `spec`（起動指定の検証と argv） `event`（速報1件の畳み方） |
| `src/update/` | ランチャが書いた更新の紙を読む | `state` |
| `src/startup/` | ランチャが書いた自動起動の紙を読む | `state` |
| `src/shared/` | どの層からも使う小道具 | `text`（`oneLine` / `clip`） `tools`（`describeTool`） `appdata`（書き込み先） `origin`（書き込み口の門番） `appinfo`（版） `portfile`（`port.json`） `env`（止めるスイッチの読み方） |
| `src/os/` | OS を叩く | `focus` `claude`（CLI を探す・版を読む・行を割る） |

流れは `read` → `parse` → `view` → `notify`。
`shared` はどこからでも使えるが、逆に `shared` から他を import してはいけない。

`notify/` は末端に足した層で、**`view/` を import しない。**
`listSessions()` が返した行（ただの JSON）を受け取るだけにしてある。
これで向きが一方向のまま保たれ、テストも行のリテラルを渡すだけで書ける。

`run/` も同じ末端で、**`view/` を import しない。`view/` から `run/` を import もしない。**
起こしたセッションを一覧へ混ぜるのは `server.mjs` の `refresh()` の仕事で、
そこが合成の場所と決めてある。判断そのもの（何を混ぜるか）は `run/` の純関数に置く。

`os/claude.mjs` はプロジェクト内 import ゼロ。`node:child_process` などしか使わない。
判断（どの argv を組むか・許可するか）は `run/spec.mjs` 側にあり、
`os/` に残るのは「探して、起こして、止めて、行に割る」だけの薄い殻。
`parseUpdateState`（判断）と `loadUpdateState`（I/O）を分けたのと同じ形。

`run/` の中でも同じ分け方をしている。`spec` と `event` と `ledger` は I/O をまったく持たず、
時刻さえ外から `now` で受け取る。だから状態機械の全分岐をテストで通せる。
`index` だけが `os/claude.mjs` を呼び、どの順で手を動かすかを決める。

`update/` と `startup/` も末端で、どの層も import しない（`shared/appdata.mjs` だけ）。
やるのは「紙を1枚読んで、画面に出せる形に整える」だけ。
**判断はしない。** 更新を当てるかどうかも、自動起動を登録するかどうかも決めるのは C# 側で、
こちらは結果を読むだけにしてある。理由は「更新」の節に書いた。

入口は12。ここの名前と応答の形は変えない。

- `view/sessions.mjs:listSessions`
- `view/detail.mjs:getSessionDetail`
- `view/usage.mjs:getSessionUsage`（1本ぶんの数値）
- `view/usage.mjs:getSessionBaseline`（直近の中央値。**わざと分けてある**。理由は「数値」の節）
- `view/usage.mjs:listUsage`（横断）
- `notify/index.mjs:createNotifier`
- `update/state.mjs:loadUpdateState`
- `startup/state.mjs:loadStartupState`
- `run/index.mjs:createRunner`（`server.mjs` が触る唯一の口。12個の関数を返す）
- `run/spec.mjs:buildRunSpec`（起動指定を検証して argv まで組む）
- `os/focus.mjs:focusTerminal`
- `os/claude.mjs:probeClaude` / `claudeInfo`（探すのと、結果を読むのを分けてある）

`digest.mjs` に残しているのは走査の本体（`buildDigest`）と、走査の前に1回だけ作る索引だけ。
走査から呼ぶ判断は `digest/` の4枚に分けてある。`buildDigest` 本体は分けない
（1つのループで `items` と `files` と `stats` を同時に埋めているため）。

画面側は `public/` の下に2つ。

| 場所 | 役割 | 中身 |
|---|---|---|
| `public/css/` | 見た目 | 13枚。`<link>` の並びがそのまま重ね順になる |
| `public/js/` | 画面の組み立て | 27枚 ＋ `timeline/` 7枚 |

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

数値  readAll / readAllOnce（全文。数値を出すときだけ）
      → parse/usage.mjs:buildUsage（重複を潰してから足す）
      → view/usage.mjs が専用の memo に集計結果だけを載せる
```

**数値は一覧の経路に原理的に載らない。**
一覧は末尾 64KB しか読まないが、集計は先頭から積まないと出せない。
「重いから載せない」ではなく「載せられない」ので、うっかり毎秒経路へ混ざる事故が起きない。

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

## 数値（何にトークンを使ったか）

`src/parse/usage.mjs` と `src/view/usage.mjs`。
assistant の行には `message.usage` が例外なく入っているのに、
それまでは直近1件の文脈量に使うだけで、集計には一度も使えていなかった。

狙いは1つ。**翌日の行動が変わる形で見せる。** 数字を並べるだけなら見て終わる。
だから主役を1つ（ツール別の文脈消費）に絞り、残りは脇に置いてある。

### 合計の前に必ず通す前処理

ここを外すと以降が全部ずれる。

**`requestId` で重複を潰す。これが最重要。**
1回の API 応答が thinking / text / tool_use の複数行に分かれて書かれ、
**そのすべてが同じ `message.usage` を持つ**（実測。上位25ファイルで assistant 行 12,346 に対し
一意な `requestId` は 5,928）。素で足すと**約2倍**になる。
同じ `requestId` で usage が食い違う例は0件だったので「最初に出た1行を採る」で安全。

副作用として、`digest.mjs` の `stats.turns`（assistant 行数）は**往復数ではない**（約1.85倍）。
数値の側では使わない。

`<synthetic>` の行（`requestId` を持たず usage が全ゼロ。全ログで108件）は回数の分母に入れない。

`cache_creation` は入れ子を優先する。
実データに `cache_creation_input_tokens: 0` なのに
`cache_creation.ephemeral_1h_input_tokens: 132640` という行がある。
平坦なフィールドと、入れ子の 5m ＋ 1h の和を比べて、大きいほうを採る。

`usage.iterations` は見ない。実測で常に長さ1で、サーバー側フォールバック時の記録。

### 指標

**実消費（ITE）** … `in + 1.25·cw5m + 2.0·cw1h + 0.10·cr + 5.0·out`。
重みは推測ではない。**全モデルで例外なく同じ比率**だったので、モデル差は基本入力単価1つに畳める。
だから USD に直したければ最後に単価を掛けるだけで済む。

**USD は既定で出さない。** ログに `costUSD` が無く、こちらで単価表を持つことになる。
単価は変わるのに、画面の数字は「確定した事実」に見える。
ITE なら比率が確定しているので、単価が変わっても嘘にならない。

**文脈保有量** … `in + cr + cw` の、最後の要求ぶん。**絶対に合計しない。**
`input_tokens` は「キャッシュされなかった残り」だけなので、3つ足して初めて全長になる。
足し合わせた瞬間に意味を失うので、合計する経路を実装上も作らない。

**キャッシュ命中率** … `cr / (cr + in + cw)`。**同一モデル内でしか比べない。**
プロンプトキャッシュの最小長がモデル別で、しかも単調でない
（Opus 5 は 512、Opus 4.8 と Sonnet 5 は 1,024、**Opus 4.7 は 2,048**、Opus 4.6 と Haiku 4.5 は 4,096）。
**最小長未満だとエラーも出さずに黙ってキャッシュされない。**
古いモデルが低く見えるのは行動の差だけではないので、注記ではなく集計側の制約として強制する。

**ツール別の文脈消費（主役）** … `材料(r) = Δ(r) − out(r−1)`。
文脈の伸びから前回の出力ぶんを引いた残りが、その間に差し込まれたもの。
**トークナイザ無しで、引き算だけで厳密に出る。**
実測で Read は121回で 344k、Edit は146回で 15k。
「Read 1回で 68k 食った」は、次から範囲や `limit` を絞る動機になる。
明日の行動が変わる指標はこれだけなので、画面の主役に据えてある。

Δ が負になった回（実測で 433中8回）は 0 に丸めたうえで、
**「測れなかった回数」として別に数えて画面に出す。** 黙って捨てない。

### スキルの区間と、因果の但し書き

区間は **`Skill` の `tool_use` から、次のあなたの番の直前まで。**
障壁は4つのいずれかが先に来た時点で打ち切る（次の `Skill` / `compact_boundary` / `/clear` / 中断）。

**因果は取れない。** 区間内の消費がスキルのせいか作業内容のせいかは分けられない。
だから「スキルを呼び出した直後の一続きを測っています。スキルが原因とは限りません」を、
**折りたたまずに常時**出す。**これが無い状態で出荷しない。**

`meta.skills` にはスラッシュコマンドが混ざっていた（実測。Skill 呼び出し82件に対しコマンド85件、
**うち `/clear` が74件**）。`meta.commands` を分けたので、`skills` は `Skill` ツールだけになっている。

### 圧縮とサブエージェント

**`cumulativeDroppedTokens` は累積なので足さない。**
実測（大きい順に40ログ・圧縮475件）で、そのログの最後の値が
`Σ(preTokens - postTokens)` と1トークンの狂いもなく一致した。
素で合計すると、圧縮が64回あるログでは60倍近くに膨れる。
最後ではなく最大を採るのは、行が時刻順に並んでいなくても壊れないようにするため。

**サブエージェントの二重計上は起きない。** 親ログに `isSidechain` の assistant 行は1件も無い
（204ファイル全走査で0件）。子の消費は `<セッションID>/subagents/agent-*.jsonl` にあるので、
そちらを自分で集計して内訳として併記する。

**`toolUseResult.totalTokens` を消費量として使わない。**
3エージェントで厳密に照合したところ、**最終要求の `in+out+cr+cw`**（＝終了時点の文脈保有量）と完全一致した。
合計 2,027,396 のキャッシュ読みがあるエージェントが `113696` を返している。

### 直近の中央値は、窓口ごと分けてある

`GET /api/sessions/:id/usage/baseline`。**わざと `/usage` と別にした。**

混ぜていたときの初回は 1420〜1543ms で、うち **400〜700ms が中央値ぶん**だった。
本体が 1.0〜1.5秒なので、混ぜると体感が5割増しになる。
分けたあとの実測は usage 459ms / baseline 640ms。
画面は数値を先に出して、遅れて差を書き足す。

**見る本数（`BASELINE_SCAN`）は 10 では足りない。24 にしてある。**
直近10本のうち `claude-opus-5` は2本しかなく、`BASELINE_MIN = 3` に届かず
実データで中央値が常に null になっていた。24本まで広げると同じモデルが8本入る。
しかも重さは本数ではなく「大きいログ（39MB・42MB）に当たるかどうか」で決まるので、
10本 412ms → 24本 669ms と +257ms で済む。

**比べる相手が3本に満たなければ、差そのものを書かない。**
推測で `±0` と書かない。「差が無い」と「比べられない」は別物なので、
0 と不明を分ける原則をそのまま当てる。
増減で色も変えない。実消費が多いのは、単に長く働いた日かもしれない。

取り直しの間隔も分けてある。数値そのものは15秒、中央値は5分
（`BASELINE_MIN_INTERVAL_MS`）。直近24本の真ん中は数分では動かない。

**2回目が安くならないことに注意する。** memo は集計を省くだけで、
`readAllOnce` の読みと `JSON.parse` は毎回走る（実測で2回目も 584ms）。
だから画面側の5分という間隔が効いてくる。

### memo は専用のものを持つ

**`read/cache.mjs` を使わない。** 240件 LRU を全文で埋めると一覧の `tail:` memo が全部追い出され、
373MB を JS オブジェクトで保持するとメモリが数GBに膨れる。

`view/usage.mjs` の中に**集計結果だけを持つ専用 memo** を置いてある。
印は既存と同じ `` `${size}:${mtimeMs}` ``（追記型なので有効）。
中間の巨大な `entries[]` は集計後すぐ捨てる。

横断集計では `readAllOnce` を使う（共有 memo を汚さない）。
1本だけ引くときは `readAll` にして、詳細ビューと同じ memo に乗せる。
両方開いても1回しか読まないのはこのため。

横断の走査上限は `USAGE_SCAN_MAX = 60`。
`archive.mjs` の 120 より**小さい**。archive は行の頭だけを読むが、こちらは全文 parse で
1件あたりの重さが2桁違う。超過は 400 にせず、切り詰めて正直に報告する
（`scanned` / `scanLimited` / `scanMax`）。

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

## 実行（画面からセッションを起こす）

`src/run/` と `src/os/claude.mjs`、画面側は `public/js/runs.js` と `run-view.js` と `run-form.js`。
見るだけの道具から一歩出る機能。
起こす・続ける・止める・替える と、一覧への合流までひととおり通っている。
**この機能が増やす被害は質が違う。これまでは表示が変わるだけだったが、ここはコードが実行される。**

使うのは公開されている CLI の入口だけ（`claude -p --input-format stream-json`）。
対話版への打鍵注入や `~/.claude` への書き込みには乗らない。理由は `os/focus.mjs` 冒頭にある。

### 実測（claude 2.1.228・2026-08-12 と 08-16）

公開仕様が無いので、叩いて分かったことをここに残す。

**`--verbose` が要る。** `--print --output-format stream-json` だけだと、こう言われて exit 1 になる。

```
Error: When using --print, --output-format=stream-json requires --verbose
```

**stdout は1行も出ない。** 付け忘れると「起こしたのに無言で死ぬ」になるので、
`buildArgs` が必ず付ける（画面から外せる口も作らない）。

**headless も `sessions/<PID>.json` を書く。ただし `status` を持たない。**
2026-08-12 に「書かない」と観測したが、08-16 に `POST /api/runs` から起こしたぶんで
子の PID と同じ名前の紙が実際に置かれていた（同じ 2.1.228）。中身はこの形。

```json
{ "pid": 16440, "sessionId": "…", "cwd": "…", "startedAt": …, "procStart": "…",
  "version": "2.1.228", "peerProtocol": 1,
  "kind": "interactive", "entrypoint": "sdk-cli", "name": "claude-deck-24", "nameSource": "derived" }
```

見分けが付くのは `entrypoint` で、対話版は別の語を書く。
**`status` のキーが無い**ので `deriveState` の2番目・3番目の段が効かず、
末尾の行だけで決まる。実際、走っている最中の1本が `awaiting-reply`（返信待ち）に見えた。

つまり `ended`（終了）にはならないが、**実行中でも「返信待ち」と出る。**
一覧へ混ぜる工程が要る理由は変わらない。壊れ方が「終了に見える」から
「いつでも自分の番に見える」へ変わっただけで、どちらも実態と食い違う。

**会話ログのほうは普通に出る。** `projects/<スラッグ化した cwd>/<セッションID>.jsonl` に、
**こちらが渡した `--session-id` と完全に同じ名前で**書かれる（実測3本で 26.1KB / 26.5KB / 27.7KB）。
だから起こした瞬間から既存の詳細・書庫・`?session=` がそのまま使えるし、
サーバーが死んでも `--resume` で続けられる。台帳をディスクに残さないでいられるのはこのため。

**空の stdin で起こすと `system/init` すら出ない**（`system/hook_started` と
`system/hook_response` の2行だけで終わる）。だから指示文を必須にしてある。
このとき `projects/` にもログは出ない。上の「出る」はちゃんと指示文を送ったときの話。

**`--include-hook-events` を付けなくてもフックのイベントが流れてくる。**
`classifyStreamLine` が知らない型を `other` に落とすので、いまのままで受かる。

**`session_id` はどの行にも載る。** 自分が渡した `--session-id` と一致するか確かめられる。

`--permission-mode` の語彙は実物では6つ（`acceptEdits` `auto` `bypassPermissions`
`manual` `dontAsk` `plan`）あるが、**画面に出すのは3つだけ**にしてある。理由は `run/spec.mjs` に書いた。

**`-p` は1ターンで終わらない。** ここが最大のリスクだったが、実測では
`result` が来たあとも子は生きたまま stdin を待っている。次の1行を書けば同じ子・同じ
`sessionId` のまま2ターン目が進む。stdin を閉じると `close code=0` で畳まれる。

**`result` の数字は種類で意味が違う。** `num_turns` は**そのターンぶん**（2往復目も 1）、
`total_cost_usd` は**累積**（実測 0.803025 → 0.843727）。同じ行に並んでいるので混ぜやすい。

ただし `total_cost_usd` が累積するのは**同じ子のあいだだけ**。
`/switch` は子を起こし直すので、そこで起点に戻る（実測 0.401036 → 切り替え後の最初の `result` で 0.130617）。
だから画面のラベルは「この起動ぶんの費用」にしてある。「ここまで」と書くと、
切り替え後の小さい値を run 全体の合計として読ませてしまう。

**`--max-budget-usd` に当たっても死なない。** `result` は出る（`error_max_budget_usd` /
`terminal_reason: budget_exhausted` / `errors` 配列）が**プロセスは生き続ける**。
stdin を閉じると `close code=1`。だから予算切れは「終わった」ではなく「止まっている」として扱う。

**2分を超える無音は、故障ではなく圧縮（compact）のことがある。**
実測（2026-08-23）で `STALL_MS`（120秒）を超えたのは5回で、**5回とも圧縮の最中**だった
（出来事の間隔が `seq 33 → 34` で121秒）。行が届けば `running` に戻るので台帳としては壊れていない。

だから**しきい値は延ばさず、言い方を「無音」に留める**。
延ばしても同じ文を遅れて出すだけで、本当に固まったものが埋もれる時間が伸びる。
画面に出すのは測ったこと（`出力が2分止まっています。圧縮や長いコマンドの最中かもしれません`）だけで、
原因は決めつけない。

**`acceptEdits` は許可を求めない。断って先へ進む。**
Bash を伴う指示を投げると `system/permission_denied` が流れ、そのツールの結果が
`isError:true` ＋ `This command requires approval` になり、**止まらずに次の手へ移る**
（`result` の `denials` に数が載る）。「この画面から起こすセッションは、途中であなたに許可を求めません」
という UI の文言は、この実測どおりの意味になっている。
`system/permission_denied` は下の一覧の9種類目で、`classifyStreamLine` が `other` に落として受かっている。

いま出ることを確かめた `type`（`system` は `subtype` まで）。

```
system/hook_started  system/hook_progress  system/hook_response  system/permission_denied
system/init          user                  assistant             rate_limit_event   result
```

`system/hook_response` は `result` の**後**に来ることもある（2ターン目の冒頭で観測）。
順序に意味を持たせない。

**モデルを指定しないと `claude-opus-5[1m]` で立つ。** 角括弧付きなので
`run/spec.mjs` の `MODEL_RE` は通らないが、こちらが渡さないときの CLI 側の既定なので問題にならない。
（許可リストを持たない方針の裏返しで、**画面から角括弧付きは選べない**。テストにその事実を書いてある）

### 止め方は3段。実測で3段とも要る

`stdin.end()` → 3秒 → `taskkill /PID <pid> /T` → 2秒 → `taskkill /PID <pid> /T /F`。

| 相手 | どこで終わったか | 所要 | `exitCode` |
|---|---|---|---|
| `result` を返して待っている子 | 1段目（`stdin.end()`）だけ | 即座 | 0 |
| Bash を走らせている最中の子 | **3段目まで通った** | 5756ms | 1 |

**Bash 中は stdin を閉じても落ちない**ので、木ごと落とす必要がある。
`ping -n 60` を走らせて孫（`ping.exe`）ができた瞬間に止め、`tasklist` で数えたところ
**孫も子も残骸ゼロ**。`taskkill /T /F` はネイティブ版の孫にも効く。

### CLI を掴めたか

`os/claude.mjs` が起動時に1回だけ探して `--version` を読む。結果は `/api/health` の `claude`。

```
CLAUDE_DECK_CLAUDE_BIN → PATH を走査 → %USERPROFILE%\.local\bin\claude.exe
```

- **`CLAUDE_DECK_CLAUDE_BIN` が空振りしたら、黙って次へ落ちない。** 落とすと
  「指定したのに違うものが動いている」になり、いちばん気づきにくい
- **`.cmd` / `.bat` は使わない。** 実行に `shell:true` が要り、引数がシェルの構文として解釈される
- `where` を起こさない。`PATH` を自分で割って `existsSync` で見る
- 掴めなくても本体は落とさない。ダッシュボードとしては動くので止める理由が無い。
  起動直後は `state:'checking'`（`ok` は `null`。0 と不明を分けるのと同じ）

### 台帳（走っているものを覚えておく）

`run/` の4枚は、**判断（純関数）と I/O（薄い殻）の分け方**を層の中でもう一度やっている。
`parseUpdateState`（判断）と `loadUpdateState`（I/O）を分けたのと同じ形。

| ファイル | 何を決めるか | I/O |
|---|---|---|
| `spec.mjs` | 起こしてよいか。どの argv を組むか | 無し |
| `event.mjs` | 流れてきた1行を、画面に出せる出来事へどう畳むか | 無し |
| `ledger.mjs` | いつ状態が変わるか。何を覚えて何を捨てるか | 無し（時刻も `now` で受ける） |
| `index.mjs` | どの順で手を動かすか。断る理由と HTTP の番号 | `os/claude.mjs` 経由だけ |

**`server.mjs` が触るのは `createRunner()` が返す12個の口だけ。**
`start` / `input` / `stop` / `switch` / `tick` / `subscribe` / `shutdown` / `livePids` /
`rows` / `get` / `events` / `stats`。

**断る理由と HTTP の番号は `run/index.mjs` が決める。**
理由は4種類ある（503 CLI を掴めていない / 400 指定が不正 / 429 本数と間隔 / 500 起こせなかった）。
`server.mjs` 側で理由の文字列を見て振り分けると、言い回しを直しただけで番号が変わる。

台帳はメモリだけに持つ。ディスクへ書かない。
子はサーバーの子なので、サーバーが死んだ時点で台帳の意味も消える。
**会話ログは CLI が `~/.claude/projects/` に書いているので被害は残らない**（上の実測）。
復元を試みると失敗経路が3つ増えて、得るものが無い（「通知済みの記録を残さない」と同じ理屈）。

### `rows()` と `get()` を分けてある

`rows()` は一覧へ混ぜるための**粗い行**、`get()` は詳細ペイン用の**全部入り**。

**`rows()` に毎秒動く値を入れない。** `refresh()` の差分判定が除外しているのは
`idleMs` と `lastActivityAt` の2つだけなので、受信行数やトークン数を混ぜると
**内容が同じでも毎秒 push することになる**。
`counts` / `costUSD` / `lastLineAt` が `get()` にしか入らないのはこのため（テストで固定してある）。

### 一覧への合流

`ledger.mjs` の `mergeRuns()`。**`parse/state.mjs` の規則は1行も変えない。**
headless でも紙は書かれるが `status` のキーが無いので、`deriveState` は末尾の行だけで決める。
走っている最中でも「返信待ち」に見えるのはそのため（上の実測）。
台帳が知っている本当の状態を、あとから重ねて直す。

合流させる場所は `server.mjs` の `refresh()` だけ。
**`view/` の中でやらない。** `view/` と `run/` はお互いを import しない決まりなので、
合成の場所はサーバーと決めてある。並べ直しは `view/sessions.mjs` の `sortRows` を使う
（比較器を2箇所に書かない）。

- `sessionId` が一致する行があれば、その上に重ねる（`state` は台帳の値が勝つ）
- 一致する行が無ければ同じ形の行を合成して足す。**ただし生きているぶんだけ。**
  終わっていてログも無い run を足すと、書庫にも詳細にも出せない幽霊行が
  `HISTORY_MAX` 件ぶん一覧に残る
- 同じ `sessionId` の run が2本あるなら、後から起こしたほうを採る
  （`--resume` で起こし直すと、前の run が終端のまま履歴に残っている）

### 替えて続ける（`POST /api/runs/:id/switch`）

モデル・思考量・権限モードを替えて、**同じセッションの続き**を起こす。

**画面から2手（停止 → 起動）にしない。** あいだが空くと、前の子がまだ畳まれないうちに
次が起きて、同じ会話ログに2つのプロセスが書きうる。
サーバー側で `close` を待ってから起こせば、その競合は構造的に起きない。

**`--fork-session` は使わない。** ID が変わると一覧・詳細・`?session=`・ブックマークが全部切れる。
切り替えの跡は会話ログに書かない。跡が残るのは台帳と実行パネルだけ。

**断る判断はすべて子を畳む前に済ませる。** 通らないと分かっているのに殺すと、
断るだけで済んだはずのものが「止まっただけ」で終わる。順番はこう。

```
404 その run が無い → 409 もう終わっている → 409 起動指定が残っていない
→ 400 替える中身が無い・指定が不正（mergeSwitch）→ 400 指示が空・長すぎる
→ 503 claude を掴めていない → 400 argv を組めない（buildRunSpec）
→ ここで初めて畳む
```

畳んだ**後にもう一度**台帳を見て、`switching` から外れていたら起こし直さない（409）。
見るのは「まだ切り替え中か」の1点で、**`isRunOver` だけでは `stopping` を素通りする**。
素通りすると、止めろと言われた run の子だけが生き残る。

`perTurn`（`result` を返して閉じた `waiting`）なら畳む工程そのものが要らない。
`detach()` が `live` から entry を消すのは終端のときだけなので、`entry.spec` はそこに残っている。

### 終わっているセッションの続きを起こす

ターミナルで走らせていたセッションが終わったあと、同じ `sessionId` のまま続きを起こす。
口は詳細ペインの `public/js/run-resume.js`（層3）で、中身は `POST /api/runs` に
`resume: true` と `sessionId` を足すだけ。`buildRunSpec` は `--resume` を組む形を元から持っている。

ID が変わらないので、一覧・詳細・`?session=`・ブックマークがそのまま生きる。

**生きているセッションへ横から指示を入れる口は作らない。**
出すのは `row.alive === false` のときだけ。対話版へ打鍵を注入するのは
`os/focus.mjs` 冒頭で降りた道で、そちらは「ターミナルを前面に」で足りる。

**断るのはサーバー側**（`run/index.mjs` の `resumeBlocked`）。画面は cwd を事前に照らさない。
クライアントでパスを比べると、大小や末尾の `\` で正しいものまで弾く。
サーバーに判断させて、返ってきた日本語の理由をそのまま出す。

門番が見るのは2つ。

- `server.mjs` の `liveSessionIds()`（`lastPayload.rows` の `row.alive && row.sessionId`）
- 台帳（`ledger.rows()`）に同じ `sessionId` の非終端 run が無いか

**`liveSessions` が `Set` でなければ 409 で断る。**
一覧をまだ一度も読めていないときの `null` を「誰も動いていない」と読み替えない。
読み替えると、起動直後の数秒だけ二重起動を素通りさせることになる。

`restart()` と `switchRun()` は `start()` を通らないので、この関所には引っかからない。

実測（2026-08-17・claude 2.1.233）。終わっている claude-deck のセッションを resume で起こしたところ。

| 見たもの | 値 |
|---|---|
| `POST /api/runs` | 202。`runId: r1` / `state: running` / pid が載る |
| 1往復したあと | `waiting`（あなたの番）。`turns: 1` / 受信 15行 |
| 一覧への合流 | `state: awaiting-reply` ＋ `alive: true` ＋ `origin: 'deck'` |
| `POST /api/runs/:id/stop` | 200。**1段目の `stdin.end()` だけで畳まれた**（`exitCode: 0`） |
| この起動ぶんの費用 | 0.1311133 USD |

断り方も4通り確かめた。
409「そのセッションはまだ動いています」／400「このフォルダでは起動できません」／
400「指示が空です」／400「作業フォルダが指定されていません」。

**resume でも cwd は要る。** `resolveCwd` は resume かどうかを見ないので、
cwd の無い行には口を出さない（押しても必ず断られるため）。

**モデルは引き継がない。** `/api/runs/options` がモデルの候補を返さないので欄は自由入力にしてあり、
空欄なら CLI の既定で立つ。元のモデルを埋めると `claude-opus-5[1m]` のような角括弧付きが
`MODEL_RE` を通らず 400 になる（許可リストを持たない方針の裏返し）。

### 最後の後始末

止め方は3段（上の実測）で最長5秒かかる。`shutdown()` の hard exit は 500ms なので、
**`shutdown()` で `runner.shutdown()` を待たない**（待たせると Ctrl+C がすぐ効かなくなる）。
1段目の `stdin.end()` は同期で始まるので、行儀のよい相手はそれで畳まれる。

畳めなかったぶんは `process.on('exit')` が拾う。
**ここは同期しか走らない。** `runner.shutdown()` は `await` を含むので、
ここから呼んでも何もしないまま終わる。だから `livePids()` で PID だけ受け取り、
`os/claude.mjs` の `killTreeSync`（`taskkill /T /F` の同期版）に任せる。

段を踏まないのは、ここへ来る時点でサーバーの寿命が尽きているため。
`shutdown()` で畳めた子は `livePids()` に残らないので、ここに残るのは
Bash などを掴んだまま応じなかった子だけになる（実測でその子は3段目まで要った）。

`killTreeSync` が返すのは**「手を出したか」であって「落ちたか」ではない。**
同期で確かめる手段が無いので、確かめられないことを返り値の意味に混ぜない。

### 速報は専用の SSE で流す

`/api/runs/stream`。**`/api/stream` に相乗りさせない。**
あちらは全タブが常時つないでいる一覧の経路で、1秒 tick と差分判定が付いている。
1ターンで数百行出る実行の速報を混ぜると、一覧の更新が実行の量に引きずられる。
性質も寿命も違う（一覧は「いまの姿を丸ごと」、実行は「続き物で `seq` と再送が要る」）。

出来事には単調増加の `seq` を振る。切れたら
`GET /api/runs/events?from=<最後の seq>` で穴を埋める。
`?from=` は `/api/runs/stream` にも渡せて、つないだ直後にまとめて送り直す。
溢れたぶんは `missed` として数を返す（黙って捨てない）。

**購読はサーバーに1本だけ持つ。** 窓ごとに `runner.subscribe()` すると、
閉じ忘れが listeners に静かに溜まる。`server.mjs` が1回だけ購読して、
届いた出来事を開いている SSE 全部へ配る形にしてある。

## サーバー

`server.mjs`。`node:http` だけで静的配信・JSON API・SSE をやる。

| エンドポイント | 用途 |
|---|---|
| `GET /api/sessions` | 一覧を1回返す |
| `GET /api/sessions/:id` | 詳細（ログ全文を読む） |
| `GET /api/sessions/:id/entry/:uuid` | ログの1行を原文で返す。鍵らしい値は伏せ、長さと深さで切る。ファイルパスは返さない |
| `GET /api/sessions/:id/subagents/:agentId` | サブエージェント1件の記録。応答は詳細と同じ形（`digest` ＋ `log`）。ファイルパスは返さない |
| `GET /api/sessions/:id/usage` | 1本ぶんの数値。詳細（`/api/sessions/:id`）には**混ぜない** |
| `GET /api/sessions/:id/usage/baseline` | 直近24本の中央値。**これも `/usage` と分けてある**（400〜700ms 掛かるため） |
| `GET /api/usage` | 数値の横断集計。`limit` `days` `model`。上限60件で切り詰め、切ったことを `scanLimited` で返す |
| `GET /api/archive` | 書庫（終了したものも含む一覧）。`page` `per` `sort` `q` `deep` `project` `days` |
| `GET /api/stream` | SSE。`sessions` / `tick` / `error` イベント |
| `GET /api/runs` | 画面から起こしたぶんの台帳。まだ会話ログが無い時期でも、ここには最初から出ている |
| `GET /api/runs/options` | 起こすフォームの選択肢。cwd の候補・権限モード・思考量・予算の範囲・CLI の様子・いまの本数 |
| `GET /api/runs/events?from=<seq>` | 取りこぼしの穴埋め。SSE が切れているあいだの速報を拾う |
| `GET /api/runs/stream?from=<seq>` | **実行専用の SSE。**`/api/stream` には相乗りさせない |
| `GET /api/runs/:id` | 1本ぶんの全部入り。粗い `rows()` と違って `counts` や `costUSD` も入る |
| `GET /api/health` | 生存確認。二重起動の判定にも使う。版・通知の設定と数え・**自動起動の様子**・**claude CLI を掴めたか**・**抱えている実行の数**もここに出る |
| `GET /api/settings/notify` | 通知の設定。URL はマスク済み。出どころ（`sources` / `envSet`）も返す |
| `GET /api/update` | 更新の状態。ランチャが書いた紙 ＋ `canApply`（いまの起動のされ方で当てられるか） |
| `POST /api/focus?pid=N` | ターミナルの窓を前面に出す |
| `POST /api/runs` | セッションを1本起こす。202 を返し、以降は速報で追う |
| `POST /api/runs/:id/input` | 走っている（または待っている）ものへ1行送る |
| `POST /api/runs/:id/stop` | 止める。3段階。もう終わっているものへの連打は 200 |
| `POST /api/runs/:id/switch` | モデル・思考量・権限モードを替えて `--resume` で続ける。202 |
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

上限は `readJsonBody(req, limit)` の**引数**にしてある。
**全体を上げない。** 設定の窓口には小さい JSON しか来ないので、1本の定数を上げると
緩めた覚えのない口まで緩む。長い指示文を受ける3本（`POST /api/runs` と
`POST /api/runs/:id/input` と `POST /api/runs/:id/switch`）だけに `RUN_BODY_MAX`（256KB）を渡す。
切り替えにも指示文が要る（空 stdin では `system/init` すら出ない。実測）ので、同じ上限に乗せてある。

ルーティングは**完全一致を正規表現より手前に置く**。
`/api/runs/events` と `/api/runs/stream` は `/^\/api\/runs\/([\w-]{1,64})$/` にも当たるので、
順番を入れ替えると「そんな実行はありません」と 404 を返すようになる。

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

`public/js/` は 27枚 ＋ `timeline/` 7枚。**import は上から下へ一方向にだけ流す。**
逆向きに import したくなったら、置き場所が間違っている。

| 層 | ファイル | 役割 |
|---|---|---|
| 0 | `util.js` | 小道具（`el`・時刻・数値・`fact`） |
| 0 | `perf.js` | 描画にかかった時間。`window.deckPerf()` |
| 0 | `timeline/kinds.js` | 時系列の語彙。種類のラベルと、隠す種類の既定 |
| 1 | `store.js` | 画面側の状態・DOM 参照・URL クエリの同期 |
| 1 | `panel.js` | 詳細ペインの共通部品（器・見出し・折りたたみ） |
| 1 | `detail-head.js` | 詳細ペインの頭。パネルより前に出るもの |
| 1 | `usage-chart.js` | 数値の絵と数字（`svgEl`・横棒・スパークライン・`tokensStrict`・差の文字） |
| 2 | `rows.js` | 一覧の行の導出 |
| 2 | `drawer.js` | 狭い画面の一覧（引き出し） |
| 2 | `resize.js` | 作業台の左右の幅（つまみのドラッグ）。**上下限は持たない** |
| 2 | `runs.js` | 実行の台帳と速報の保持。実行専用 SSE の購読 |
| 2 | `timeline/` | 時系列。外からは `index.js` の1枚として見る |
| 3 | `detail-wait.js` | 「あなたの番」のパネル |
| 3 | `detail-panels.js` | 詳細ペインに積むパネル |
| 3 | `agents.js` | サブエージェントの記録のパネル |
| 3 | `usage-panel.js` | 数値のパネル（詳細ペイン側） |
| 3 | `run-view.js` | 実行のパネル（詳細ペイン側）。器を預かって自分で描き直す |
| 3 | `run-resume.js` | 終わっているセッションの続きを起こす口。`run-view.js` を import しない |
| 4 | `detail.js` | 詳細ペインの組み立て |
| 5 | `session.js` | 詳細の取得・保持・選択 |
| 6 | `list.js` | 稼働中の一覧と、上のバーのまとめ |
| 7 | `archive.js` | 書庫と、左のペインのタブ |
| 7 | `usage-tab.js` | 数値の横断（3つ目のモード）。誰からも import されない |
| 7 | `board.js` | 監視盤モード（列で見る）。カードは `list.js` から借りる |
| 7 | `stream.js` | SSE でつなぎ、届いた一覧を画面へ流す |
| 7 | `settings.js` | 通知の設定モーダル |
| 7 | `run-form.js` | セッションを起こすモーダル。窓口は自分で叩く |
| 7 | `update.js` | 更新のお知らせの帯と、押したあとの見張り |
| 7 | `palette.js` | 画面の中のコマンド入力（Ctrl+K）。層7 のいちばん下流 |
| 8 | `main.js` | 入口。配線・テーマ・キー操作・起動 |

数値は**取り口を3つに分けてある**（`session.js` の中）。
詳細（2秒ごと）・数値（15秒あけて取り直す）・中央値（5分あけて取り直す）。
同じ `loadDetail()` から並べて撃ち、着いた順に画面へ出す。
詳細の到着を待たない。待つと、キャッシュが効いた詳細のときだけ数値が遅れて出ることになる。

**どれも「選んでいるセッションのものか」を id で突き合わせてから出す。**
選び直した直後は前のセッションの数値が store に残っているので、
突き合わせないと**他人の数字**を数秒のあいだ出し続けることになる。

層7 の中の向きは3本。`palette.js` → `run-form.js` ／ `stream.js` → `board.js` ／
`palette.js` → `board.js`。どれも片方向で、逆を足すと循環になる。
`usage-tab.js` は誰からも import されない（呼ぶのは `main.js` だけ）。
数値モードを出す口は `initBoard({ onUsage })` で外から差す。
`board.js` があちらを直に import すると、同じ層の中に向きが1本増える。
`palette.js` は層7 のいちばん下流で、誰からも import されない（呼ぶのは `main.js` だけ）。

`board.js` が層7 なのは `list.js`（層6）から `buildCard` を借りているため。
**見た目を新しく作らない**ための借用で、向きはこちらが正しい。

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

実行の速報も同じ形で切ってある。**`runs.js`（層2）は描画側を知らない。**
`subscribeRuns(fn)` で外から登録し、配線するのは `main.js`（層8）。
`runs.js` が `run-view.js` を import すると `runs`(2) ⇄ `run-view`(3) の循環になる。

受け持ちも分けてある。届いた出来事の `kind` で行き先が変わる。

- `rows` … 台帳が動いた（現れた・状態が変わった・終わった）→ `renderDetailIfNeeded()`
- `events` … 速報が1件届いた → `RunView.render()`（パネルの中へ追記するだけ）

**速報で詳細ペインを作り直さない。** 1ターンで数百行来るので、
そこで作り直すと開いた `<details>` と入力中の caret が毎回消える。
だから `detailKeyOf()` に混ぜるのは `runStampFor()`（**出来事が増えただけでは動かない値**）にして、
中への追記は `Timeline` と同じ「器を預かって自分で描き直す」形にしてある
（`RunView.attach()` / `render()` / `detach()`）。

ふるまいで気をつけている所。

- SSE でつなぎ、`apply()` が一覧・まとめを描き直す。詳細は `renderDetailIfNeeded()` を通し、`detailKeyOf()` の値が動いたときだけ作り直す（毎回作り直すと開いた `<details>` と入力中の caret が消える）
- 時系列だけは `Timeline.render()` が `.tl-host` を差し替える。絞り込みの帯は器の外に置く（中に入れると1文字ごとに入力欄が作り直される）
- 描く先は `Timeline.attach()` で預け、`Timeline.detach()` で外す。外から時系列の内部状態を触らない
- 詳細は `detailCache`（`logSize` を印にした8件のキャッシュ）。中身が変わっていなければ取り直さない。印が `0`（不明）なら必ず取り直す
- 取り直しのあいだは `silent` で前の内容を出したままにする
- 作業台の左右の幅は、列の境目のつまみ（`.splitter`）をドラッグして変える。**動かしているあいだ `resize.js` が書くのは生の px 1つだけで、上下限は `base.css` の `clamp()` が持つ。** 窓が狭いときの蓋（`min(…, 40vw)`）も CSS 側なので、窓をリサイズすればその場で効き直す
- 覚えるのは**`clamp()` を通ったあとの幅**（`getBoundingClientRect().width`）。1回のドラッグにつき1回だけ書く。既定へ戻すのは値ではなく削除（インラインの変数と `localStorage` の両方を消す）で、行き先は `base.css` の `:root` に任せる
- つまみは矢印キーでも動く（1回 16px・Shift で4倍）。`Home` と二度押しで既定へ戻る。焦点が見えないと矢印で動くことに気づけないので `:focus-visible` で塗る
- 狭い画面（860px 以下）では一覧が引き出しになる。閉じているあいだは `inert` で丸ごと触れなくする
- 狭い画面（860px 以下）では右インスペクタが下から出る紙（ボトムシート）になる。**`position: fixed` で浮かせず、grid の同じセルに重ねる。** 幅は列が決めるので二重に書かずに済み、引き出し（`z-index: 40`）と膜（`30`）の階層にも手を出さない
- 画面のモードは `MODES`（`work` / `board` / `usage`）で照合する。`TABS` と同じ扱いで、三項演算子で二値に畳まない。`localStorage` には残さない（監視盤を開いたまま保存すると、次に開いたとき作業台へ戻る道が「押す」しか無い状態で始まる）。固定したい人は `?mode=board` `?mode=usage` でブックマークする
- **数値がタブではなくモードなのは、出す中身がセッション1本のものではないから。** 左のペインは「どのセッションを選ぶか」の場所なので、そこに横断の集計を置くと、選ぶための場所に、選んでいるものと関係のない数字が出ることになる。0.3.0 で配った `?tab=usage` は `initialMode()` が `usage` へ読み替える（**配ったブックマークは切らない**）
- 監視盤のあいだ `apply()` は `renderBoard()` だけ呼び、`renderList()` / `renderDetailIfNeeded()` / `loadDetail()` を飛ばす。中央も左も消えているうえ、詳細を引くのはサーバー側の全文読みなので、見えないもののために毎2秒撃たない。作業台へ戻るときに `setMode('work')` が3つとも追いつかせる
- **数値モードのあいだ `apply()` は何も描かない。** 監視盤と違うのはここで、あちらの材料は毎秒届く一覧そのものだが、こちらの材料は `/api/usage`（ログを全文読む）で、開いたときに1回だけ引く（`showUsage()` が自分で見張る）
- URL クエリで開き方を指定できる … `?session=<id>` `?theme=dark|light` `?only=1` `?nolive=1` `?tab=archive` `?mode=board|usage` `?aq=` `?asort=` `?tq=` `?hide=`
- 左のペインのタブは `TABS`（`live` / `archive`）で照合する。**2つに戻っても集合のままにする。** 三項演算子で二値に畳むと、知らない値がすべて `live` に落ちて、次にタブを足したときに同じ地雷を踏み直す（判定と `syncQuery` の2箇所を直すことになる）
- 数値のパネルは、詳細（`d`）が読めていなくても出す。別の窓口から届くので、詳細の失敗に巻き込む理由が無い
- **数値と中央値は `detailKeyOf()` の材料に入れる。** 入れないと、遅れて着いても鍵が動かず画面に出ない。中央値は有無だけでは足りず（5分ごとの引き直しで中身が動いても鍵が同じになる）、オブジェクトそのものも比べられない（毎回別の参照で届く）。実際に出している値だけを1本の文字列にして混ぜる
- 窓口ごと無いと分かったら一度で諦める（更新の前後で、画面だけ新しくサーバーが古いことがある）。404 の切り分けは**理由が JSON で返るかどうか**。返るならセッションが無いだけ、返らないなら窓口ごと無い
- **中央値が取れなくても何も言わない。** 差は添え物で、無くても数値は読める。ここでエラーを出すと、数値パネルの主役（何が文脈を食っているか）から目が逸れる
- `?hide=` は「キーが無い」と「空で付いている」を分けて見る。空は「何も隠さない」の指定なので既定に戻さない
- 隠している種類だけは `localStorage` に覚えさせない。開き直したら既定（足跡を隠す）に戻す。覚えさせると、足跡をいちど押して中を見ただけで既定が永久に壊れる
- 種類を隠すときは、その種類だけを数えた省略の目印（`elided`）も一緒に落とす。残すと「20 件を省略しました　足跡 20」の文字だけが並び、隠れていないように見える（実測で窓 120 件のうち 36 件がこれだった）
- **省略は絞り込みのチップに出さない。** 上の通り、出るか出ないかは他のチップ側で決まるので、独立したチップにすると件数が嘘になる。実測では「省略 74」と出しながら1行も出ない状態になっていた（74 件すべてが足跡だけの区間で、足跡は既定で隠れる）。その状態で他を全部隠すと時系列が空になる。目印ごと消す指定は URL に残してある（`?hide=elided`）
- 窓（`TL_FIRST` = 4 で開き、`TL_MORE` = 60 ずつ継ぎ足す）の外にしか無い種類は名前で伝える。足跡は新しい 200 件だけが残るので、古い順で見ていると窓の中に1件も入らないことがある。黙っていると「押しても変わらない」に見える
- 描画にかかった時間は `window.deckPerf()` で見る（目安は `renderDetail` が 50ms 未満、時系列の描き直しが 16ms 未満）。測る入れ物は `perf.js` の1つに保つ（2つに割ると `deckPerf()` が片方しか見えない）
- パレット（Ctrl+K）は**自分では何も決めない。** すでにある窓口（`select` / `setDetailTab` / `setInspector` / `setListOpen` / `openRunForm` / `focusTerminal`）を呼ぶだけの器にしてある。判定を持たせると、画面の押しボタンとパレットで挙動が食い違う
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

CSS は `public/css/` に13枚ある。`index.html` の `<link>` の並びが、そのまま重ね順になる。

| ファイル | 中身 |
|---|---|
| `tokens.css` | 色の実体（`--l-*` / `--d-*`）・意味トークン・暗いほうへの差し替え |
| `base.css` | リセット・全体の骨（**左右の幅の上下限と既定**）・幅のつまみ・上のバー・共通のボタン |
| `list.css` | 一覧と書庫のカード |
| `detail.css` | 詳細ペイン・パネルの器・待ち・判断・facts |
| `timeline.css` | 時系列 |
| `panels.css` | TODO・サブエージェントの記録・ファイル |
| `settings.css` | 通知の設定モーダル |
| `update.css` | 更新のお知らせの帯 |
| `usage.css` | 数値（札・横棒・スパークライン・表の対）と、**数値モードの骨格**（`.is-usage`。`board.css` の `.is-board` と同じ形） |
| `run.css` | 実行のパネル（速報の行・種類の札・入力欄）と、起こすフォームの器 |
| `palette.css` | 画面の中のコマンド入力（Ctrl+K）の器・行・キー案内 |
| `board.css` | 監視盤モード（モードの切り替え・骨格の組み替え・列） |
| `narrow.css` | 狭い窓向け（`@media (max-width: 860px)`） |

**`<link>` の順番を入れ替えない。** CSS は宣言順で勝ち負けが付く。
`narrow.css` は上の12枚を上書きするので、必ず最後に読む。

`usage.css` も**色を新しく作らない。** 使うのは `--accent`（強調1本）と
`--fg-faint` / `--border-strong`（文脈）だけ。
多色のパレットを足すと `tokens.css` の二重定義（`prefers-color-scheme` 側と
`[data-theme="dark"]` 側）を両方直す義務が生まれる。足さなければただ乗りできる。

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
- **`requestId` で重複を潰してから合計する。** 1回の API 応答が thinking / text / tool_use の複数行に分かれ、**その全行が同じ `usage` を持つ**（実測 12,346行 → 一意 5,928）。素で足すと約2倍になる
- **`digest.mjs` の `stats.turns` を往復数として使わない。** assistant の行数なので約1.85倍ある。数値の側では `requests` を使う
- **文脈保有量を合計しない。** `input_tokens` は「キャッシュされなかった残り」だけで、`in + cr + cw` の3つ足して初めて全長になる。足し合わせた瞬間に意味を失うので、合計する経路を実装上も作らない
- **キャッシュ命中率をモデルまたぎで比べない。** プロンプトキャッシュの最小長がモデル別で、しかも単調でない（Opus 5 = 512 / **Opus 4.7 = 2,048** / Opus 4.6・Haiku 4.5 = 4,096）。**未満だとエラーも出さずに黙ってキャッシュされない。** 古いモデルが低く見えるのは行動の差だけではない
- **`cumulativeDroppedTokens` を足さない。** あれは累積値。実測40ログ・圧縮475件で、最後の値が `Σ(pre − post)` と1トークンの狂いもなく一致した。素で合計すると圧縮64回のログで60倍近くに膨れる
- **`toolUseResult.totalTokens` を消費量として使わない。** 実測で**最終要求の `in+out+cr+cw`**（＝終了時点の文脈保有量）と完全一致した。合計 2,027,396 のキャッシュ読みがあるエージェントが `113696` を返している
- **数値の集計に `read/cache.mjs` を使わない。** 240件 LRU を全文で埋めると一覧の `tail:` memo が全部追い出され、373MB を JS オブジェクトで持つとメモリが数GBに膨れる。`view/usage.mjs` の専用 memo に**集計結果だけ**を載せる
- **中央値を `getSessionUsage` に混ぜない。** 直近24本を全文読むので実測 400〜700ms 掛かり、混ぜると初回が 1420〜1543ms になる。分けた実測は usage 459ms / baseline 640ms。画面は数値を先に出して、遅れて差を書き足す
- **`percentile` を2箇所に書かない。** `parse/usage.mjs` から export して横断側と共有する。書き分けると、同じ p90 が画面の場所によって違う値になる
- **`util.js` の `tokens()` を数値の画面で使わない。** `if (!n) return null` なので **0 と不明が同じに見える。** `usage-chart.js` の `tokensStrict` を使う（既存の `tokens()` は変更しない。他の表示が一斉に変わる）
- **因果は取れないと画面に常時書く。** スキルの区間で測っているのは「呼んだ直後の一続き」であって、スキルが原因とは限らない。折りたたまない。**これが無い状態で出荷しない**
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
- **`port.json` を書く・消すのは `--port-file` を渡された起動だけ。** 紙は1枚しかないので、同じマシンで2本立つと後から立ったほうが上書きし、先に止めたほうが消す。実際に踏んだ（インストール版が 4317 で動いているのに紙だけ消えた。開発側の `npm start` を Ctrl+C した後始末が巻き添えにしていた）。判定は `hasPortFileFlag`。**`CLAUDE_DECK_PORT` で分岐してはいけない** — 更新後の再起動でランチャ自身が `CLAUDE_DECK_PORT=prevPort` を渡すので、インストール版でも立つ。書き先の分岐に使うと更新直後だけ別の場所に書くことになる
- **配布物は許可リストで組む。** 除外リストは黙って古くなる（`assets/` を除いていても、次に足した大きなフォルダは素通りする）。許可リストなら足し忘れたときにアプリが起動せず、その場で分かる
- **版の出どころを増やさない。** `package.json` の `version` の1箇所から `appinfo.mjs` と `release.ps1` が派生する。3つが同期するのではなく、2つが1つから派生する形にする。C# 側に版を書き写さない・`vpk` に手で打たない
- **起こす cwd は許可リストの配下だけ。** 任意の文字列を受けない。判定は `path.resolve` で正規化してから `path.relative` が `..` で始まらないことを見る（`startsWith` は `C:\work\demo2` を `C:\work\demo` の子と誤認する）。win32 では大小を無視する。門番はブラウザ越しの攻撃を止めるが、**この機能の被害は「コードが実行される」という質の違うもの**なので、万一届いても影響がその人の作業フォルダに留まる形にしておく
- **`-` で始まる値を空文字へ丸めない。** 弾いて理由を返す。argv は配列で渡すのでシェルの穴は無いが、commander は値の位置にあっても `-` で始まる語を**フラグとして読む**。黙って落とすと「指定したのに既定のモデルで動いた」になり、画面には何も出ない。0 と不明を分けるのと同じ扱い（`run/spec.mjs` の `flagLike`）
- **モデル名の許可リストを持たない。** 文字種と長さだけ見て、使えるかは CLI に判断させる。一覧を持つと新しいモデルが出るたびに古くなり、「使えるはずのモデルが画面から選べない」という直しにくい形になる。副作用として `claude-opus-5[1m]` のような角括弧付きは通らない（テストに事実として書いてある）
- **`--verbose` を外さない。** `--print --output-format stream-json` だけだと exit 1 で **stdout が1行も出ない**（実測）。「起こしたのに無言で死ぬ」といういちばん分かりにくい壊れ方になる
- **指示文を argv に載せない。** 必ず stdin へ JSON の1行として書く
- **`.cmd` / `.bat` を実行ファイルに使わない。** `shell:true` が要り、引数がシェルの構文として解釈される
- **`CLAUDE_DECK_CLAUDE_BIN` が空振りしても次へ落ちない。** 理由を付けて止める。落とすと「指定したのに違うものが動いている」になる
- **`child.stdout.setEncoding('utf8')` を必ず呼ぶ。** 素の Buffer を `toString()` するとチャンク境界で日本語が割れる。行に割るのは `createLineSplitter` の仕事で、**上限を超えた行は捨てて数える**（黙って捨てない）
- **`bypassPermissions` を画面の語彙に入れない。** `CLAUDE_DECK_RUN_ALLOW_BYPASS` が立っているときだけ。ブラウザから押せる「許可を一切求めずに何でも実行する」ボタンは、このアプリが持ちうる最も危険なもの。`CLAUDE_DECK_NOTIFY_OFF` と同じ帯域外のスイッチにする
- **`manual` を選ばせない。** 非対話で許可要求が来たときの返し方が確かめられていない。当てずっぽうで実装すると、要求に答えられないまま止まったプロセスが残り、画面には「実行中」と出続ける
- **実行の速報を `/api/stream` に相乗りさせない。** あちらは全タブが常時つないでいる一覧の経路で、1秒 tick と差分判定が付いている。1ターンで数百行出る速報を混ぜると、一覧の更新が実行の量に引きずられる。専用の `/api/runs/stream` に分ける
- **`runner.subscribe()` を窓ごとに呼ばない。** サーバーが1回だけ購読して、開いている SSE 全部へ配る。窓ごとに購読すると閉じ忘れが listeners に静かに溜まる
- **`readJsonBody` の上限を全体で上げない。** 長い指示文を受ける3本（`POST /api/runs` と `POST /api/runs/:id/input` と `POST /api/runs/:id/switch`）にだけ `RUN_BODY_MAX`（256KB）を引数で渡す。1本の定数を上げると、緩めた覚えのない口まで緩む
- **`rows()` に毎秒動く値を入れない。** `refresh()` の差分判定が除外しているのは `idleMs` と `lastActivityAt` の2つだけ。受信行数やトークン数を混ぜると、内容が同じでも毎秒 push することになる。細かい値は `get()`（詳細ペイン用）の側に置く
- **断る理由と HTTP の番号は `run/index.mjs` が決める。** 503（CLI を掴めていない）・400（指定が不正）・429（本数と間隔）・500（起こせなかった）の4種類。`server.mjs` 側で理由の文字列を見て振り分けると、言い回しを直しただけで番号が変わる
- **`shutdown()` で `runner.shutdown()` を待たない。** 止め方の3段は最長5秒かかるが、`shutdown()` の hard exit は 500ms。待たせると Ctrl+C がすぐ効かなくなる。1段目の `stdin.end()` は同期で始まるので、行儀のよい相手はそれで畳まれる（実測 `code=0`）
- **完全一致のルーティングを正規表現より手前に置く。** `/api/runs/events` と `/api/runs/stream` は `/^\/api\/runs\/([\w-]{1,64})$/` にも当たる。順番を入れ替えると「そんな実行はありません」と 404 を返すようになる
- **`stalled` を「応答なし」と書かない。** 見たのは「出力が来ていない」だけで、故障かどうかは分からない。実測（2026-08-23）で5回とも圧縮の最中の正常な無音だった（間隔121秒）。「応答なし」は診断なので、動いているセッションを故障として報告することになる。0 と不明を分けるのと同じ扱いで、**言うのは測ったことだけ**（`RUN_STATE_LABELS.stalled = '無音'` と `quietFor()`）
- **しきい値（`STALL_MS`）を延ばして黙らせない。** 延ばしても同じ文を遅れて出すだけで、本当に固まったものが埋もれる時間が伸びる。直すのは言い方のほう
- **無音から抜けたら `run.reason` を落とす。** 抜け口は4つ（行が届く・指示を送る・止める・切り替える）。残すと、動いているのに一覧の理由が「出力が…止まっています」のままになり、止めたときは実行パネルの「理由」の行が**止まった理由**として読まれる。落とすのは `stalled` のときだけ（`waiting` の理由は前の往復の結果の話なので残す）
- **予算切れを「終わった」として扱わない。** `--max-budget-usd` に当たっても `result` が出るだけで**プロセスは生きている**（実測）。止めるまで機械を掴んだままになる
- **`result` の `num_turns` を累積として読まない。** そのターンぶんの数で、2往復目も 1 が入る。累積なのは `total_cost_usd` のほう。同じ行に並んでいるので混ぜやすい
- **`total_cost_usd` を run 全体の合計として画面に出さない。** 累積するのは同じ子のあいだだけで、`/switch` は子を起こし直すので起点に戻る（実測 0.401036 → 0.130617）。ラベルは「この起動ぶんの費用」にしてある。「ここまで」と書くと、切り替え後の小さい値を全体の合計として読ませることになる
- **速報が1件届くたびに詳細ペインを作り直さない。** 1ターンで数百行来るので、開いた `<details>` と入力中の caret が毎回消える。`detailKeyOf()` に混ぜるのは `runStampFor()`（出来事が増えただけでは動かない値）だけにして、中への追記は `RunView.render()` に任せる（`Timeline` と同じ「器を預かって自分で描き直す」形）
- **`runs.js`（層2）から `run-view.js`（層3）を import しない。** 逆向きになる。`subscribeRuns(fn)` で外から登録し、配線するのは `main.js`（層8）。既存の循環4箇所と同じ切り方
- **実行パネルを詳細（`d`）の中に入れない。** 起こした直後はまだ会話ログが1行も無く、`d` は null。中に入れるとログが出るまで何も出ず、押したのに何も起きていないように見える
- **起こしたセッションを `select(id, 'live')` で選ばない。** `'query'` にする。起こした直後は一覧にまだ並ばないので、`'live'` で選ぶと次の push（2秒後）に `stream.js` の `apply()` が「一覧から消えた」と読んで選択を外し、先頭のセッションへ飛ぶ
- **起こした直後に画面を勝手に動かさない。** モーダルを閉じて詳細ペインへ飛ばすと、会話ログが出るまでの数秒「このセッションは開けませんでした」を見せることになる。結果はモーダルの中に出して、移るかどうかは押した人に決めてもらう
- **起こすフォームの見た目を新しく作らない。** 中身は設定モーダルのクラス（`.settings-head` / `.settings-body` / `.settings-sec` / `.settings-label` / `.settings-row` / `.settings-hint` / `.settings-grid` / `.settings-text` / `.settings-num` / `.settings-select` / `.settings-foot` / `.settings-msg`）をそのまま借りる。あちらのセレクタは `.settings` を親に取っていないクラス単体なので、`.runform` の中でも効く。`run.css` に書き写すのは `.settings` 自身に紐づく4つ（本体・`::backdrop`・`[open]`・幅）だけ
- **終わっていてログも無い run を一覧へ合成しない。** 足すと、書庫にも詳細にも出せない幽霊行が `HISTORY_MAX` 件ぶん残る。起こしてすぐ失敗したものは実行パネルとフォームの帯に出るので、そちらで足りる
- **合流を `view/` の中でやらない。** `view/` と `run/` はお互いを import しない決まりなので、合成の場所は `server.mjs` の `refresh()` だけ。並べ直しは `view/sessions.mjs` の `sortRows` を使う（比較器を2箇所に書かない）
- **切り替えを画面から2手（停止 → 起動）にしない。** あいだが空くと、前の子がまだ畳まれないうちに次が起きて、同じ会話ログに2つのプロセスが書きうる。`POST /api/runs/:id/switch` の1本にまとめ、サーバー側で `close` を待ってから起こす
- **切り替えで断る判断を、子を畳んだ後に置かない。** 通らないと分かっているのに殺すと、断るだけで済んだはずのものが「止まっただけ」で終わる。順は 404 → 409（終端）→ 409（起動指定が無い）→ 400（`mergeSwitch`）→ 400（指示）→ 503（CLI）→ 400（`buildRunSpec`）→ そこで初めて畳む
- **畳んだ後の再確認を `isRunOver` で済ませない。** 見るのは「まだ `switching` か」の1点。`stopping` は終端ではないので `isRunOver` では素通りし、止めろと言われた run の子だけが生き残る
- **`detach()` で `live` から entry を消すのは終端のときだけ。** `perTurn`（`waiting`）で消すと `entry.spec` が失われ、切り替えが「起動指定が残っていません」で断られる
- **`process.on('exit')` から `runner.shutdown()` を呼ばない。** ここは**同期しか走らない**ので、`await` を含むあれは何もしないまま終わる。`livePids()` で PID を受け取って `killTreeSync` に任せる
- **`killTreeSync` の返り値を「落ちた」と読まない。** 返しているのは「手を出したか」。同期で確かめる手段が無いので、確かめられないことを返り値の意味に混ぜない
- **キー操作の判定にクラス名を使わない。** 見た目を借りている以上、`.settings-text` のような借り先の名前が `run-form.js` に書かれることになる。要素名（`input, select`）で見て、本文欄だけは参照（`ev.target === dom.runPrompt`）で分ける
- **生きているセッションへ横から指示を入れる口を作らない。** 続きを起こす口を出すのは `row.alive === false` のときだけ。生きているものへ出すと、同じ会話ログへ2つのプロセスが書く形になる。対話版への打鍵注入は `os/focus.mjs` 冒頭で降りた道で、そちらは「ターミナルを前面に」で足りる
- **`liveSessions` が `null`（一覧をまだ一度も読めていない）のときに「誰も動いていない」と読み替えない。** `Set` でなければ 409 で断る。読み替えると、起動直後の数秒だけ二重起動を素通りさせることになる。0 と不明を分けるのと同じ扱い
- **パレットに「止める」「替える」「続ける」を出さない。** どれも子プロセスを畳む（あるいは起こす）操作で、Enter ひと押しで走ってしまう。打った文字で並びが動くので、狙っていないものを実行する事故が起きうる。この3つは実行パネルの押しやすい場所にあるので、そちらで足りる（出すのはモーダルが開くだけの「起こす」と、窓が出るだけの「ターミナルを前面に」の2つ）
- **パレットに個別のショートカット（Ctrl+N など）を足さない。** Ctrl+K 以外はブラウザが先に取っているものが多く、奪えないキーを画面に書くと「押しても効かないキー」を案内することになる
- **`exec()` で閉じるのを実行より先に置く。** `<dialog>` は閉じるときに開く前の焦点へ戻すので、焦点を動かすもの（一覧を出す）を先にやると、せっかく移った焦点をこちらが奪う。結果を読ませたいもの（`keepOpen`）だけ閉じずに残す
- **パレットの `scrollIntoView` は、直前がグループ見出しならそちらを寄せる。** `block: 'nearest'` は「見える範囲に入っていれば動かさない」ので、項目そのものを寄せると見出しが上に隠れ、どの群にいるのか読めなくなる（末尾から先頭へ巻き戻ったとき、実測で 28.8px ぶん隠れていた）
- **`applyOptions()` を再描画のたびに当てない。** 詳細ペインは他の理由でもよく組み直されるので、毎回 `defaultMode` と `budget.default` を代入し直すと、選んだモードと予算が黙って既定へ戻る。`ui.filled` で1回だけにして、落とすのは別のセッションへ移ったときだけ
- **狭い画面のインスペクタを別のセルへ置かない。** 単一列の `.deck` に in-flow の子が3つ（`.detail-pane` / `.insp` / `.rail`）あると2列から溢れて暗黙の2行目ができ、レールが画面の下で横倒しの帯になる（段2 で実測）。`grid-area` を明示して1行2列へ押し込む（`.detail-pane` と `.insp` を `1 / 1` に重ね、`.rail` を `1 / 2`）。こうすれば重ねる紙が何枚あっても行は増えない。`position: fixed` で浮かせる手もあるが、そちらはレールの幅を `right: <幅>` として二重に書くことになる
- **ボトムシートに膜を敷かない。** レール（`z-index` を持たない）がその下に潜り、開く口と閉じる口を兼ねているレールの設計が狭い画面だけ崩れる。閉じる口は紙の頭の × と、押したのと同じレールのボタン（`setInspector` はトグル）の2つで足りる
- **`.insp` に `z-index` を付ける。** 重なりの順は DOM の並びでは決まらない。中央の中にあるタブの帯（`.detail-tabs`）が sticky ＋ `z-index: 2` なので、印を付けない紙はその下へ潜り、閉じるボタンの上にタブが透けて出る。grid item は `position: static` でも `z-index` が効くので1つ足すだけで済む
- **紙の出方を `transition` で書かない。** `.insp` は JS が `hidden` で消すので `display: none` から現れ、遷移の1フレーム目が無い。`animation` にすれば `base.css` の `prefers-reduced-motion` が `animation-duration` を潰すのでただ乗りできる
- **監視盤を作業台と同居させない。** モードとして分ける（`store.mode`）。同居させると「どれから手をつけるか」と「いまの作業」が同じ画面で場所を取り合う。それがこの組み替えの発端そのものなので、片方を見ているあいだもう片方は `board.css` の `.is-board` で丸ごと消す
- **監視盤で `onlyLive` を見ない。** 絞ると4列目（直近に終わったもの）が丸ごと消える。一覧（`/api/sessions`）は終了ぶんを24時間持っているので、絞る前の `store.rows` を直に見る。それより古いものは書庫タブの仕事なので、監視盤からは引かない
- **監視盤で並べ替えない。** `store.rows` はサーバー側が `STATE_RANK` と `idleMs` で並べたものなので、順に振り分ければ列の中も正しい順になる。比較器を2箇所に書かない
- **列に入らなかったぶんは必ず数を出す。** 黙って落とすと、サーバー側が状態を1つ足した日に「一覧の件数と列の合計が食い違う」だけになり、どこへ消えたのか分からない。0 と不明を分けるのと同じ扱いで、行き先（作業台の一覧）まで添える
- **監視盤の `.deck` の上書きを `narrow.css` へ写さない。** `board.css` の `.is-board .deck`（0,2,0）が、あちらの `.deck` 単体（0,1,0）に詳細度で勝つ。セレクタリストは1つずつ独立に詳細度を持つので、隣に並んでいる `.is-insp-open .deck`（0,2,0）はこの勝負に関わらない。**読む順ではなく詳細度で決まる。** 一度「後から読まれるほうが勝つ」と読んで11行足したが、実測（インスペクタの開・閉の両方で抜いても1列のまま）で不要だと分かって落とした
- **監視盤のカードを新しく作らない。** `list.js` の `buildCard` を export して借りる（`run-form.js` が設定モーダルのクラスを借りたのと同じ理由）。違うのは押されたあとの後始末だけなので、そこだけ差し替えられる形（`buildCard(row, onPick)`）にしてある。`board.js` が層7 なのはこの借用のため（`list.js` は層6）
- **`usage.css` の `.is-usage .deck` に `.is-usage.is-insp-open .deck` を並べて書く。** `board.css` の `.is-board` とまったく同じ理由で、`narrow.css` があとから読む `.is-insp-open .deck`（0,2,0）は `.is-usage .deck`（0,2,0）に**読む順で勝つ**。(0,3,0) の側を書かないと、右の枠を開いたまま数値へ移った人だけ列が戻る。**逆に `@media` で囲む必要は無い**（タブだった頃は狭い画面の引き出しを壊さないよう 861px 以上に閉じ込めていたが、モードは `.list-pane` を `display: none` で丸ごと消すので、狭い画面でも同じ形で通る）
- **幅の上下限を JS に持たせない。** `base.css` の `clamp()` に任せ、`resize.js` が書くのは生の px 1つだけにする。窓が狭いときの蓋（`min(…, 40vw)`）を JS で測って自分で丸めると、窓のリサイズに追いつかないうえ CSS 側と二重管理になる
- **既定へ戻すときに値を書かない。** インラインの変数と `localStorage` の記録を消すだけにする。両方に既定値を持つと必ず片方が古くなる（版の出どころを増やさないのと同じ理屈）
- **覚えるのは `clamp()` を通ったあとの幅**（`getBoundingClientRect().width`）。生の px を覚えると、端まで引っ張ったときに範囲の外の値が残る（実測で `-556px` / `1888px`）。次に開いたとき捨てるか範囲外を持ち続けるかのどちらかになり、**下限に張り付けていたつもりが既定の幅に戻る**
- **保存した幅を検証せずに当てない。** `localStorage` は人が書き換えられる場所。有限の数でない値が `--list-w` に入ると `clamp()` ごと無効になり、`grid-template-columns` が丸ごと落ちて列が消える
- **つまみを `.deck` の grid の子にしない。** `.deck` は「子の数と列の数が釣り合う」前提で組んである（閉じているあいだ `.insp` は `hidden`）。4つ目を挿すと閉じているときの釣り合いが崩れる。ペインの中に置いて絶対配置する。`z-index` を付けるのは、中央の `.detail-tabs` が sticky ＋ `z-index: 2` で、印が無いと帯の下に潜って上のほうだけ掴めなくなるため
- **つまみを収めるペインのセレクタを `.deck >` で絞らない。** `.deck > .list-pane`（0,2,0）は `narrow.css` の `.list-pane { position: fixed }`（0,1,0）に**詳細度で勝ってしまい**、狭い画面の引き出しが列に戻って重なる。裸の `.list-pane`（0,1,0）にしておけば、最後に読まれる `narrow.css` が勝てる。`.is-board .deck` の側とは**逆向きの罠**なので、どちらに勝たせたいのかを毎回確かめる
- **狭い画面につまみを出さない。** あちらの一覧は列ではなく引き出し（`position: fixed` ＋ `z-index: 40`）で、幅は `width: min(88vw, 24rem)` が決める。掴む境目そのものが無いので `narrow.css` で `display: none` にする（インスペクタも中央に重ねる紙なので同じ）

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このプロジェクトは何か

並行して動かしている Claude Code のセッションを、一覧と詳細で見るローカルダッシュボード。

`~/.claude` 配下に Claude Code 自身が書いているファイルを **読み取り専用** で解析する。
目的は2つに絞られている。

- どのセッションが自分の返事を待っているか（ボールの所在）
- そのセッションで自分が何を判断したか（選んだ選択肢とその説明）

外部パッケージはゼロ。Node.js 18 以降の標準モジュールだけで動く。

## コマンド

```
npm start                        サーバー起動＋ブラウザを開く（= node server.mjs）
npm run serve                    サーバーだけ起動（= node server.mjs --no-open）
npm run list                     一覧をターミナルに1回出す
npm test                         回帰テストを走らせる（= node --test）
node cli.mjs --live              3秒ごとに出し直す
node cli.mjs --all               終了したものも含めて全部出す
ClaudeDeck.cmd                   配布先向けの起動口。ダブルクリック用
```

自動起動とアイコンの作り直しは PowerShell スクリプト。

```
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action status
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action start|stop|uninstall
powershell -ExecutionPolicy Bypass -File scripts\build-icons.ps1
```

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
| `notify-watch.test.mjs` | いつ何を送るかの状態機械（通知の本丸） |
| `notify-message.test.mjs` | 通知の本文。載せないものと、URL のマスク |
| `notify-config.test.mjs` | 設定の優先順と URL の検証 |
| `notify-slack.test.mjs` | Slack の応答をどう読むか |
| `notify-index.test.mjs` | 通知の配線。とくに失敗したときのふるまい |

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

`src/` は役割ごとに5つに分けてある。
import は上から下へ一方向にだけ流れる。逆向きに import したくなったら、置き場所が間違っている。

| 場所 | 役割 | 中身 |
|---|---|---|
| `src/read/` | `~/.claude` を読む | `paths` `cache` `registry` `transcript` `tasks` `plans` `subagents` |
| `src/parse/` | ログを解釈する | `entries` `meta` `state` `digest` ＋ `digest/`（`limits` `answers` `waits` `trim`） |
| `src/view/` | API 応答を組む | `sessions`（一覧） `detail` `summary` `shape` `archive`（書庫） `entry`（原文） `plans`（プランの系譜） `subagent`（調査記録） |
| `src/notify/` | 回答待ちを外へ知らせる | `index`（配線） `watch`（状態機械） `message`（本文） `config`（設定） `slack`（送信） |
| `src/shared/` | どの層からも使う小道具 | `text`（`oneLine` / `clip`） `tools`（`describeTool`） `appdata`（書き込み先） |
| `src/os/` | OS を叩く | `focus` |

流れは `read` → `parse` → `view` → `notify`。
`shared` はどこからでも使えるが、逆に `shared` から他を import してはいけない。

`notify/` は末端に足した層で、**`view/` を import しない。**
`listSessions()` が返した行（ただの JSON）を受け取るだけにしてある。
これで向きが一方向のまま保たれ、テストも行のリテラルを渡すだけで書ける。

入口は4つだけ。ここの名前と応答の形は変えない。

- `view/sessions.mjs:listSessions`
- `view/detail.mjs:getSessionDetail`
- `notify/index.mjs:createNotifier`
- `os/focus.mjs:focusTerminal`

`digest.mjs` に残しているのは走査の本体（`buildDigest`）と、走査の前に1回だけ作る索引だけ。
走査から呼ぶ判断は `digest/` の4枚に分けてある。`buildDigest` 本体は分けない
（1つのループで `items` と `files` と `stats` を同時に埋めているため）。

画面側は `public/` の下に2つ。

| 場所 | 役割 | 中身 |
|---|---|---|
| `public/css/` | 見た目 | 7枚。`<link>` の並びがそのまま重ね順になる |
| `public/js/` | 画面の組み立て | 16枚 ＋ `timeline/` 7枚 |

こちらも import は一方向。層の一覧と、循環を切っている4箇所は「画面側」に書いてある。

`assets/favicon.png` はアイコンの元絵。1.3MB あるので `src/` には置かない。

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

環境変数を優先し、無ければ `%LOCALAPPDATA%\ClaudeDeck\config.json`。
起動時に1回だけ読む。変えたら再起動する。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `CLAUDE_DECK_SLACK_WEBHOOK` | なし | Webhook URL。これが唯一の有効化スイッチ |
| `CLAUDE_DECK_NOTIFY_SETTLE` | 6 | 落ち着き待ちの秒数。0 で即時 |
| `CLAUDE_DECK_NOTIFY_IDLE` | 2 | 返信待ちの落ち着き待ちの分。0 で返信待ちを通知しない |
| `CLAUDE_DECK_NOTIFY_REMIND` | 0 | 放置リマインドの分。0 で無効 |
| `CLAUDE_DECK_NOTIFY_DETAIL` | full | `none` にすると質問文を落とす |

```json
{ "notify": { "slackWebhookUrl": "https://hooks.slack.com/services/...", "settleSec": 6, "idleMin": 2, "remindMin": 0, "detail": "full" } }
```

`CLAUDE_DECK_NOTIFY_IDLE` を 0 にすると、実質すべての通知が止まる。
上に書いたとおり、実際に鳴っているのは返信待ちの経路だけだから。
うるさいと感じたときは 0 にする前に、まず分を伸ばすほうを試す。

Webhook の作り方は `docs/slack-webhook-setup.html` にある。

設定ミスに気づけるよう、有効なら起動時に1行出す。URL はマスク済みしか出さない。
自動起動されたサーバーにはターミナルで `set` した環境変数が届かないので、
`/api/health` の `notify` が裏で動いているサーバーの設定を確かめる唯一の手段になる。

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
| `GET /api/health` | 生存確認。二重起動の判定にも使う。通知の設定と数えもここに出る |
| `POST /api/focus?pid=N` | ターミナルの窓を前面に出す |

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

`public/js/` は 16枚 ＋ `timeline/` 7枚。**import は上から下へ一方向にだけ流す。**
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

状態ラベルの日本語は画面側に持たない。
`/api/sessions` の `meta.stateLabels`（`STATE_LABELS` そのまま）から引く。
状態を1つ増やすときに直すのは `parse/state.mjs` だけで済む。

CSS は `public/css/` に7枚ある。`index.html` の `<link>` の並びが、そのまま重ね順になる。

| ファイル | 中身 |
|---|---|
| `tokens.css` | 色の実体（`--l-*` / `--d-*`）・意味トークン・暗いほうへの差し替え |
| `base.css` | リセット・全体の骨・上のバー・共通のボタン |
| `list.css` | 一覧と書庫のカード |
| `detail.css` | 詳細ペイン・パネルの器・待ち・判断・facts |
| `timeline.css` | 時系列 |
| `panels.css` | TODO・サブエージェントの記録・ファイル |
| `narrow.css` | 狭い窓向け（`@media (max-width: 860px)`） |

**`<link>` の順番を入れ替えない。** CSS は宣言順で勝ち負けが付く。
`narrow.css` は上の6枚を上書きするので、必ず最後に読む。

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
- **依存パッケージを増やさない。** 同僚にフォルダごと渡して動くことが要件。`dependencies` は空のまま
- **未知の形で落ちない。** 読んでいるのは Claude Code の内部データで公開仕様ではない。未知のキー・未知の `status`・書き込み途中の壊れた JSON が来ても、黙って飛ばして進む
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
- **送り先は `hooks.slack.com` に固定する。** タイポで別のホストへ業務内容を POST する事故を、機能として防ぐ。この検証を緩めない
- **`notify/watch.mjs` に I/O を入れない。** 時刻も外から `now` で渡す。ここが純粋だから「送るかどうか」の全分岐をテストで通せる。`observe()` は同期に保つ（`await` を挟むと `refresh()` が `refreshing` を立てている区間が延びる）
- **返信待ちの鍵をセッション ID だけで作らない。** `anchorId`（ログの最後の行の uuid）を混ぜる。混ぜないと鍵が生涯1つになり、1通鳴ったきり2回目以降が黙って落ちる。この壊れ方はテストを書いていないと気づけない（鳴らないだけで、どこにもエラーが出ない）
- **`needs-approval` を `byStatus` の裏づけ無しで通知しない。** しきい値だけが根拠の側は、長く走る Bash と区別がつかない（実測で50秒の Bash が同じ形になった）。auto mode で Claude が自分で承認した分を誤報として送ることになる
- **通知済みの記録をファイルに残さない。** メモリだけで足りる。種まきで重複は消えるので、書き込み失敗・壊れた JSON・古い記録の掃除という失敗経路を3つ増やす価値がない

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

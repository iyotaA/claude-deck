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

テストは `node:test`（Node 18 以降に入っている標準のもの）。`npm test` で `test/` 配下が走る。
**リンタは無い。** 設定していない。

```
npm test                         全部走らせる
node --test test/state.test.mjs  1ファイルだけ走らせる
```

`node --test test/` のようにフォルダを渡す形は使えない（Node 22 以降は引数をグロブとして解釈する）。
引数なしの `node --test` が両方の版で動く。

**どのファイルが何を見ているかの一覧は `test/CLAUDE.md` にある。**

## ファイルの置き場所

`src/` は役割ごとに8つに分けてある。
import は上から下へ一方向にだけ流れる。逆向きに import したくなったら、置き場所が間違っている。

| 場所 | 役割 | 中身 |
|---|---|---|
| `src/read/` | `~/.claude` を読む | `paths` `cache` `registry` `transcript` `tasks` `plans` `subagents` `skills`（索引） |
| `src/parse/` | ログを解釈する | `entries` `meta` `state` `digest` ＋ `digest/`（`limits` `answers` `waits` `trim`） `usage`（数値） `stream`（実行中の行） |
| `src/view/` | API 応答を組む | `sessions`（一覧） `detail` `summary` `shape` `archive`（書庫） `entry`（原文） `plans`（プランの系譜） `subagent`（調査記録） `usage`（数値） `query`（クエリの読み取り） |
| `src/notify/` | 回答待ちを外へ知らせる | `index`（配線） `watch`（状態機械） `message`（本文） `config`（読む） `settings`（書く） `slack`（送信） |
| `src/run/` | 画面から起こすセッション | `index`（配線） `ledger`（台帳と状態機械） `ask`（許可要求カードの組み立て） `merge`（一覧への合流） `spec`（起動指定の検証と argv） `event`（速報1件の畳み方） `dirs`（起こしてよいフォルダの登録） `rate`（枠の使用率を紙に1枚） |
| `src/update/` | ランチャが書いた更新の紙を読む | `state` |
| `src/startup/` | ランチャが書いた自動起動の紙を読む | `state` |
| `src/shared/` | どの層からも使う小道具 | `text`（`oneLine` / `clip`） `tools`（`describeTool` / `isLongRunningTool`） `appdata`（書き込み先） `configfile`（`config.json` の読み書き） `origin`（書き込み口の門番） `appinfo`（版） `portfile`（`port.json`） `portclaim`（ポートの取り合いの決め方） `env`（止めるスイッチの読み方） `objects`（`isPlainObject`） `lru`（`createLru`。**store は共有しない**） |
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
- `run/index.mjs:createRunner`（`server.mjs` が触る唯一の口。16個の関数を返す）
- `run/spec.mjs:buildRunSpec`（起動指定を検証して argv まで組む）
- `os/focus.mjs:focusTerminal`
- `os/claude.mjs:probeClaude` / `claudeInfo`（探すのと、結果を読むのを分けてある）

`digest.mjs` に残しているのは走査の本体（`buildDigest`）と、走査の前に1回だけ作る索引だけ。
走査から呼ぶ判断は `digest/` の4枚に分けてある。`buildDigest` 本体は分けない
（1つのループで `items` と `files` と `stats` を同時に埋めているため）。

画面側は `public/` の下に2つ。

| 場所 | 役割 | 中身 |
|---|---|---|
| `public/css/` | 見た目 | `<link>` の並びがそのまま重ね順になる |
| `public/js/` | 画面の組み立て | 層0〜8 ＋ `timeline/`。一覧は `public/CLAUDE.md` の表 |

こちらも import は一方向。層の一覧と、循環を切っている4箇所は「画面側」に書いてある。

**枚数はここに書かない。** ファイルを1枚足すたびに腐り、腐っても誰も気づかない
（実際に「15枚」「31枚」と書いてあったものが 17 と 39 になっていた）。
同じ約束と理由は `public/CLAUDE.md` の頭にもある。

`assets/favicon.png` はアイコンの元絵。1.3MB あるので `src/` には置かない。

### `launcher/`（C#）

窓を出すのと更新を当てるのだけが仕事。
**`src/` の下に置かない。** 上の表は Node のモジュールを前提にしていて、
そこへ C# を混ぜると層の向きの話が通じなくなる。

中身は `launcher/CLAUDE.md` にある。

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
      → parse/meta.mjs:extractMeta ＋ parse/state.mjs:deriveState
        （meta が先。permissionMode を state へ渡すので順を入れ替えない）
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
## 詳細はどこにあるか

このファイルは**地図と横断の約束だけ**を持つ。
領域ごとの設計と実測は、その領域のフォルダに置いた `CLAUDE.md` にある。
**そのフォルダのファイルを開いた時点で自動的に読み込まれる**ので、探して読む必要はない。
逆に言うと、**触っていない領域のぶんは読み込まれない。** 横断で効く約束をそちらへ移さない。

| 触る場所 | 読まれるもの | 中身 |
|---|---|---|
| `src/read/` | `src/read/CLAUDE.md` | 読み取り元・キャッシュの印・生死の判定 |
| `src/parse/` | `src/parse/CLAUDE.md` | 状態判定（心臓部）・数値（トークンの集計） |
| `src/view/` | `src/view/CLAUDE.md` | 応答の組み方・要約を AI に差し替えるとき |
| `src/notify/` | `src/notify/CLAUDE.md` | 通知（回答待ちを Slack へ） |
| `src/run/` | `src/run/CLAUDE.md` | 実行（画面からセッションを起こす）・CLI の実測 |
| `src/update/` | `src/update/CLAUDE.md` | 更新の紙を読む側（Node） |
| `launcher/` | `launcher/CLAUDE.md` | ランチャ・更新の当て方・自動起動 |
| `public/` | `public/CLAUDE.md` | 画面側の層・CSS・Markdown を描く |
| `test/` | `test/CLAUDE.md` | どのファイルが何を見ているか |

`server.mjs` はルート直下なので、その節（次）はここに置いてある。

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
| `GET /api/archive` | 書庫（終了したものも含む一覧）。`page` `per` `sort` `q` `deep` `project` `skill` `days`。置き場所とスキルの候補は `meta` に載る |
| `GET /api/stream` | SSE。`sessions` / `tick` / `error` イベント |
| `GET /api/runs` | 画面から起こしたぶんの台帳。まだ会話ログが無い時期でも、ここには最初から出ている。枠の使用率（`rate`）は行ではなく**封筒に1つ**（アカウント共通の値なので） |
| `GET /api/runs/options` | 起こすフォームの選択肢。cwd の候補・権限モード・**モデルの候補**・思考量・予算の範囲・CLI の様子・いまの本数 |
| `GET /api/runs/events?from=<seq>` | 取りこぼしの穴埋め。SSE が切れているあいだの速報を拾う |
| `GET /api/runs/stream?from=<seq>` | **実行専用の SSE。**`/api/stream` には相乗りさせない |
| `GET /api/runs/:id` | 1本ぶんの全部入り。粗い `rows()` と違って `counts` や `lastLineAt` も入る |
| `GET /api/health` | 生存確認。二重起動の判定にも使う。版・通知の設定と数え・**自動起動の様子**・**claude CLI を掴めたか**・**抱えている実行の数**・**どう立ったか（`startedBy`）**・**スキルの索引ができているか**もここに出る |
| `GET /api/settings/notify` | 通知の設定。URL はマスク済み。出どころ（`sources` / `envSet`）も返す |
| `GET /api/settings/rundirs` | 起こしてよいフォルダ。**登録ぶんと環境変数ぶんだけ**（セッション由来のものは消せないので出さない） |
| `GET /api/update` | 更新の状態。ランチャが書いた紙 ＋ `canApply`（いまの起動のされ方で当てられるか） |
| `POST /api/focus?pid=N` | ターミナルの窓を前面に出す |
| `POST /api/runs` | セッションを1本起こす。202 を返し、以降は速報で追う |
| `POST /api/runs/:id/input` | 走っている（または待っている）ものへ1行送る |
| `POST /api/runs/:id/answer` | 許可要求に答える。許可・拒否と、続けて撃つ権限モードと、選択式の質問へ選んだ札（`choices`）。**質問用の窓口を分けない**（実体は同じ `can_use_tool` の1本の道） |
| `POST /api/runs/:id/stop` | 止める。3段階。もう終わっているものへの連打は 200 |
| `POST /api/runs/:id/interrupt` | いま走っている手を止める（CLI の Esc 相当）。**会話は生きたまま**。202。`cancelQueued` で積んである指示も落とせる |
| `POST /api/runs/:id/mode` | **子を殺さずに**権限モード・モデルを替える。202（受理はまだ分からない）。指示文は要らない |
| `POST /api/runs/:id/switch` | モデル・思考量・権限モードを替えて `--resume` で続ける。202 |
| `POST /api/settings/notify` | 保存して即反映。応答は GET と同じ形 |
| `POST /api/settings/rundirs` | 起こしてよいフォルダを1つ足す（`add`）・消す（`remove`）。応答は GET と同じ形 |
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

`POST /api/runs/:id/answer` はその中間で `ANSWER_BODY_MAX`（64KB）。
来るのは選んだ札だけだが、質問の「その他（自分で書く）」は1問 2000 文字まで受けるので、
8件ぶんが日本語なら 48KB になる。8KB のままだと断りが「HTTP 400」としか出ない。

`POST /api/runs/:id/mode` は**既定の 8KB のまま**。
来るのは語が2つだけで、**指示文を要求しないことがこの窓口の値打ち**なので、
ここで長い本文を受ける口を開けると `/switch` との住み分けが崩れる。

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

**ただし必ず譲るわけではない。** 相手が手で立てた `server.mjs`（`npm start`）で、
こちらがランチャ経由なら、譲らずに番号をずらす。
譲ると窓がそちらを映し、`CLAUDE_DECK_LAUNCHER` が無いぶん `canApply` が false になって
「入れた版を起動したのに更新ボタンが押せない」になる（実測）。
判断は `shared/portclaim.mjs` の1箇所に置き、**ずらす先はそちらで決めない**
（`listen` の +1 を12回に任せる。決め方を2箇所に置くと片方だけ直った日に食い違う）。
相手を止める道は選んでいない。何日も動いているものを黙って落とすほうが行儀が悪い。

立ち上がりの処理（`server.once('listening')`）は **`listen()` の外に1つだけ置く。**
`server.listen(port, host, cb)` の cb は listening の一度きりの受け手として積まれるが、
発火しなかったぶんは外れずに残る。中に置くと、ずらすたびに増えて最後にまとめて降ってくる
（実測で監視とフラッシュのタイマが2セット立ち、コンソールに古い番号の URL が出た）。
## 触るときに壊してはいけないこと

このプロジェクトは制約のほうが設計を決めている。以下は理由つきで守る。
**ここに並べるのは領域をまたいで効くものだけ。** 領域ごとの約束はそれぞれの `CLAUDE.md` にある。

- **`~/.claude` 配下へ書き込まない。** 読み取り専用が前提。書き込み先は `%LOCALAPPDATA%\ClaudeDeck\`。場所の決め方は `src/shared/appdata.mjs` の1箇所に寄せてある（2箇所に書くと必ず片方が古くなり、設定したのに読まれない事故になる）
- **listen は `127.0.0.1` 固定。** 会話ログに業務内容が入るため、社内ネットから見えてはいけない
- **`GET` と `HEAD` 以外はすべて `isTrustedWrite()` を通す。** `127.0.0.1` は守りではない。ブラウザで開いた任意のページが `<form method="post">` で届く。通す口を増やすときは `handleWrite` の中に足す（門番の外側に窓口を作らない）
- **依存パッケージを増やさない。** 同僚にフォルダごと渡して動くことが要件。`dependencies` は空のまま
- **未知の形で落ちない。** 読んでいるのは Claude Code の内部データで公開仕様ではない。未知のキー・未知の `status`・書き込み途中の壊れた JSON が来ても、黙って飛ばして進む
- **`async` の窓口を `.catch()` 無しで呼ばない。** 拾われなかった拒否は Node 18 以降でプロセスを殺す。実測で `GET /%ZZ` の1発が `serveStatic` の `decodeURIComponent` からサーバーを落としていた。GET は門番を通らないので、他所のページの `<img src>` だけで撃てる（詳しくは「落ちない口の作り方」）
- **`ClaudeDeck/` を `.gitignore` から外さない。** リポジトリは public。`appdata.mjs` は `LOCALAPPDATA` も `XDG_STATE_HOME` も `HOME` も無いときアプリ直下へ倒れるので、そこに落ちる `config.json`（**生の Webhook URL 入り**）が `git add -A` で公開リポジトリに乗る
- **`innerHTML` を使わない。** ログ本文をそのまま画面に出すので、必ず `textContent` で入れる
- **`.ps1` は UTF-8 BOM 付きで保存する。** 旧 `powershell.exe` (5.1) は BOM が無いと OS の既定コードページで読み、日本語コメントが化けて構文解析まで壊れる。`pwsh` (7) は通るので気づきにくい（`test/contract.test.mjs` が見ている）
- **改行は `.gitattributes` が決める。** 既定は LF、`.cmd` と `.ps1` だけ CRLF。手元の `core.autocrlf` に関わらずこちらが勝つので、設定を揃えてもらう必要は無い。BOM は git が触らないので、改行を変換しても残る
- **`ClaudeDeck.cmd` は ASCII のみ。** `cmd.exe` は解析時のコンソールコードページで読むため、日本語を置くと shift-jis 環境で壊れる。日本語のメッセージは node 側から出す（`test/contract.test.mjs` が見ている）
- **0 と「不明」を分ける。** 取れなかったものを 0 と書かない。キャッシュの目印にも同じで、`logSize` が `0` なら「不明」として必ず取り直す（スキルの索引の `isFresh` も同じ扱い）

### 名前を変えられないもの（凍結）

上の一覧が「作りの約束」なのに対し、こちらは**名前そのもの**の話。
**破っても何のエラーも出ない。** 黙って更新が止まるか、設定が消える。

固定しているのは `test/contract.test.mjs`。**壊した理由と直し方はそこのコメントにある。**

| 何 | 破ったときに起きること |
|---|---|
| `GET /api/health` の `ok` `version` `configDir` `clients` `startedBy` | ランチャが「動いていない」と判断して二重起動を試み、10秒で諦める |
| `POST /api/quit` | 更新の前にサーバーを止められず、`node.exe` がファイルを掴んだまま差し替えが転ぶ。**画面からは一度も叩かれない外部専用の窓口** |
| `--no-open` `--port-file` `--restarted` `--wait-pid` `--apply-update` `--background` | **旧版のランチャが新版を `--restarted` で起こす。** 新版が受けなくなると更新の直後にサーバーが立たない |
| `CLAUDE_DECK_LAUNCHER` / `CLAUDE_DECK_PORT` | 更新ボタンが永久に押せない／開いたままの窓が復帰しない |
| `manual` / `launcher` の語 | 相乗りの判断が黙って無効化（実測で踏んだ。原因を掴むのに `netstat` からプロセスの親まで辿った） |
| 既定のポート **4317**（`server.mjs` / `ServerProcess.cs` / `autostart.ps1` の3箇所） | ランチャが古い番号を探して「動いていない」と判断し、二重に立てようとして10秒で諦める。旧方式の自動起動は違う番号を案内する |
| 紙に書く**状態の語**（更新9つ・自動起動4つ＋旧方式4つ） | C# が書いて Node がラベルを引く。改名すると画面が「状態が分かりません」になるだけで、どこにもエラーが出ない |
| `%LOCALAPPDATA%\ClaudeDeck\` の紙6つの**ファイル名** | 旧ファイルが**永久に残る**。消すコードを誰も持っていない |
| `config.json` の既存キー名 | **移行コードが1行も無い。** Slack の Webhook と「起こしてよいフォルダ」が黙って消える |
| `update.json` の `requested` / `prevPort` | 更新のあとの版の照合と、窓の復帰が死ぬ |
| `$PACK_ID` / `$REPO_URL` / `$MAIN_EXE`（`scripts/release.ps1`） | **いま使っている人の手元で、更新が二度と当たらなくなる** |

**足すのは安全。** `config.json` は未知のキーを保持する（`mergeSettings` / `mergeRunDirs`）し、
`update.json` と `startup.json` は知らない状態語を通してラベルだけ落とす。

**`src/` と `public/` の中は自由に動かしてよい。**
更新は `current\` フォルダを丸ごと差し替えるので、消したファイルは新しい版に残らない。
ただし `scripts/release.ps1` の `$APP_INCLUDE` は**トップレベルの名前だけ**の許可リストなので、
中の改名はそこに現れない。実行時にしか壊れない相対パス3本
（`os/focus.mjs` → `scripts/focus.ps1`、`shared/appinfo.mjs` → `package.json`、`server.mjs` → `public`）だけは手で確かめる。

## コードの書き方

- ESM（`"type": "module"`）。拡張子は `.mjs`
- インデントはスペース2つ、シングルクォート、セミコロンあり
- **コメントと UI 文言は日本語。** 「なぜそうしたか」を書く。実測で分かった Claude Code のデータ形式は、その場のコメントに残す（公開仕様が無いため、それが唯一の記録になる）
- 関数には JSDoc を付ける。引数の意味が自明でないものは `@param` を書く

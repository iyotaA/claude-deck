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

見ているのは解析側の4つ。

| ファイル | 対象 |
|---|---|
| `state.test.mjs` | `deriveState` の分岐すべて（このアプリの心臓部） |
| `entries.test.mjs` | ログ1行から中身を取り出す小道具 |
| `digest.test.mjs` | 詳細の時系列。回答の抽出と間引き |
| `meta.test.mjs` | ログから拾う情報（`ai-title` などの実測した形） |

テストデータは `test/helpers.mjs` で組む。
実物の `~/.claude` は読まない。環境によって中身が変わり、前提にできないため。

読み取り層（`read/`）と画面側にはテストが無い。
そこは実物で確かめる。

- ロジック側 … `node cli.mjs` を叩いて一覧が崩れないか見る
- 画面側 … サーバーを起動してブラウザで見る
- 見た目をヘッドレスで撮るときは `?nolive=1` を付ける（SSE がつながったままだとロード完了を待ち続ける）
- 「ターミナルを前面に」は実際に押す（`focus.ps1` へのパスはテストで拾えない）

`/api/health` が `{ok:true}` を返すかどうかが、生きているかの最短の確認。

## ファイルの置き場所

`src/` は役割ごとに4つに分けてある。
import は上から下へ一方向にだけ流れる。逆向きに import したくなったら、置き場所が間違っている。

| 場所 | 役割 | 中身 |
|---|---|---|
| `src/read/` | `~/.claude` を読む | `paths` `cache` `registry` `transcript` `tasks` |
| `src/parse/` | ログを解釈する | `entries` `meta` `state` `digest` |
| `src/view/` | API 応答を組む | `sessions`（一覧） `detail` `summary` `shape` `archive`（書庫） `entry`（原文） |
| `src/shared/` | どの層からも使う小道具 | `text`（`oneLine` / `clip`） `tools`（`describeTool`） |
| `src/os/` | OS を叩く | `focus` |

流れは `read` → `parse` → `view`。
`shared` はどこからでも使えるが、逆に `shared` から他を import してはいけない。

入口は3つだけ。ここの名前と応答の形は変えない。

- `view/sessions.mjs:listSessions`
- `view/detail.mjs:getSessionDetail`
- `os/focus.mjs:focusTerminal`

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

## サーバー

`server.mjs`。`node:http` だけで静的配信・JSON API・SSE をやる。

| エンドポイント | 用途 |
|---|---|
| `GET /api/sessions` | 一覧を1回返す |
| `GET /api/sessions/:id` | 詳細（ログ全文を読む） |
| `GET /api/sessions/:id/entry/:uuid` | ログの1行を原文で返す。鍵らしい値は伏せ、長さと深さで切る。ファイルパスは返さない |
| `GET /api/archive` | 書庫（終了したものも含む一覧）。`page` `per` `sort` `q` `deep` `project` `days` |
| `GET /api/stream` | SSE。`sessions` / `tick` / `error` イベント |
| `GET /api/health` | 生存確認。二重起動の判定にも使う |
| `POST /api/focus?pid=N` | ターミナルの窓を前面に出す |

更新の押し出しは差分判定つき。`idleMs` と `lastActivityAt` は毎回変わるので比較対象から外す。
入れてしまうと内容が同じでも毎秒 push することになる。

監視は `fs.watch` と2秒ポーリングの二重。watch が効かない環境でもポーリングで動く。

同じポートで既に動いていたら、`/api/health` を叩いて相手が ClaudeDeck か確かめる。
そうならブラウザを開くだけにして終わる（自動起動と手動起動がぶつかる場面のため）。

## 画面側

`public/app.js` はバニラ JS の1ファイル。フレームワークもビルドも無い。

- SSE でつなぎ、`apply()` が一覧・まとめを描き直す。詳細は `renderDetailIfNeeded()` を通し、`detailKeyOf()` の値が動いたときだけ作り直す（毎回作り直すと開いた `<details>` と入力中の caret が消える）
- 時系列だけは `renderTimeline()` が `.tl-host` を差し替える。絞り込みの帯は器の外に置く（中に入れると1文字ごとに入力欄が作り直される）
- 詳細は `detailCache`（`logSize` を印にした8件のキャッシュ）。中身が変わっていなければ取り直さない。印が `0`（不明）なら必ず取り直す
- 取り直しのあいだは `silent` で前の内容を出したままにする
- 狭い画面（860px 以下）では一覧が引き出しになる。閉じているあいだは `inert` で丸ごと触れなくする
- URL クエリで開き方を指定できる … `?session=<id>` `?theme=dark|light` `?only=1` `?nolive=1` `?tab=archive` `?aq=` `?asort=` `?tq=` `?hide=`
- `?hide=` は「キーが無い」と「空で付いている」を分けて見る。空は「何も隠さない」の指定なので既定に戻さない
- 描画にかかった時間は `window.deckPerf()` で見る（目安は `renderDetail` が 50ms 未満、`renderTimeline` が 16ms 未満）

状態ラベルの日本語は画面側に持たない。
`/api/sessions` の `meta.stateLabels`（`STATE_LABELS` そのまま）から引く。
状態を1つ増やすときに直すのは `parse/state.mjs` だけで済む。

`public/style.css` はライト／ダーク両対応。
色の値は `--l-*`（明）と `--d-*`（暗）に1回だけ書き、`--bg` などの意味トークンがそこを指す。
画面側は意味トークンだけを使う。

`@media (prefers-color-scheme: dark)` の側には `:not([data-theme="light"])` を付ける。
閲覧側の切り替えが両方向で勝つことを、順序や詳細度に頼らず示すため。
これがあるので `[data-theme="light"]` のブロックは要らない。

## 触るときに壊してはいけないこと

このプロジェクトは制約のほうが設計を決めている。以下は理由つきで守る。

- **`~/.claude` 配下へ書き込まない。** 読み取り専用が前提。ログの出力先は `%LOCALAPPDATA%\ClaudeDeck\`
- **listen は `127.0.0.1` 固定。** 会話ログに業務内容が入るため、社内ネットから見えてはいけない
- **依存パッケージを増やさない。** 同僚にフォルダごと渡して動くことが要件。`dependencies` は空のまま
- **未知の形で落ちない。** 読んでいるのは Claude Code の内部データで公開仕様ではない。未知のキー・未知の `status`・書き込み途中の壊れた JSON が来ても、黙って飛ばして進む
- **`innerHTML` を使わない。** ログ本文をそのまま画面に出すので、必ず `textContent` で入れる
- **生死の判定は PID の存在確認だけ。** 登録簿の `updatedAt` は状態が変わったときしか書かれない。古さで終了扱いにすると稼働中のセッションが一覧から消える
- **`slugifyCwd` の結果からパスを復元しない。** 英数字以外がすべて `-` になる不可逆変換。cwd は登録簿とログの各行から直接取る
- **`.ps1` は UTF-8 BOM 付きで保存する。** 旧 `powershell.exe` (5.1) は BOM が無いと OS の既定コードページで読み、日本語コメントが化けて構文解析まで壊れる。`pwsh` (7) は通るので気づきにくい
- **`ClaudeDeck.cmd` は ASCII のみ。** `cmd.exe` は解析時のコンソールコードページで読むため、日本語を置くと shift-jis 環境で壊れる。日本語のメッセージは node 側から出す
- **状態色は点と細いバーだけに使い、面は塗らない。** 全面を塗ると全部が同じ重さに見えて、どれから手をつけるか分からなくなる。色は必ず CSS 変数経由で取る

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

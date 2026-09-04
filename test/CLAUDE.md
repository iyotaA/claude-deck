# テスト

> `test/` を触るとき、テストを足すときに読む。
> 全体の地図と横断の約束はルートの `CLAUDE.md` にある。

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
| `state.test.mjs` | `deriveState` の分岐すべて（このアプリの心臓部）。権限モードでの抑制・ツール別しきい値・`ball` と `blocking` が別の問いに答えていること |
| `entries.test.mjs` | ログ1行から中身を取り出す小道具 |
| `digest.test.mjs` | 詳細の時系列。回答の抽出と間引き。最後の発言だけ切る幅が広いこと（待ちブロックが出すのがそこなので） |
| `meta.test.mjs` | ログから拾う情報（`ai-title` などの実測した形） |
| `summary.test.mjs` | 見出しの出どころ。古い自己申告を見出しに使わないこと |
| `archive.test.mjs` | 書庫のクエリの丸め方 |
| `skills.test.mjs` | スキルの索引のうち**判断だけ**（壊れた索引を読んでも落ちない・印が同じなら読み直さない） |
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
| `portclaim.test.mjs` | ポートの取り合いの決め方。ランチャ経由が手で立てたものに譲らないこと。相手の経路が不明なら譲ること |
| `origin.test.mjs` | 書き込み口の門番。どのヘッダの組み合わせを断るか |
| `notify-watch.test.mjs` | いつ何を送るかの状態機械（通知の本丸） |
| `notify-message.test.mjs` | 通知の本文。載せないものと、URL のマスク |
| `notify-config.test.mjs` | 設定の優先順と URL の検証 |
| `notify-settings.test.mjs` | 画面から来た設定の検証と併合。書き込む側の本丸 |
| `notify-slack.test.mjs` | Slack の応答をどう読むか |
| `notify-index.test.mjs` | 通知の配線。とくに失敗したときのふるまい |
| `update-state.test.mjs` | 更新の紙の読み方。stale の判定と、無い紙を異常にしないこと |
| `startup-state.test.mjs` | 自動起動の紙の読み方。紙が無いことを「動いていない」と読まないこと |
| `md.test.mjs` | Markdown のパーサ。記法を読めることと、途中で切れた入力で壊れないこと。頭出しが中途半端な単位で終わらないこと。チェックリストの印を、印でないもの（`- [2] …`）と分けること |
| `runs.test.mjs` | 上のバーに出す枠の使用率の判断（`rateView`）。0 と不明の分け方・`resetsAt` を過ぎた枠を落とすこと・`resetsAt` を**秒**として読むこと |
| `run-dirs.test.mjs` | 起こしてよいフォルダの登録。ドライブ直下・相対パス・`-` 始まりを断ること、大小違いの重複、登録済みの配下、上限、紙の知らないキーを残すこと |
| `run-rate.test.mjs` | 枠の使用率の紙。壊れた紙・前の版が書いた紙で落ちないことと、`at`（測った時刻）の無いものを通さないこと |

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

例外は2枚。`public/js/md.js`（Markdown のパーサ）と `public/js/runs.js` の `rateView()`。
どちらも DOM を1つも触らない純関数なので、`.js` のまま Node から import できる
（`package.json` が `type:module`）。`runs.js` は `EventSource` を関数の中でしか呼ばないので、
読み込むだけなら何も起きない。
**画面側のファイルでも、判断だけを切り出せばテストに乗る**という前例にしてある。

- ロジック側 … `node cli.mjs` を叩いて一覧が崩れないか見る
- 画面側 … サーバーを起動してブラウザで見る
- 見た目をヘッドレスで撮るときは `?nolive=1` を付ける（SSE がつながったままだとロード完了を待ち続ける）
- 「ターミナルを前面に」は実際に押す（`focus.ps1` へのパスはテストで拾えない）

`/api/health` が `{ok:true}` を返すかどうかが、生きているかの最短の確認。


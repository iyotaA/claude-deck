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
| `run-ledger.test.mjs` | 台帳の状態機械。全分岐と、`rows()` に毎秒動く値が載らないこと。**`run/ask.mjs`（要求カード）と `run/merge.mjs`（一覧への合流）もここが見ている**（下の節） |
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
| `update-banner.test.mjs` | 更新の帯の組み立て（`bannerOf`）。枝の順・鍵（`key`）の粒度・押したときに走らせる仕事の配線。**押せる知らせと押せない知らせで鍵を分けること**が本丸 |
| `md.test.mjs` | Markdown のパーサ。記法を読めることと、途中で切れた入力で壊れないこと。頭出しが中途半端な単位で終わらないこと。チェックリストの印を、印でないもの（`- [2] …`）と分けること |
| `runs.test.mjs` | 上のバーに出す枠の使用率の判断（`rateView`）。0 と不明の分け方・`resetsAt` を過ぎた枠を落とすこと・`resetsAt` を**秒**として読むこと |
| `run-dirs.test.mjs` | 起こしてよいフォルダの登録。ドライブ直下・相対パス・`-` 始まりを断ること、大小違いの重複、登録済みの配下、上限、紙の知らないキーを残すこと |
| `run-rate.test.mjs` | 枠の使用率の紙。壊れた紙・前の版が書いた紙で落ちないことと、`at`（測った時刻）の無いものを通さないこと |
| `docs.test.mjs` | **地図が実物と食い違っていないか。** `CLAUDE.md` 群の表に載っていないファイルがあると落ちる。CSS は `index.html` の `<link>` との並びまで見る |
| `contract.test.mjs` | **C#・PowerShell と Node のあいだの約束**（`/api/health` のフィールド・argv の旗・環境変数・紙の名前とキー・パック名・**既定のポート**・**紙に書く状態の語**・**文字コードの約束**）。ここだけ**ソースの字を直に読む**。理由は次の節 |

## 1枚だけソースの字を読んでいる（`contract.test.mjs`）

ほかは全部 import して関数を呼ぶが、ここだけファイルを開いて字を探す。

見ているのが **C# と Node にまたがる約束**だからで、別言語なので定数を共有できない。
import で確かめられるのは Node 側の半分だけになり、それでは
「両方を同時に直したか」が見えない。**見たいのは片側だけ直った状態**なので、両側を開く。

**素の `includes` で書くと空振りする。** 最初そう書いて、`startedBy` を
`startedByX` に変えてもテストが通った（前方が一致するため）。
このリポジトリは説明が厚いので、実装から消した語がコメントに残って拾われる問題もある。
だから `code()` でコメントを落とし、`has()` で語の切れ目まで見る形にしてある。

**この形は行の移動に弱い。** 落ちたときは「壊した」ではなく「両側を見比べろ」の合図。
消してよいのは、その約束そのものを無くしたときだけ。

`digest.test.mjs` が呼ぶのは `buildDigest` だけ。
`parse/digest/` の4枚はその中から呼ばれるので、入口経由で見ていることになる。
分けたときにテストを1行も直さずに通ったのはこのため。
ここを分け直すときも、入口の名前と応答の形を変えなければテストは無変更で通る。

`run-ledger.test.mjs` も同じ形。`run/ask.mjs` と `run/merge.mjs` を切り出したとき、
**直したのは import の3行だけ**で、テストの中身は1行も動いていない。
カードの中身は台帳の入口（`feed` → `rows`）を通して見えるので、あちらを直に呼ぶ必要が無い。

例外は `buildQuestionInput` と `ASK_BODY_MAX` の2つで、これは直に呼ぶので
`ask.mjs` から import している。テストを別ファイルへ割らなかったのは、
質問の材料（`Q2`）を台帳経由のテストとも共有していて、
割ると定数が2箇所になるか `helpers.mjs` へ動くことになるため。

テストデータは `test/helpers.mjs` で組む。
実物の `~/.claude` は読まない。環境によって中身が変わり、前提にできないため。

ディスクを触る側（`listSubagents` / `readPlanFile` / `readHead` / `listArchive`）にはテストが無い。
`configDir` が import 時に一度だけ評価される定数なので、差し替えるには import 順の細工が要る。
代わりに**判断（純関数）と I/O（薄い殻）を分ける形**にして、判断だけをテストできるようにしてある。
`read/` 側に残っているのは「readdir して、名前で絞って、stat して、try/catch で飲む」だけ。

読み取り層（`read/`）と画面側にはテストが無い。
そこは実物で確かめる。

例外は3枚。`public/js/md.js`（Markdown のパーサ）、`public/js/runs.js` の `rateView()`、
`public/js/update-banner.js`（更新の帯の組み立て）。
どれも DOM を1つも触らない純関数なので、`.js` のまま Node から import できる
（`package.json` が `type:module`）。`runs.js` は `EventSource` を関数の中でしか呼ばないので、
読み込むだけなら何も起きない。`update-banner.js` は import そのものがゼロ。
**画面側のファイルでも、判断だけを切り出せばテストに乗る**という前例にしてある。

更新の帯は**この3枚の中でいちばんテストの値打ちが大きい。**
出るのは更新の道中だけで、紙（`update.json`）を書くのは C# のランチャなので、
手で出そうとすると本物の更新を走らせるか紙を偽装するしかない
（実地で確かめるには `%LOCALAPPDATA%` を差し替えて `update.json` を置く。やり方は次の節）。

- ロジック側 … `node cli.mjs` を叩いて一覧が崩れないか見る
- 画面側 … サーバーを起動してブラウザで見る
- 見た目をヘッドレスで撮るときは `?nolive=1` を付ける（SSE がつながったままだとロード完了を待ち続ける）
- 「ターミナルを前面に」は実際に押す（`focus.ps1` へのパスはテストで拾えない）

### 更新の帯を画面で出す

帯は更新の道中しか出ないので、素では見られない。
**`%LOCALAPPDATA%` を差し替えて紙を置く。** 実物の `%LOCALAPPDATA%\ClaudeDeck\` は触らない
（あそこは更新でもアンインストールでも掃除されないので、テストのゴミを置くと永久に残る）。

```
mkdir <作業場>\ClaudeDeck
# <作業場>\ClaudeDeck\update.json に置く紙。current はいまの版と一致させる
#   {"state":"available","current":"0.9.1","available":"0.9.2","checkedAt":…,"changedAt":…}
set LOCALAPPDATA=<作業場>
set CLAUDE_DECK_LAUNCHER=C:\dummy\ClaudeDeck.exe
set CLAUDE_DECK_PORT=4401
node server.mjs --no-open
```

`CLAUDE_DECK_LAUNCHER` の有無が `canApply` を決める（`server.mjs` の `launcherPath`。
中身は見ないので、在りもしないパスでよい）。
**押せる帯と押せない帯は別のサーバーでしか出せない**ので、両方見るなら2本立てる。
`state` を `done` / `applying` / `failed`（＋ `requested`）に書き換えて読み込み直せば、
それぞれの帯に切り替わる。`/api/update` は毎回紙を読み直すので、サーバーは立て直さなくてよい。

紙が効いているかは `/api/update` の応答の `path` で確かめる。差し替えに失敗していると
実物の `%LOCALAPPDATA%` を指すので、そこを見れば取り違えに気づける。


`/api/health` が `{ok:true}` を返すかどうかが、生きているかの最短の確認。


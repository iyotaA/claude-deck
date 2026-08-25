# API 応答を組む側

> `src/view/` を触るときに読む。
> 全体の地図と横断の約束はルートの `CLAUDE.md` にある。

`read` が読んだものを `parse` が解釈し、ここが API 応答の形に組む。
入口の名前と応答の形は変えない（一覧は `listSessions`、詳細は `getSessionDetail`）。

一覧と詳細で同じ項目（`name` や `project` など）は `view/shape.mjs` が組む。
以前は両方が別々に組んでいて、片方だけにフォールバックが付いている状態になっていた。

`summarizeRows()` の `needsYou` は `row.blocking === true` だけを数える。
**`ball === 'master'` で数えない**（返信待ちが混ざって、上のバーの数が
「いま手を止めている件数」ではなくなる）。判断は `parse/state.mjs` の `isBlocking` が持ち、
ここは配るだけ。`=== true` で見るのは、台帳側（`run/ledger.mjs`）が項目を足し忘れた将来でも
`undefined` を「数えない」に倒して落ちないため。唯一の消費者は上のバーと `cli.mjs`。

**数値（`view/usage.mjs`）の設計は `src/parse/CLAUDE.md` にある。**
集計そのものは `parse/usage.mjs` にあり、両方を1枚にまとめてあるため。

**`view/` は `run/` を import しない。`run/` からも `view/` を import しない。**
起こしたセッションを一覧へ混ぜるのは `server.mjs` の `refresh()` の仕事で、
そこが合成の場所と決めてある。詳細は `src/run/CLAUDE.md`。

`src/view/summary.mjs` の `summarize()` が唯一の差し替え点。`detail.mjs` は結果の形しか見ていない。

差し替えるときは以下を守る（理由はファイル冒頭のコメントに詳しく書いてある）。

- 既定では通信しない。鍵が無ければ黙って素の要約に戻す
- ログ本文を外へ送る処理になるため、使うかどうかは利用者が環境変数などで明示的に選ぶ形にする
- 失敗しても詳細ビュー全体を落とさない
- 素の要約（`plainSummary`）を捨てない。AI 側が落ちたときの表示になる


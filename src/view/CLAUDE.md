# API 応答を組む側

> `src/view/` を触るときに読む。
> 全体の地図と横断の約束はルートの `CLAUDE.md` にある。

`read` が読んだものを `parse` が解釈し、ここが API 応答の形に組む。
入口の名前と応答の形は変えない（一覧は `listSessions`、詳細は `getSessionDetail`）。

一覧と詳細で同じ項目（`name` や `project` など）は `view/shape.mjs` が組む。
以前は両方が別々に組んでいて、片方だけにフォールバックが付いている状態になっていた。

**`permissionMode` を `deriveState` へ渡すのは、呼ぶ側（ここ）の仕事。**
`state.mjs` から `meta.mjs` を import すると `parse` の中に新しい辺ができるので、
`sessions.mjs` と `detail.mjs` が `extractMeta` の結果から1項目だけ抜いて渡す。
**`extractMeta` → `deriveState` の順を崩さない**（もう meta を組んでいるので追加の走査は0）。
**`meta` ごと渡さない**（理由は `src/parse/CLAUDE.md`）。

一覧は末尾64KB、詳細は全文を読むので、`permissionMode` の見え方は食い違いうる
（モードを途中で替えたセッションで、一覧が新しい値・詳細が最初の値を見る）。
画面では `public/js/rows.js` の `LIVE_FIELDS` が一覧の状態を正にしているので、
食い違っても左のカードと右のヘッダは揃う。

`summarizeRows()` の `needsYou` は `row.blocking === true` だけを数える。
**`ball === 'master'` で数えない**（返信待ちが混ざって、上のバーの数が
「いま手を止めている件数」ではなくなる）。判断は `parse/state.mjs` の `isBlocking` が持ち、
ここは配るだけ。`=== true` で見るのは、台帳側（`run/ledger.mjs`）が項目を足し忘れた将来でも
`undefined` を「数えない」に倒して落ちないため。唯一の消費者は上のバーと `cli.mjs`。

**数値（`view/usage.mjs`）の設計は `src/parse/CLAUDE.md` にある。**
集計そのものは `parse/usage.mjs` にあり、両方を1枚にまとめてあるため。

クエリの読み取り（`intOf` / `textOf` / `getter` と、長さと期間の上限）は `view/query.mjs`。
`archive.mjs` と `usage.mjs` が**バイト単位で同じものを持っていた**ので寄せてある。
窓口を足すときもここから取る。**素の `Number()` で読まない**（`NaN` がそのまま下流へ流れる）。

書庫の置き場所の候補（`meta.projects`）は `buildProjects()` が作る。
**表示名は「グループごとに、いちばん新しい1本だけ末尾を読む」で取る。**
索引がタダで持っているのは `projectDir`（スラッグ）だけで、これは不可逆
（`C--…-claude-deck` の `-` は区切りかフォルダ名の一部かを区別できない）。
読むのは種類の数だけ（実測 445 本に対して 19 種）で `readTail` は memo に乗る。
候補は**絞り込む前の全行**から作る。期間で絞ったあとから作ると、
期間を変えるたびに候補が消えて選び直せなくなる。

`project` の照合は**完全一致を先に見て、当たらなければ部分一致へ落とす**。
画面は選ぶ形なので正確なスラッグが来るが、`?project=` を手で書くぶんも拾う。

**`view/` は `run/` を import しない。`run/` からも `view/` を import しない。**
起こしたセッションを一覧へ混ぜるのは `server.mjs` の `refresh()` の仕事で、
そこが合成の場所と決めてある。詳細は `src/run/CLAUDE.md`。

`src/view/summary.mjs` の `summarize()` が唯一の差し替え点。`detail.mjs` は結果の形しか見ていない。

差し替えるときは以下を守る（理由はファイル冒頭のコメントに詳しく書いてある）。

- 既定では通信しない。鍵が無ければ黙って素の要約に戻す
- ログ本文を外へ送る処理になるため、使うかどうかは利用者が環境変数などで明示的に選ぶ形にする
- 失敗しても詳細ビュー全体を落とさない
- 素の要約（`plainSummary`）を捨てない。AI 側が落ちたときの表示になる


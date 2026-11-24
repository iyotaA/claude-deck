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
| `today.test.mjs` | 今日のまとめの判断（`src/view/today.mjs`）。**その日の行だけを拾うこと**（前の日に書いたファイルと決めたことを並べない）・動いていない日を空の行にしないこと・「(Recommended)」を外すこと・切ったぶんを数で返すこと・日の窓を地方時で切ること・クエリの丸め方 |
| `today-md.test.mjs` | 今日のまとめの Markdown（`public/js/today-md.js`）。画面と同じ順で出すこと・切ったことを黙らないこと・動いただけの行を最後に名前だけ並べること・パスを作業フォルダから見た形にすること・選べる日数がサーバーと揃っていること |
| `sessions-sort.test.mjs` | 一覧の並び順（`sortRows`）。同じ状態の中では始めた順に固定し、状態が変わったときだけ動くこと。終了済みは新しい順。**行に載せる TODO の進み（`todoSummary`）** も見る（取り消しを数えない・無ければ null） |
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
| `notify-toast.test.mjs` | Windows の通知に何を出すか（`notify/toast.mjs`）。ログ由来の文字を逃がすこと・押した先がランチャの有無で分かれること（`claude-deck://open` と `baseUrl`）・「質問文を載せない」を守ること・凍結の名前（`claude-deck` / `ClaudeDeck`）。出す殻（`os/toast.mjs`）は実物で確かめる |
| `notify-index.test.mjs` | 通知の配線。とくに失敗したときのふるまい。**Windows の通知**は Slack と横に並ぶ送り先として見る（Slack 無しでも出る・Slack の本文に題名を載せない・再送で2回出さない・続けて失敗したら自分だけ止まる・入れた瞬間に一斉に鳴らさない） |
| `update-state.test.mjs` | 更新の紙の読み方。stale の判定と、無い紙を異常にしないこと |
| `startup-state.test.mjs` | 自動起動の紙の読み方。紙が無いことを「動いていない」と読まないこと |
| `update-banner.test.mjs` | 更新の帯の組み立て（`bannerOf`）。枝の順・鍵（`key`）の粒度・押したときに走らせる仕事の配線。**押せる知らせと押せない知らせで鍵を分けること**が本丸 |
| `usage-trend.test.mjs` | 数値の概要の新旧の差（`halfTrend`）。**時刻で並べ替えてから割ること**（応答の rows は重い順で来る）・奇数のとき真ん中を外して本数を揃えること・1要求あたりを半分ごとの合計で割ること・0 と不明を混ぜないこと |
| `screen.test.mjs` | 画面側の、**ブラウザで開くまで気づけないのに字面で分かること**。import した名前が相手側で export されているか・CSS が参照するトークンが定義されているか・使う先の無い意味トークンが残っていないか・一覧の描く側（`list.js`）の約束（どの束にも入らない行の受け皿 `REST_GROUP` を描く／**状態の名前も束の id も列挙しない**（`STOP_STATES` を引き直さない・`=== 'done'` で分岐しない・束をその場で作らない。例外は「動いている行か」の `'running'` だけ）／一覧の鍵に時刻を混ぜず、開け閉め（`openFolds`）は混ぜる／`refreshTimes` が行の経過と「いま何をしているか」を差し替える／`.card` だけ掴んで `.row` を取りこぼしていない）。**このリポジトリに linter は無い**ので、ここが代わりになる |
| `tokens.test.mjs` | 色と字の段（`public/css/tokens.css` ほか）。明るいテーマの名残（`--l-` / `--d-` / `prefers-color-scheme` / `data-theme`）が無いこと・意味トークンが `:root` に全部在って `#RRGGBB` で書いてあること（`--accent-soft` だけ `rgb()`）・**字の色が全部の面で 4.5:1 以上**なことと `--accent-fg` が `--accent` の上で 4.5:1 以上なこと（落ちたら「どの字がどの面で何:1」まで出す）・`color-scheme: dark`・字の段が 12px 以上で小さい順なこと・`public/css/` に 12px 未満の直書きが無いこと・`index.html` と `public/js/` に配色の切り替え（`theme-toggle` / `?theme=` を読む口 / `claude-deck.theme`）が戻っていないこと。CSS は解析せず字面で読む。**崩れても画面を開くまで何のエラーも出ない**種類の約束（`contract.test.mjs` と同じ性質） |
| `md.test.mjs` | Markdown のパーサ。記法を読めることと、途中で切れた入力で壊れないこと。頭出しが中途半端な単位で終わらないこと（印を落とさないこと）。チェックリストの印を、印でないもの（`- [2] …`）と分けること。**リンクに http / https 以外を通さないこと**（`javascript:` と相対パスは表示名だけ）と、`blocksText` がリンクの URL を数えないこと |
| `runs.test.mjs` | 左のレールに出す枠の使用率の判断（`rateView` → `ringView`）。0 と不明の分け方・枠を表示の字ではなく鍵（`five` / `seven`）で持ち、丸める前の値（`value`）も持つこと・`resetsAt` を過ぎた枠を落とすこと・`resetsAt` を**秒**として読むこと・**測ってから7日より古い観測の7日の枠を落とすこと**（ちょうど7日は残す・5時間枠も無ければ null・7日以内なら古い印つきで出す）・色の段（`RATE_WARN` で黄、`RATE_HOT` で赤。境目ちょうどは上の段）と弧の長さを 0〜1 に丸めること。**輪**は、片方しか読めないときにもう片方を null にする（外＝5時間・内＝7日の位置を動かさない）・真ん中の数を `%` 無しで高いほうにする（比べるのは丸める前の値）・古い観測で `stale` を立てる・名前に両方の % と測った時刻を入れ、読めない枠を 0% と書かないこと |
| `navrail.test.mjs` | 左のレールと上のバー。`public/js/nav.js` の判断（モードの名前とキーの出どころ `MODE_LIST`・数字キーを効かせない条件（Ctrl/Meta/Alt・IME の変換中・入力欄・`<dialog>`）・止まっている数を `meta.stateBlocking` の真のキーだけで数え、meta が無ければ null・作業台の札の名前で「無い」と「まだ知らない」を分けること・件数を名前に持つ札が `counts` の1つだけで、ほかの札の名前と吹き出し（`modeName` / `modeTip`）は件数で変わらないこと）と、`index.html` / `public/js/` の字面（レールと上のバーに置く節点・レールに `title` を付けないこと・「起こす」を塗らないこと・**一覧の開閉（`#list-toggle`）が上のバーに無く、作業台（`.deck`）の中・`#list-pane` の外に居ること**・**「稼働中だけ」のチェックボックス（`#only-live`）が無く、一覧の頭（`#live-head`）に `role="group"` の「すべて｜稼働中」（ボタン2つに `aria-pressed`）があること**・**消した部品（下段の帯・版・左の細い帯・`.modes`）と口（`renderSummary`・チェックボックス前提の `dom.onlyLive` / `.checked` など）が戻っていないこと**）。字面はコメントを落としてから読む |
| `groups.test.mjs` | 一覧の束（`public/js/groups.js`）。止まっている状態は枠「あなたの番」の `stop`、返信待ちは `reply` に入ること・**ピンが付いていても枠が先**（ピン留めには枠に入らないピンの行だけ）・実行中と終了はそれぞれの見出し、知らない状態は `rest`（黙って落とさない）・**並べ替えない**（入ってきた順のまま）・入ってきた配列を書き換えない・0本なら全部空・同じ状態が2つの表に出ないこと・`STOP_STATES` が枠の `stop` と同じ顔ぶれなこと・**`STOP_STATES` が `src/parse/state.mjs` の `STATE_BLOCKING` が真の状態と同じ顔ぶれなこと**（状態を1つ足した日に、レールのバッジと一覧の枠と拡大モーダルの「次の待ち」が食い違わない）・ピン留めとそのほかの束（`PINNED_GROUP` / `REST_GROUP`）も `groups.js` が持ち、状態を名指ししないこと・開け閉め（`foldable`）は終了だけ、2行目の「何を求めているか」（`wants`）は止まっているものだけなこと。字面では、**消した上の帯（`hero-wrap` / `hero-band` / `hero.css` / `renderHero` / `heroFolded` / `HERO_STATES`）と「残り N 件を出す」（`ENDED_FIRST` / `.row-more`）が戻っていないこと**と、見出しの表（`STATE_GROUPS`）を持つのが `groups.js` だけなこと。字面はコメントを落としてから読む |
| `detail-pane.test.mjs` | 詳細ペイン（中央）の字面（画面刷新④）。**急ぎのパネル（`.panel.is-hot` / `.is-warn`）が字の色しか持たないこと**（枠・光の輪・見出しの帯に色を敷かない）と見出しの字が状態色のままなこと・止まっている待ち（`.panel.is-block`）の左の線が 3px のまま無彩色なこと・許可要求カード（`.ask`）と目的（`.purpose`）の線とメモの札（`.detail-memo .k`）に状態色もラベンダーも無いこと・メモが沈めた面（`--bg-sunk`）で枠を持たないこと。**消した待ちのパネルの案内文（`guide.lead` と4つの文）と札「Claude の最後の応答」が戻っていないこと**、表（`WAIT_GUIDE` / `ASK_GUIDE`）が `lead:` を持たないこと、中身のもの（プランの保存先・「すべて答えるまで」）が残っていること。**置き場所**では、`detail.js` の `renderDetailInner` が タブ帯 → 答えないと進まない待ち（`row.blocking === true`）→ 選んだタブの中身 の順に積むこと（タブ帯より上に何も置かない）・目的（`summaryBlock`）を `renderDetailInner` で組まず、`fillTab` の「いま」の枝の先頭（待ち・実行・続きを起こすより前）で1箇所だけ組むこと・`waitingBlock` を呼ぶのが2箇所で「いま」の中は `row.blocking !== true` のときだけなこと（両方に出さない）・`.is-block .md` の 24rem が残っていること。**頭**では、消した部品（題名の横の群 `.detail-title`・作業フォルダの全文 `.detail-sub .path`）が戻っていないこと・次の一手の判断を `detail-head.js` が持たず（`row.alive` も一手の名前も書かない）`detail.js` が `nextStep` を1箇所で呼ぶこと・パレットが `canFocusTerminal` を通すこと・右上の絵だけのボタン（☆・✎・数値・コピー）と次の一手が `data-refocus` と名前（title と aria-label）を持つこと・押した結果の一言をモジュールに控えて書き戻すこと・メモが1行で切れて全文が title に入ること・置き場所の札が枠も面も持たず、作業フォルダの全文が診断にあること。関数の本体は括弧を数えて切り出す。CSS は解析器を持たず「セレクタ { 宣言 }」を拾って読む。字面はコメントを落としてから読む |
| `next-step.test.mjs` | 詳細の頭の「次の一手」（`public/js/next-step.js`）。画面刷新④の D5 の表の全場面 ―― 返信待ち・止まっている（止まっている状態の全部）・実行中 × ターミナル、画面から起こした実行（許可待ち・あなたの番・無音・予算切れ・実行中・起動中）、終了 × 続きを起こせる／起こせない、不明と知らない語。**塗るのは1画面に1つ**（入力欄があれば頭は塗らない・塗るのは返信待ちと止まっているの2つだけ）・pid が取れない／生きていない行には出さない・終わった実行のあとにターミナルで開き直したものはターミナルとして扱うこと・`canFocusTerminal`（パレットと共有）の判断・**終わりの語がサーバーの `isRunOver` と台帳の全部の語で一致すること**・一手の名前と吹き出し（「答える」は押しても許可にならないと言う）・入ってきた行を書き換えないこと |
| `run-dirs.test.mjs` | 起こしてよいフォルダの登録。ドライブ直下・相対パス・`-` 始まりを断ること、大小違いの重複、登録済みの配下、上限、紙の知らないキーを残すこと |
| `run-rate.test.mjs` | 枠の使用率の紙。壊れた紙・前の版が書いた紙で落ちないことと、`at`（測った時刻）の無いものを通さないこと |
| `run-defaults.test.mjs` | 起こすときの既定値。壊れた紙・知らない語で落ちないこと、**`bypassPermissions` が紙からは入らないこと**（環境変数の関門を紙で迂回させない）、予算を範囲へ丸めること（「指定なし」に倒すと上限を掛けたい意図が消える）、知らないキーを残すこと |
| `marks.test.mjs` | ピン留めとメモの判断（`src/marks/`）。壊れた紙で落ちないこと・長いメモを黙って切らずに断ること・付けて外したら残骸を残さないこと・上限で黙って捨てないこと・古くても一覧に残すのはピンだけなこと・紙の名前（凍結） |
| `docs.test.mjs` | **地図が実物と食い違っていないか。** `CLAUDE.md` 群の表に載っていないファイルがあると落ちる。CSS は `index.html` の `<link>` との並びまで見る |
| `shared-text.test.mjs` | 文字列の小道具（`oneLine` / `clip` / `errText` / `projectNameOf`）。**全層から使う**のにテストが無かった。切る境目（max ちょうど）・空を null にすること・Error でないものを投げられても落ちないこと・区切りが `/` と `\` で混ざること |
| `shared-kit.test.mjs` | 残りの小道具4枚（`lru` / `env` / `objects` / `tools`）。LRU が「取ったものを最近使ったに戻す」こと（ここが芯。無いとただの FIFO）・**store を共有しないこと**・`0` を「立っていない」と読むこと・`Task*` を前置で拾わないこと・`ExitPlanMode` が `plan` を見ること |
| `grep.test.mjs` | 本文の検索の**判断だけ**。どの行から人が読む文字列を取るか（ツールの引数と結果は読まない）・当たった場所の切り出し方（前後の `…`・上限・大小の無視・空白の潰し） |
| `syntax.test.mjs` | **構文として読めるか**（`node --check`）。`server.mjs` と `cli.mjs` と `public/js/` は import しているテストが1枚も無いので、ここが無いと `}` を1つ落としても全部通る。実行はしない（`import()` だと画面側は `document` が無くて落ち、`server.mjs` は listen を始める） |
| `contract.test.mjs` | **C#・PowerShell と Node のあいだの約束**（`/api/health` のフィールド・argv の旗・環境変数・紙の名前とキー・パック名・**既定のポート**・**紙に書く状態の語**・**文字コードの約束**・**C# が紙の数を型を確かめてから読むこと**）。ここだけ**ソースの字を直に読む**。理由は次の節 |

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

例外は8枚。`public/js/md.js`（Markdown のパーサ）、`public/js/runs.js` の `rateView()` / `ringView()`、
`public/js/update-banner.js`（更新の帯の組み立て）、`public/js/usage-trend.js`（数値の新旧の差）、
`public/js/today-md.js`（今日のまとめの Markdown）、`public/js/nav.js`（左のレールの判断）、
`public/js/groups.js`（一覧のどの行をどの束へ置くか）、`public/js/next-step.js`（詳細の頭の次の一手）。
どれも DOM を1つも触らない純関数なので、`.js` のまま Node から import できる
（`package.json` が `type:module`）。`runs.js` は `EventSource` を関数の中でしか呼ばないので、
読み込むだけなら何も起きない（import しているのは `util.js` だけで、あちらも `document` を関数の中でしか触らない）。
`update-banner.js` と `nav.js` と `groups.js` と `next-step.js` は import そのものがゼロ。
**画面側のファイルでも、判断だけを切り出せばテストに乗る**という前例にしてある。

更新の帯は**ここに並べた中でいちばんテストの値打ちが大きい。**
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


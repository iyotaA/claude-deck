# 更新の紙を読む側

> `src/update/` と `src/startup/` を触るときに読む。
> **判断は C# 側（`launcher/`）にある。** ここは紙を1枚読んで画面に出せる形へ整えるだけ。
> 紙を書く側・Velopack・配布の話は `launcher/CLAUDE.md`。
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

## 触るときに壊してはいけないこと（更新の紙）

- **更新の判断を Node に持たせない。** `server.mjs` の `uncaughtException` は記録して続行するので、ここに更新の実処理を置くと失敗が「画面は元気なのに何も変わらない」に化ける。node 自身が更新の対象（`current\runtime\node.exe` ごと差し替わる）でもある。判断は C# のランチャ側、Node は紙を読むだけ
- **`POST /api/update/apply` は spawn の成否をそのまま返す。** 作業の前に `{ok:true}` を書かない。spawn するパスは `CLAUDE_DECK_LAUNCHER` から取り、**リクエスト本文からは絶対に取らない**（`POST /api/focus` が PowerShell を spawn している前例と同じ守り方）
- **再起動したあとに版を照合する。** `requested` と実際の版が違えば `failed` にする。「当てましたと言ったのに何も起きていない」を捕まえる網はここだけ
- **紙が無いことを「動いていない」と読み替えない。** `update.json` も `startup.json` も、ランチャを通していないときは誰も書かない。無いのは `idle`（正常）、壊れているのが `unknown`（異常）。読み替えると `npm start` で起こすたびに「登録されていません」と出て、実際は登録されているのに解除を勧めることになる
- **知らない状態を `unknown` へ潰さない。** 状態そのものは通したまま、言い方だけ落とす。潰すと、ランチャが先に新しい語を書くようになったとき「読めませんでした」と嘘になる
- **画面に更新の確認を止める口を作らない。** 止めるのは `CLAUDE_DECK_UPDATE_OFF=1` だけ。画面から自分を締め出せる口を作らない

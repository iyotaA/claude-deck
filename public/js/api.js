/**
 * サーバーの窓口を叩く口。層0（何も import しない）。
 *
 * 25 箇所の `fetch` が同じ定型を書き写していた。
 * `content-type` が 10 箇所、`if (!res.ok) throw` が 8 箇所、
 * `res.json().catch(() => null)` が 11 箇所、`cache: 'no-store'` が 10 箇所。
 *
 * **付け忘れがいちばん怖いのは `content-type`。** 無いと書き込み口の門番
 * （`shared/origin.mjs`）に断られる。`<form method="post">` が名乗れないヘッダを
 * 使って、他所のページからの POST を弾く仕組みなので、こちらが正しく名乗る必要がある。
 *
 * ## 畳めるのは「撃って res と data を得るまで」
 *
 * そのあとの判断は呼ぶ側に残す。窓口ごとに違うものが乗っているため:
 *
 * - `run-view.js` … 返ってくるまでに別の実行へ移っていないか（`ops.runId !== runId`）
 * - `session.js` … 404 が「セッションが無い」か「窓口ごと無い」か
 * - `archive.js` … 打ち終わる前の応答が後から届いていないか（token の照合）
 *
 * ここで面倒を見ようとすると、引数に旗が増えて何が起きるか読めなくなる。
 */

/**
 * GET して JSON を返す。**200 以外は例外にする。**
 *
 * `cache: 'no-store'` は必ず付ける。毎秒変わるものを配る窓口なので、
 * 途中の何かが握ると古い一覧が出る。
 *
 * **404 を切り分けたい場所では使わない。** 例外に潰してしまうので、
 * 「セッションが無い」と「窓口ごと無い（更新の途中で画面だけ新しい）」を分けられない。
 *
 * 素の `fetch` のまま残してあるのは7箇所。**どれも意図的**:
 *
 * | 場所 | なぜ |
 * |---|---|
 * | `session.js` の3本 | 404 の切り分け。JSON で理由が返るかどうかで「窓口ごと無い」を判定する |
 * | `archive.js` / `usage-tab.js` の一覧 | 404 なら `unavailable` を立てて節ごと畳む（画面側だけ先に入れられるようにするため） |
 * | `archive.js` のカードの数値 | `res.ok ? 読む : null`。取れなくてもカードは出したままにする |
 * | `update.js` | 404 は「サーバーが古い」の意味で、そこだけ画面側が `outdated` を組む |
 *
 * @param {string} path 窓口
 * @returns {Promise<object>} 応答の JSON
 */
export async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * POST して `{res, data}` を返す。**投げない。**
 *
 * 断りの理由は本文に日本語で入っている（`{ok:false, reason}`）。
 * 例外にすると番号しか残らないので、呼ぶ側が両方を見られる形で返す。
 *
 * `data` は読めなければ `null`。本文の無い応答（202 や、門番が弾いた 415）も来る。
 *
 * @param {string} path 窓口
 * @param {object} [body] 送る中身。省くと `{}`
 * @returns {Promise<{res: Response, data: object|null}>}
 */
export async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

/**
 * 応答から断りの理由を取る。
 *
 * **`reason` と `error` の両方を見る。** サーバーの断りは `{ok:false, reason}` に
 * 揃えたが、更新の途中では「画面は新しく、サーバーは古い」状態が実在する。
 * 古い側は `{error}` を返す。
 * **外してよいのは、古い版が手元から消えたと言い切れるようになってから。**
 *
 * @param {object|null} data 応答の JSON
 * @param {Response} [res] 番号を添えるために使う
 * @returns {string} 読めなければ HTTP の番号
 */
export function reasonOf(data, res) {
  return data?.reason ?? data?.error ?? `HTTP ${res?.status ?? '?'}`;
}

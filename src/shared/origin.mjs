/**
 * 書き込み口の門番。純関数だけを置く。
 *
 * `127.0.0.1` で listen していても、それは守りにならない。
 * 利用者が開いた任意のページが、そのブラウザから
 * `http://127.0.0.1:4317/` へ POST できるため。
 *
 * とくに `<form method="post">` は CORS の事前確認なしに飛ぶ。
 * 放置すると、悪意のあるページが Webhook を自分のものへ書き換えられる。
 * 以後の質問文がまるごとそちらへ流れるので、実害のある穴になる。
 *
 * そこで GET と HEAD 以外のすべてをここに通す。既存の `/api/focus` も含める。
 */

/** 自分自身とみなすホスト名。ここを増やさない。 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `host:port` の形が自分自身かどうかを見る。
 *
 * ポートまで見るのは DNS 再バインド対策。攻撃者の持つ名前を
 * `127.0.0.1` に向けられても、`host` にはその名前が載るので弾ける。
 *
 * @param {*} value `host` ヘッダや `origin` の権限部分
 * @param {number} port 実際に listen しているポート
 * @returns {boolean}
 */
export function isLocalAuthority(value, port) {
  if (typeof value !== 'string' || !value) return false;
  // IPv6 は [::1]:4317 の形で来るので、最後の : で切る
  const at = value.lastIndexOf(':');
  const host = at > value.lastIndexOf(']') ? value.slice(0, at) : value;
  const p = at > value.lastIndexOf(']') ? value.slice(at + 1) : '';
  if (!LOCAL_HOSTS.has(host)) return false;
  // ポートの記載が無い形（80 番）は、このアプリの窓口ではない
  return p === String(port);
}

/**
 * この書き込みを受けてよいかを決める。
 *
 * 見るのは4つ。どれか1つでも外れたら断る。
 *
 *  - `content-type` が `application/json` … form はこれを名乗れない
 *  - `origin` があるなら自分自身であること … 他所のページからの送信を弾く
 *  - `host` が自分自身であること … DNS 再バインド対策
 *  - `sec-fetch-site` があるなら `same-origin` … 対応しているブラウザでの二重の網
 *
 * `origin` と `sec-fetch-site` は「あれば見る」にしてある。
 * curl のような手元の道具からは付かないので、必須にすると診断ができなくなる。
 * その2つが無くても `content-type` と `host` は必ず見るので、
 * ブラウザ経由の攻撃はそこで止まる。
 *
 * @param {object} headers `req.headers`
 * @param {number} port 実際に listen しているポート
 * @returns {{ok: true}|{ok: false, status: number, reason: string}}
 */
export function isTrustedWrite(headers, port) {
  const h = headers ?? {};

  const type = String(h['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    return { ok: false, status: 415, reason: 'content-type は application/json だけ受け付けます' };
  }

  if (!isLocalAuthority(h.host, port)) {
    return { ok: false, status: 403, reason: 'host が一致しません' };
  }

  const origin = h.origin;
  if (typeof origin === 'string' && origin) {
    // 'null' は sandbox 化された iframe・data: ・file: から来る。自分自身ではない
    const m = origin === 'null' ? null : /^https?:\/\/(.+)$/.exec(origin);
    if (!m || !isLocalAuthority(m[1], port)) {
      return { ok: false, status: 403, reason: 'origin が一致しません' };
    }
  }

  const site = h['sec-fetch-site'];
  if (typeof site === 'string' && site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, reason: '他所のページからの送信は受け付けません' };
  }

  return { ok: true };
}

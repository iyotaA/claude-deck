/**
 * 今日のまとめを Markdown の文字列にする。層0。**import ゼロの純関数**なので Node からテストできる
 * （`test/today-md.test.mjs`）。
 *
 * 画面の「Markdown でコピー」が使う。手元のクリップボードに入れるだけで、外へは送らない。
 * 日報や引き継ぎに貼る下書きなので、**画面と同じ並び・同じ言い方**にする
 * （画面で見たものとコピーしたものが別物だと、貼る前に読み直すことになる）。
 *
 * 画面の組み立て（`today.js`）もここの小道具（`isQuiet` / `shortPath` / `hm` / `spanText`）を使う。
 * 2箇所に書くと、片方だけ直した日に画面とコピーが食い違う。
 */

/**
 * 何日前まで選べるか。サーバー（`src/view/today.mjs` の `TODAY_AGO_MAX`）と同じ値。
 * 超えたぶんはサーバーが丸めるので、食い違っても壊れはしない（選んだ日と違う日が出るだけ）。
 * 揃っていることは `test/today-md.test.mjs` が見ている
 */
export const TODAY_AGO_MAX_UI = 6;

/**
 * 時刻を HH:MM（地方時）で。
 * @param {number|null} ms
 * @returns {string}
 */
export function hm(ms) {
  if (typeof ms !== 'number') return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * その日の始まりと終わり。同じ分なら1つだけ出す。
 * @param {{firstAt: number|null, lastAt: number|null}} row
 * @returns {string}
 */
export function spanText(row) {
  const a = hm(row.firstAt);
  const b = hm(row.lastAt);
  return a === b ? a : `${a}–${b}`;
}

/**
 * ファイルのパスを、そのセッションの作業フォルダから見た形にする。
 * 作業フォルダの外なら元のまま（どこを書き換えたかは消さない）。
 * 大小と区切り（\ と /）の違いは同じとみなす（Windows のパス）。
 *
 * @param {string} path
 * @param {string|null} cwd
 * @returns {string}
 */
export function shortPath(path, cwd) {
  if (!cwd || typeof path !== 'string') return path;
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
  const base = norm(cwd).replace(/\/+$/, '') + '/';
  return norm(path).startsWith(base) ? path.slice(base.length) : path;
}

/**
 * 決めたことも書き換えたファイルも無い行。画面では下に畳み、コピーでは名前だけ並べる。
 * 動いた事実は消さない（「その日に何本動かしたか」も日報の材料なので）。
 * @param {object} row
 * @returns {boolean}
 */
export function isQuiet(row) {
  return !row.decisionsTotal && !row.filesTotal && !row.plansApproved;
}

/**
 * 決めたことの1行。「何について: 何を選んだか」。
 * @param {{topic: string|null, choice: string}} d
 * @returns {string}
 */
export function decisionText(d) {
  return d.topic ? `${d.topic}: ${d.choice}` : d.choice;
}

/**
 * まとめ全体を Markdown にする。
 * @param {object} data `/api/today` の応答
 * @returns {string}
 */
export function todayMarkdown(data) {
  const t = data.totals;
  const out = [`# まとめ（${data.day}）`, ''];
  out.push(`- 動いたセッション ${t.sessions} 本・置き場所 ${t.projects} つ`);
  out.push(`- 決めたこと ${t.decisions} 件・書き換えたファイル ${t.files} 個`);
  // 切ったことは黙らない（画面と同じ）
  if (data.meta?.scanLimited) {
    out.push(`- ※ 新しい ${data.meta.scanMax} 本だけを見ています（${data.meta.candidates} 本中）`);
  }

  const busy = data.rows.filter((r) => !isQuiet(r));
  const quiet = data.rows.filter(isQuiet);

  for (const r of busy) {
    out.push('', `## ${r.project} — ${r.title ?? r.sessionId.slice(0, 8)}（${spanText(r)}）`);
    if (r.decisions.length || r.plansApproved) {
      out.push('', '決めたこと', '');
      for (const d of r.decisions) out.push(`- ${decisionText(d)}`);
      if (r.decisionsOmitted) out.push(`- ほか ${r.decisionsOmitted} 件`);
      if (r.plansApproved) out.push(`- プランを ${r.plansApproved} 件承認`);
    }
    if (r.files.length) {
      out.push('', '書き換えたファイル', '');
      for (const f of r.files) out.push(`- \`${shortPath(f.path, r.cwd)}\``);
      if (r.filesOmitted) out.push(`- ほか ${r.filesOmitted} 個`);
    }
  }

  if (quiet.length) {
    out.push('', '## そのほかに動いたもの', '');
    for (const r of quiet) out.push(`- ${r.project} — ${r.title ?? r.sessionId.slice(0, 8)}（${spanText(r)}）`);
  }

  return out.join('\n') + '\n';
}

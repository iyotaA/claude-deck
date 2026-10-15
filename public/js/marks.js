/* ピン留めとメモの口。層2。
 *
 * 付け外しと書き込みはサーバー（POST /api/marks）が持つ。ここは頼むだけで、
 * 結果は次の一覧の push（行の pinned / memo）で画面に戻ってくる。
 * **画面の側で先に書き換えない。** 保存に失敗したときに「付いたように見えて付いていない」になる
 * （許可要求のカードを先に消さないのと同じ考え）。
 *
 * メモは小さな窓（<dialog id="memo">）で書く。**詳細の頭では書かせない** ――
 * 頭は2秒ごとに作り直すので、打ちかけの文と入力位置が消える。
 * 窓の見た目は設定モーダルのクラスを借りる（起こすフォームと同じ借り方）。
 */
import { dom } from './dom.js';
import { postJson, reasonOf } from './api.js';
import { closeOnBackdrop } from './modal.js';
import { icon } from './icons.js';

/** メモの長さ。サーバー（src/marks の MEMO_MAX）と同じ。超えたぶんはサーバーが断る */
export const MEMO_MAX = 200;

/** メモの窓で書いている相手 */
let memoFor = null;

/**
 * 頼む。**投げない。** 失敗は理由の文で返す。
 * @param {object} body POST /api/marks の本文
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function send(body) {
  try {
    const { res, data } = await postJson('/api/marks', body);
    if (res.ok && data?.ok) return { ok: true };
    return { ok: false, reason: reasonOf(data, res) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * ピンを付ける・外す。
 * @param {string} sessionId
 * @param {boolean} on 付けるなら true
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export function setPin(sessionId, on) {
  return send({ sessionId, pinned: on });
}

/**
 * メモの窓を開く。いまのメモを入れて開く。
 * @param {{sessionId: string, memo?: string|null, title?: string|null}} row
 */
export function openMemo(row) {
  if (!row?.sessionId) return;
  memoFor = row.sessionId;
  dom.memoInput.value = row.memo ?? '';
  dom.memoFor.textContent = row.title ?? row.sessionId;
  dom.memoMsg.textContent = '';
  dom.memoClear.disabled = !row.memo;
  dom.memo.showModal();
  dom.memoInput.focus();
  dom.memoInput.select();
}

/**
 * メモを保存する。空なら消す（サーバーが「ピンもメモも無い」なら記録ごと消す）。
 * @param {string} text
 */
async function saveMemo(text) {
  if (!memoFor) return;
  dom.memoSave.disabled = true;
  const r = await send({ sessionId: memoFor, memo: text });
  dom.memoSave.disabled = false;
  if (!r.ok) {
    dom.memoMsg.textContent = `保存できませんでした: ${r.reason}`;
    return;
  }
  dom.memo.close();
}

/** 配線。main.js から1回だけ呼ぶ */
export function initMarks() {
  // 本文の絵を差す。差す場所は data-icon の印（設定モーダル・起こすフォームと同じ作法）
  for (const node of dom.memo.querySelectorAll('[data-icon]')) node.prepend(icon(node.dataset.icon));
  dom.memoInput.maxLength = MEMO_MAX;
  dom.memoSave.addEventListener('click', () => saveMemo(dom.memoInput.value));
  dom.memoClear.addEventListener('click', () => saveMemo(''));
  dom.memoClose.addEventListener('click', () => dom.memo.close());
  // 1行の入力なので Enter で保存する。**<form> で囲まない**（囲むと Enter で閉じるだけになる。
  // 設定モーダルと同じ理由）。日本語の変換を確定する Enter では保存しない
  dom.memoInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      saveMemo(dom.memoInput.value);
    }
  });
  closeOnBackdrop(dom.memo);
  dom.memo.addEventListener('close', () => { memoFor = null; });
}

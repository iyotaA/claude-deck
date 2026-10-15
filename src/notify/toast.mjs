/**
 * Windows の通知（トースト）に何を出すか。**判断だけ。I/O を持たない。**
 *
 * 出すのは `os/toast.mjs`（PowerShell を起こす薄い殻）。ここは本文の XML と、
 * 押したときの行き先を組むだけなので、全分岐をテストで通せる（test/notify-toast.test.mjs）。
 * `notify/slack.mjs`（応答の意味づけ）と `notify/message.mjs`（本文）を分けたのと同じ線。
 *
 * **Slack と違って題名を載せる。** 外へ出ず、この PC の右下に出るだけなので
 * （作者の判断。2026-10-15）。ただし題名は `watch.mjs` の `snapshot()` を通らない。
 * あちらは Slack の安全装置として題名を落としてあるので、そこへ足すと Slack にも乗る。
 * 題名は呼ぶ側（`notify/index.mjs`）が一覧の行から別に引いて渡す。
 */
import { oneLine } from '../shared/text.mjs';

/**
 * ランチャが登録するアプリの名前（AppUserModelID）。**凍結。**
 *
 * ランチャ（`launcher/Toast.cs`）が `HKCU\Software\Classes\AppUserModelId\ClaudeDeck` に
 * 表示名とアイコンを書く。名前を変えると、変えたあとの版だけ通知が黙って出なくなる
 * （登録の無い名前で出したトーストは、Windows が何も言わずに捨てる）。
 */
export const TOAST_APP_ID = 'ClaudeDeck';

/**
 * ランチャが無いとき（npm start）に借りる名前。Windows PowerShell が登録済みのもの。
 * 差出人が「Windows PowerShell」と出るが、届く（作者の判断。2026-10-15）。
 */
export const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * 押したときに開く口。**凍結。** ランチャが Windows にこの名前で登録する
 * （`HKCU\Software\Classes\claude-deck`）。変えると、古い登録が指す先が無くなる。
 */
export const PROTOCOL = 'claude-deck';

/** 1回の flush で出すトーストの上限。超えたぶんは「ほか N 件」の1枚にまとめる */
export const TOAST_MAX = 3;

/** 題名と待っている中身の切り詰め。トーストは3行ほどしか見えない */
const TITLE_MAX = 80;
const DETAIL_MAX = 120;

/**
 * XML の文字を逃がす。トーストの本文はログ由来なので、必ず通す。
 * @param {unknown} text
 * @returns {string}
 */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 押したときの行き先。
 *
 * - ランチャ経由で動いているとき：`claude-deck://open?session=<id>`。ランチャが受けて、
 *   ClaudeDeck の窓を前に出し、そのセッションを開く
 * - npm start のとき：`<baseUrl>?session=<id>`。既定のブラウザで開く
 *   （`claude-deck://` はランチャが登録するので、ランチャが無いと行き先が無い）
 *
 * 行き先が作れない（baseUrl がまだ無い・セッションが無い）ときは null。
 * トーストは押しても何も起きないだけで、出すことはできる。
 *
 * @param {{sessionId?: string|null, baseUrl?: string|null, viaLauncher?: boolean}} opts
 * @returns {string|null}
 */
export function toastLaunchUrl({ sessionId = null, baseUrl = null, viaLauncher = false } = {}) {
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  if (viaLauncher) return `${PROTOCOL}://open${q}`;
  if (!baseUrl) return null;
  return `${baseUrl}${q}`;
}

/**
 * 1件ぶんのトーストの XML。
 *
 * 1行目は「状態 ― 題名」、2行目は「置き場所 · ツール: 中身」か「待ち N 分」。
 * 押せる口は本文そのもの（launch）と「開く」ボタンの2つで、行き先は同じ。
 *
 * @param {object} item `watch.takeReady()` の1件（snapshot の形）
 * @param {{title?: string|null, launchUrl?: string|null, waitText?: string|null,
 *          detail?: 'full'|'none'}} [opts]
 *   title は一覧の行の題名（Slack には出さないもの）、waitText は待ちの長さの文。
 *   detail が none なら中身（コマンドや質問文）を落とす（Slack の設定と同じ1本で決める）
 * @returns {string}
 */
export function buildToastXml(item, { title = null, launchUrl = null, waitText = null, detail = 'full' } = {}) {
  // 切るのは oneLine（末尾に「…」）。clip は「…（以下省略）」を足すので、3行ほどしか
  // 見えないトーストには長すぎる
  const head = [item?.stateLabel, title ? oneLine(title, TITLE_MAX) : null]
    .filter(Boolean)
    .join(' ― ') || 'ClaudeDeck';

  const parts = [];
  if (item?.project) parts.push(item.project);
  if (item?.tool) {
    const what = detail !== 'none' && item.detail ? oneLine(item.detail, DETAIL_MAX) : null;
    parts.push(what ? `${item.tool}: ${what}` : item.tool);
  } else if (waitText) {
    parts.push(waitText);
  }
  const body = parts.join(' · ');

  return toastXml(head, body, launchUrl);
}

/**
 * まとめの1枚。上限を超えたぶんを1枚にする（右下が通知で埋まらないように）。
 * @param {number} rest まとめた件数
 * @param {string|null} launchUrl 行き先（一覧を開く）
 * @returns {string}
 */
export function buildRestXml(rest, launchUrl = null) {
  return toastXml(`ほか ${rest} 件の待ちがあります`, 'ClaudeDeck で確かめてください', launchUrl);
}

/**
 * XML の器。本文はここで必ず逃がす。
 * @param {string} head 1行目
 * @param {string} body 2行目（空なら出さない）
 * @param {string|null} launchUrl 押したときの行き先
 * @returns {string}
 */
function toastXml(head, body, launchUrl) {
  // 行き先があるときだけ protocol で起こす。無いときは launch を付けない（押すと通知センターが開くだけ）
  const launch = launchUrl
    ? ` launch="${escapeXml(launchUrl)}" activationType="protocol"`
    : '';
  const lines = [`<text>${escapeXml(head)}</text>`];
  if (body) lines.push(`<text>${escapeXml(body)}</text>`);
  const actions = launchUrl
    ? `<actions><action content="開く" activationType="protocol" arguments="${escapeXml(launchUrl)}"/></actions>`
    : '';
  return `<toast${launch}><visual><binding template="ToastGeneric">${lines.join('')}</binding></visual>${actions}</toast>`;
}

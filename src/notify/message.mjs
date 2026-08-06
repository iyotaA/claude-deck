/**
 * 通知の本文を組む。全部が純関数で、I/O を持たない。
 *
 * ここに載せてよいものを絞ってあるのが要点。
 * cwd・logFile・gitBranch・title・lastPrompt は絶対に載せない。
 * 載るのは project（フォルダ名だけ）までにする。
 *
 * Slack へ出すのは Block Kit ではなく素の mrkdwn（{text} 1本）にしてある。
 * Block Kit にすると通知プレビュー用の text を別に持つことになり、
 * 同じ文言を2箇所で直すはめになるため。
 */
import { clip } from '../shared/text.mjs';

/** 質問文の上限。これ以上あってもスマホの通知では読めない。 */
const DETAIL_MAX = 300;

/**
 * Slack の mrkdwn で意味を持つ3文字を潰す。
 *
 * 送るのは会話ログ由来の文字列で、コードや不等号がふつうに入る。
 * & を先に置き換えないと、あとの置き換えで作った &lt; がもう一度壊れる。
 *
 * @param {*} text 元の文字列
 * @returns {string}
 */
export function escapeSlack(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Webhook の URL を、人に見せてよい形にする。
 *
 * 起動時の1行と /api/health に出す。末尾の秘密は必ず落とす。
 *
 * @param {*} url 生の URL
 * @returns {string|null} URL が無ければ null
 */
export function maskWebhook(url) {
  if (typeof url !== 'string' || !url.trim()) return null;

  // services/ は誰の URL でも同じ固定文字列なので、伏せずに前置きへ吸わせる。
  // ここを伏せると serv… という読みにくい断片が出るだけで、隠す意味がない。
  // 無い形が来ても動くよう、あってもなくてもよい扱いにしてある
  const m = /^(https:\/\/hooks\.slack\.com\/(?:services\/)?)(.*)$/.exec(url.trim());
  // 形が違うものはそもそも設定として弾かれるが、ここでも中身を出さない
  if (!m) return '（Slack の Webhook ではない URL）';

  const parts = m[2].split('/').filter(Boolean);
  if (parts.length === 0) return `${m[1]}****`;

  // 最後の1片が本体の秘密。手前は頭だけ残す（どれを設定したかの見分けはつく）
  const head = parts.slice(0, -1).map((p) => (p.length > 4 ? `${p.slice(0, 4)}…` : p));
  return `${m[1]}${[...head, '****'].join('/')}`;
}

/**
 * 例外やレスポンスの文言から URL の痕跡を消す。
 *
 * fetch の失敗メッセージには URL がそのまま埋め込まれることがある。
 * 保存・表示・ログ出力の前に必ず通す。
 *
 * @param {*} text 元の文言
 * @param {string|null} rawUrl 設定されている生の URL
 * @returns {string}
 */
export function scrubError(text, rawUrl = null) {
  let s = String(text ?? '');
  // 設定値そのものを消す。split/join にしているのは、URL に正規表現の記号が
  // 入っていても壊れないようにするため
  if (typeof rawUrl === 'string' && rawUrl) s = s.split(rawUrl).join('（URL を伏せました）');
  // 別の URL が混ざっていても落とす。形で拾えるものは形で拾う
  return s.replace(/https?:\/\/hooks\.slack\.com\/\S*/g, '（URL を伏せました）');
}

/**
 * 待っている長さを人の読む形にする。
 *
 * 1分に満たないものは書かない。「0分待っています」は情報が無いうえ、
 * すぐ答えられる場面で急かしているように読める。
 *
 * @param {*} idleMs 待っているミリ秒
 * @returns {string|null} 書かないときは null
 */
export function waitLabel(idleMs) {
  if (typeof idleMs !== 'number' || !Number.isFinite(idleMs) || idleMs < 60000) return null;
  const min = Math.floor(idleMs / 60000);
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}時間${min % 60}分`;
}

/**
 * 通知1通分の本文を組む。
 *
 * 同時に確定した項目は1通にまとめる。空配列なら空文字を返すので、
 * 呼び出し側は送る前に長さを見ること。
 *
 * @param {Array<object>} items watch.mjs が作った項目（snapshot 済み）
 * @param {object} [opts]
 * @param {string|null} [opts.baseUrl] ClaudeDeck の URL。末尾に / を含む形
 * @param {'full'|'none'} [opts.detail] none なら質問文を落とす
 * @param {number} [opts.dropped] 溢れて捨てた件数。0 なら書かない
 * @returns {string}
 */
export function buildText(items, { baseUrl = null, detail = 'full', dropped = 0 } = {}) {
  const blocks = [];

  for (const item of items ?? []) {
    const lines = [];

    const label = escapeSlack(item.stateLabel ?? '待っています');
    const name = escapeSlack(item.name ?? '不明');
    // project が取れなければ括弧ごと省く。空の括弧を出さない
    const project = item.project ? `（${escapeSlack(item.project)}）` : '';
    const again = item.kind === 'remind' ? ' — まだ待っています' : '';
    lines.push(`*${label}* ${name}${project}${again}`);

    // waitingFor が無ければ2行目と3行目を省く。null という文字を出さない
    if (item.tool) lines.push(`待っているもの: ${escapeSlack(item.tool)}`);
    // 返信待ちには tool も detail も無い。これが無いと見出し1行だけの通知になる
    const waited = waitLabel(item.idleMs);
    if (waited) lines.push(`${waited}待っています`);
    // clip は中身が空なら null を返す。空の引用行を出さないためここで見る
    const said = detail === 'none' ? null : clip(item.detail, DETAIL_MAX);
    if (said) lines.push(`> ${escapeSlack(said)}`);

    // 深いリンクは ?session= を使う。public/js/stream.js がすでに受けている
    if (baseUrl && item.sessionId) {
      lines.push(`<${baseUrl}?session=${encodeURIComponent(item.sessionId)}|ClaudeDeck で開く>`);
    }

    blocks.push(lines.join('\n'));
  }

  // 捨てた分は黙って消さない。次に届いた通知の末尾で伝える
  if (dropped > 0) blocks.push(`（送れないまま捨てた通知が ${dropped} 件あります）`);

  return blocks.join('\n\n');
}

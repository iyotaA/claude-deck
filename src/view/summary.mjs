/**
 * 「このセッション、なんでこれやってるんだっけ」に一目で答える要約。
 *
 * セッションを行き来していると、状態（何を待っているか）は分かっても
 * 背景（なぜこの作業をしているのか）が思い出せない。詳細の各パネルを
 * 読み下せば分かるが、それでは切り替えのたびに読み直すことになる。
 * そこを1行＋数点に畳んで先頭に置く。
 *
 * いまは AI を使わず、digest の中身から決定論的に組む。
 * 同じログなら必ず同じ結果になり、通信もしないので待たされない。
 *
 * ── AI 要約に差し替えるときの入り口 ──────────────────────────
 *
 * この summarize() が唯一の差し替え点。detail.mjs は結果の形しか見ていない。
 * 返す形（source / headline / headlineSource / points）を保てば、中身は何で作ってもよい。
 * headlineSource は「見出しが誰の言葉か」を表す。AI が作った見出しに 'recap' を
 * 立ててはいけない（画面が「Claude の申告」の印を出すので、意味が変わる）。
 *
 * 置き換えるときに守ること:
 *
 *  - 既定では通信しない。鍵が無ければ黙って素の要約に戻す。
 *    このアプリは同僚に配る前提で、鍵の設定を必須にすると配れなくなる
 *  - ログ本文を外へ送る処理になる。業務内容が入っているため、
 *    使うかどうかは利用者が明示的に選ぶ形にする（環境変数などで）
 *  - 失敗しても詳細ビュー全体を落とさない。要約は無くても困らない部分
 *  - 素の要約を捨てない。AI 側が落ちたときの表示になる
 *
 * 呼び出しの骨組みは次の形になる。
 *
 *   export async function summarize(detail) {
 *     const plain = plainSummary(detail);
 *     if (!process.env.CLAUDE_DECK_AI) return plain;
 *     try {
 *       return { ...(await askModel(detail.digest)), fallback: plain };
 *     } catch {
 *       return plain;
 *     }
 *   }
 */

import { oneLine } from '../shared/text.mjs';

/** 要約に出す点の数。増やすと読む量が増えて、畳んだ意味が薄れる。 */
const MAX_POINTS = 5;

/** 選んだ答えを「質問 → ラベル」の一行にする。 */
function answerLine(answer) {
  const label = answer.chosenOptions?.[0]?.label ?? answer.chosen;
  if (!label) return null;
  const topic = answer.header || oneLine(answer.question, 40);
  return topic ? `${topic}: ${label}` : String(label);
}

/**
 * digest から要約を組む。AI は使わない。
 *
 * @param {object} detail getSessionDetail の戻り
 */
export function plainSummary(detail) {
  const items = detail?.digest?.items ?? [];
  const stats = detail?.digest?.stats ?? {};

  const prompts = items.filter((it) => it.kind === 'prompt' && it.text);
  const answers = items.filter((it) => it.kind === 'answer');
  const plans = items.filter((it) => it.kind === 'plan');

  // 最初の指示がこのセッションの目的そのもの。ここが「なぜやっているか」にあたる。
  // 圧縮で消えていることがあるので、無ければタイトルで代える
  const first = prompts[0]?.text ?? null;

  /**
   * Claude が書いた中間報告は、見出しには使わない。
   *
   * ここは「何を頼んだセッションか」を出す場所で、中間報告は
   * 「いまどこまで進んだか」なので、答えている問いが違う。
   *
   * 一度は「報告が最後の指示より新しければ見出しに使う」形にしたが、実物で外した。
   * 完了報告が目的の欄に居座って、何を頼んだセッションなのかが読めなくなる。
   * さらに悪いのは、報告のあるセッションと無いセッションで同じ枠に違う種類の
   * ものが出ること。時刻の前後で中身の種類が変わる枠は、読み手が信用できない。
   *
   * 例外は指示もタイトルも取れなかったときだけ。空欄より自己申告のほうがましなので、
   * 最後の手段として使う。そのときは headlineSource が 'recap' になり、
   * 画面が「Claude の申告」の印を出す
   */
  const recap = detail?.recap ?? null;

  // 見出しの出どころを持ち回す。画面はこれを見て「Claude の申告」の印を出す。
  // source（誰が作った要約か）とは別の軸なので、混ぜない
  let headline = oneLine(first, 160);
  let headlineSource = headline ? 'prompt' : null;
  let headlineAt = null;
  if (!headline) {
    headline = detail?.title ?? null;
    headlineSource = headline ? 'title' : null;
  }
  if (!headline && recap?.text) {
    headline = oneLine(recap.text, 160);
    headlineSource = 'recap';
    // いつの申告かを画面が出せるようにする
    headlineAt = recap.at ?? null;
  }

  const points = [];

  // 途中で目的が変わっていることがあるため、最後の指示も別に出す
  const last = prompts[prompts.length - 1]?.text ?? null;
  if (last && last !== first) points.push({ label: '直近の指示', text: oneLine(last, 120) });

  // 見出しに使わなかった報告は点に回す。捨てると「報告があった事実」まで消える
  if (recap?.text && headlineSource !== 'recap') {
    points.push({ label: 'Claude の申告', text: oneLine(recap.text, 120) });
  }

  const lastAnswer = answers[answers.length - 1]?.answers?.slice(-1)[0];
  const decided = lastAnswer ? answerLine(lastAnswer) : null;
  if (decided) points.push({ label: '最後に決めたこと', text: oneLine(decided, 120) });

  const lastPlan = plans[plans.length - 1];
  if (lastPlan) {
    const status = lastPlan.pending ? '承認待ち' : lastPlan.approved ? '承認済み' : '差し戻し';
    points.push({ label: 'プラン', text: status });
  }

  if (detail?.waitingFor) {
    const w = detail.waitingFor;
    points.push({ label: '待っているもの', text: oneLine(w.detail ? `${w.tool} — ${w.detail}` : w.tool, 120) });
  }

  // 圧縮されていると、上の「最初の指示」が本当の始まりではない可能性がある。
  // 黙って古い指示を目的として見せると誤解を招くので、そこは断っておく
  const compacted = (detail?.digest?.compactions ?? []).length;

  return {
    // 誰が作った要約か。AI に差し替えたときの判別に使うので、ここは変えない
    source: 'plain',
    headline,
    headlineSource,
    headlineAt,
    points: points.slice(0, MAX_POINTS),
    counts: {
      prompts: stats.prompts ?? 0,
      answers: stats.answers ?? 0,
      plans: stats.plans ?? 0,
      denials: stats.denials ?? 0,
    },
    compacted,
  };
}

/**
 * 要約を作る。
 *
 * いまは素の要約を返すだけ。AI に差し替えるときはここだけを書き換える。
 *
 * @param {object} detail getSessionDetail の戻り
 */
export async function summarize(detail) {
  return plainSummary(detail);
}

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
 * 返す形（source / headline / points）を保てば、中身は何で作ってもよい。
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
const MAX_POINTS = 4;

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
  const headline = oneLine(first, 160) ?? detail?.title ?? null;

  const points = [];

  // 途中で目的が変わっていることがあるため、最後の指示も別に出す
  const last = prompts[prompts.length - 1]?.text ?? null;
  if (last && last !== first) points.push({ label: '直近の指示', text: oneLine(last, 120) });

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
    source: 'plain',
    headline,
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

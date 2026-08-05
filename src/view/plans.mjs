/**
 * 承認したプランが、いまディスクにあるものと同じかを判定する。
 *
 * 答えたい問いは「あのとき approve したプランと、いま plans に置かれている
 * ファイルは同じものか」。ここが食い違っていると、プランを根拠に話が進んだあとで
 * 前提だけがすり替わっていたことになる。
 *
 * **本文の一致を主、mtime を従にする。** 実測した45件で承認時刻とファイルの
 * 更新時刻を比べたところ、ほぼ一致（±2秒）12件・ファイルのほうが古い28件・
 * ファイルのほうが新しい5件だった。プランファイルは ExitPlanMode を呼ぶ
 * 0.1〜0.5分前に書かれ、承認はそのあと（数分〜4時間後）に来るため。
 * mtime を主判定にすると、ほぼ毎回誤報する。
 *
 * **差分（diff）は作らない。** 依存を増やせないので自作になるが、答えたい問いは
 * 「変わったか、いつか」。両方の本文を並べれば読み手が見比べられる。意図的な線引き。
 */
import path from 'node:path';
import { clip } from '../shared/text.mjs';
import { readPlanFile } from '../read/plans.mjs';

/** ディスクの本文を詳細の応答に載せるときの上限。digest の plan と同じ長さに揃える。 */
const LIMIT_BODY = 24000;

/** clip() が末尾に足す断り書き。切られたかどうかの見分けに使う。 */
const CLIP_MARK = '…（以下省略）';

/**
 * 比較用に本文を揃える。
 *
 * ディスクのファイルは末尾に改行が付き、改行コードも環境で変わる。
 * そこを吸収するだけに留める。空白の潰しや大小の無視まではやらない
 * （プランの本文はインデントに意味があるため）
 *
 * @param {*} s 揃えたい値
 * @returns {string|null} 文字列でなければ null
 */
function normalize(s) {
  return typeof s === 'string' ? s.replace(/\r\n/g, '\n').trim() : null;
}

/**
 * 提出した本文と、ディスクの本文を突き合わせる。
 *
 * 提出した本文は digest 側で 24,000 字に切られている。切られていた場合は
 * 頭の部分しか比べられないので、その旨を partial で正直に返す。
 * これは珍しい話ではない。実測すると 31,862 字（58KB）のプランが実在した
 * （提案書は最大 14,170 バイトと書いていたが、そのあと超えるものが出ている）。
 *
 * 字数は**生の長さ同士**で比べる。本文の一致判定のほうは末尾の改行を落としてから
 * 比べるので、そちらの長さを使うと「提出もディスクも 31,862 字」なのに
 * 片方だけ 31,861 になって食い違う（両方とも改行で終わっているため）。
 *
 * その上で、字数の一致は「同じだ」を補強する材料としてだけ使い、
 * **食い違いを根拠に differs とは言わない。** 改行コードが CRLF で保存されていれば
 * 行数のぶんだけ字数が増える。中身は同じなのに「書き換わっています」と言うほうが害が大きい。
 *
 * @param {*} submitted digest の plan.plan（切られている可能性がある）
 * @param {*} submittedChars digest の plan.planChars（切る前の生の長さ）
 * @param {*} disk ディスクから読んだ本文
 * @returns {{verdict: 'same'|'differs'|'unknown', partial: boolean, charsMatch: boolean, submittedChars: number|null, diskChars: number|null}}
 */
export function comparePlanBody(submitted, submittedChars, disk) {
  const sub = normalize(submitted);
  const d = normalize(disk);
  const chars = typeof submittedChars === 'number' ? submittedChars : null;
  // 生の長さ同士で比べる。d は正規化済みなので末尾の改行のぶんだけ短い
  const diskChars = typeof disk === 'string' ? disk.length : null;
  const charsMatch = chars !== null && diskChars !== null && chars === diskChars;

  // どちらかが取れていないなら判定しない。「一致しない」と言い切ると嘘になる
  if (sub === null || d === null) {
    return { verdict: 'unknown', partial: false, charsMatch: false, submittedChars: chars, diskChars };
  }

  if (sub.endsWith(CLIP_MARK)) {
    const head = sub.slice(0, -CLIP_MARK.length);
    return {
      verdict: d.startsWith(head) ? 'same' : 'differs',
      partial: true,
      charsMatch,
      submittedChars: chars,
      diskChars,
    };
  }

  return { verdict: sub === d ? 'same' : 'differs', partial: false, charsMatch, submittedChars: chars, diskChars };
}

/**
 * 判定に添える文言を組む。
 *
 * 日本語をここに置くのは denialLabel と同じ流儀。画面側は並べるだけにする。
 * **言い切らないこと**を文言で守る。mtime だけを根拠に「書き換わった」とは書かない。
 *
 * @param {object} params
 * @param {string} params.verdict comparePlanBody の判定
 * @param {boolean} params.partial 頭の部分だけの比較だったか
 * @param {boolean} params.charsMatch 字数まで一致していたか
 * @param {boolean|null} params.changedAfterSubmit mtime が承認時刻より新しいか。分からなければ null
 * @param {string|null} params.reason readPlanFile が返した理由
 * @param {boolean|null} params.edited 提出前に編集されたか。書かれていなければ null
 * @param {boolean} params.sharedWithinSession 同じファイルを複数の提出が共有しているか
 * @returns {string[]} 出す文言。無ければ空配列
 */
function noteLines({ verdict, partial, charsMatch, changedAfterSubmit, reason, edited, sharedWithinSession }) {
  const out = [];

  if (reason === 'missing') out.push('プランのファイルが今は見つかりません');
  else if (reason === 'outside') out.push('プランの置き場所の外を指していたので開いていません');
  else if (reason === 'too-large') out.push('プランのファイルが大きすぎるので中身を読んでいません');
  else if (reason === 'unreadable') out.push('プランのファイルを開けませんでした');
  else if (verdict === 'differs' && changedAfterSubmit === true) {
    out.push('提出後に書き換わっています');
  } else if (verdict === 'differs') {
    out.push('本文が一致しません（理由は特定できません）');
  } else if (verdict === 'same') {
    out.push('提出後にファイルは変わっていません');
  }

  if (verdict !== 'unknown' && partial) {
    out.push(charsMatch
      ? '提出した本文が長いため、頭の部分と字数で比べています'
      : '提出した本文が長いため、頭の部分だけを比べています');
  }
  // true のときだけ書かれるキー。無いことを「編集なし」と読み替えない
  if (edited === true) out.push('提出前にプランを編集しています');
  if (sharedWithinSession) out.push('このセッションの複数の提出が同じファイルを指しています');

  return out;
}

/**
 * プランの系譜を組む。
 *
 * 見るのは**最後の1件だけ**。plans ディレクトリは走査しない。
 * 走査して mtime が最新のファイルを当てる推測はしない。最大60セッションが
 * 同時に走る前提なので、他のセッションのプランを取り違える。
 * slugifyCwd からパスを復元しない禁止と同じ理屈。
 *
 * @param {object} digest buildDigest の結果
 * @param {object} [opts]
 * @param {string} [opts.root] plans ディレクトリ。テストから差し替える口
 * @returns {Promise<object|null>} 材料が無ければ null（何も出さない）
 */
export async function buildPlanLineage(digest, { root } = {}) {
  const plans = (digest?.items ?? []).filter((i) => i.kind === 'plan');
  const last = plans[plans.length - 1] ?? null;
  if (!last) return null;

  const planFile = typeof last.planFile === 'string' ? last.planFile : null;
  const base = {
    state: last.approved ? 'approved' : last.pending ? 'pending' : 'rejected',
    // どの提出の話かを画面側が突き合わせるための鍵。
    // 「最後の1件」の判断をサーバ側だけに置くと、サブエージェントの時系列を描くときに
    // 親のプランの系譜を子のプランに貼ってしまう
    uuid: last.uuid ?? null,
    at: last.at ?? null,
    approvedAt: last.resultAt ?? null,
    planFile,
    planName: planFile ? path.basename(planFile) : null,
    fileKnown: planFile !== null,
    edited: last.edited === true ? true : null,
    submitted: { text: last.plan ?? null, chars: last.planChars ?? null },
  };

  if (!planFile) {
    return {
      ...base,
      disk: null,
      verdict: 'unknown',
      partial: false,
      changedAfterSubmit: null,
      sharedWithinSession: false,
      // 承認待ちのプランは toolUseResult が無いので、ファイル名がログのどこにも現れない。
      // 推測で当てないと決めた以上、出ない理由をそのまま伝える
      notes: last.pending
        ? ['承認されるまでファイル名はログに出ません']
        : noteLines({ verdict: 'unknown', partial: false, charsMatch: false, changedAfterSubmit: null, reason: null, edited: base.edited, sharedWithinSession: false }),
    };
  }

  const file = await readPlanFile(planFile, root ? { root } : {});
  const cmp = comparePlanBody(last.plan, last.planChars, file.text);

  // 承認時刻より新しいか。どちらかが取れなければ null（0 と「不明」を分ける）
  const changedAfterSubmit = typeof file.mtimeMs === 'number' && typeof last.resultAt === 'number'
    ? file.mtimeMs > last.resultAt
    : null;

  // 同じファイルを複数の提出が共有していると、あとの提出で本文が上書きされている。
  // 実測でも1ファイルを3提出が共有している例があった
  const sharedWithinSession = plans.filter((p) => p.planFile === planFile).length > 1;

  return {
    ...base,
    disk: {
      text: clip(file.text, LIMIT_BODY),
      chars: file.chars,
      mtimeMs: file.mtimeMs,
      size: file.size,
      reason: file.reason,
    },
    verdict: cmp.verdict,
    partial: cmp.partial,
    charsMatch: cmp.charsMatch,
    changedAfterSubmit,
    sharedWithinSession,
    notes: noteLines({
      verdict: cmp.verdict,
      partial: cmp.partial,
      charsMatch: cmp.charsMatch,
      changedAfterSubmit,
      reason: file.reason,
      edited: base.edited,
      sharedWithinSession,
    }),
  };
}

/**
 * 更新の帯に何を出すかを決める。**判断だけ。層0（何も import しない）。**
 *
 * もとは `update.js` の中にあった 162 行の関数で、8つの枝が
 * すべて同じ形のリテラル（`{key, tone, text, note, keep, act}`）を返していた。
 *
 * ## 表には落とせなかった
 *
 * 見る入力が4つある ―― `up.state` だけでなく、`stuckAt`（諦めた時刻）・
 * `pressed`（押したか）・`isApplyFailure(up)`（当てに行って転んだか）。
 * 状態から引く表にすると、この3つを表の外で分岐させることになり、
 * 「どの枝に入るか」が2箇所に分かれる。**枝はそのまま残してある。**
 *
 * 寄せたのは**組み立ての形**と、判断が状態を読まないようにしたこと。
 * `stuckAt` と `pressed` は `update.js` の可変なモジュール変数だったので、
 * 引数で受ける形にした。押したときに走らせる仕事（`reloadNow` / `applyNow`）も同じで、
 * **札に何を出すかは判断、実際に何をするかは呼ぶ側**という分け方にしてある。
 *
 * おかげでここは**入力を渡せば結果が決まる純関数**になり、
 * `update.js` を起動せずに（`localStorage` も `fetch` も無い Node から）
 * 8つの枝を全部確かめられる。
 *
 * `parseUpdateState`（判断）と `loadUpdateState`（I/O）を分けたのと同じ形で、
 * `update/CLAUDE.md` が「画面側にも同じ形を」と言っていたのがこれ。
 *
 * ## 鍵（key）の付け方に意味がある
 *
 * 閉じた帯は `keep: true` のとき `localStorage` に鍵ごと残る。
 * だから**押せる知らせと押せない知らせで鍵を分ける**（下の枝7のコメント参照）。
 * 同じ鍵にすると、押せないと言われて閉じた帯が、押せる状態になっても二度と出ない。
 */

/**
 * 「入れ替えました」を出し続ける期限。
 *
 * done の紙は次の確認まで上書きされない（--restarted は更新を確認しないため）。
 * 期限を切らないと、翌朝の起動でも「入れ替えました」が出る。
 */
const DONE_FRESH_MS = 600000;

/**
 * サーバが古くて窓口ごと無いときに、画面側で組む状態。
 *
 * /api/update が 404 を返すのは「このサーバは窓口を知らない」＝古い、以外にありえない。
 * 実際にこれで1度つまずいている（2026-08-12）。6日前に立てたサーバが 4317 を掴んだままで、
 * npm start も ClaudeDeck.exe も「もう動いている」を見つけて窓を開くだけで終わるため、
 * 直したはずのコードが一度も走らなかった。画面はいつもどおりに見えるので気づけない。
 *
 * 形は /api/update の応答に合わせる。読む側（render / fillVersion）に分岐を増やさないため。
 * 版は入れない。取れなかったものを埋めると、古いサーバの版を知っているように見えてしまう
 */
export const OUTDATED = Object.freeze({
  state: 'outdated',
  label: 'このサーバーは古い版です',
  current: null,
  available: null,
  requested: null,
  notes: null,
  checkedAt: null,
  changedAt: null,
  error: null,
  path: null,
  canApply: false,
});
/**
 * 当てようとして転んだのか、ただ確認に失敗しただけかを分ける。
 *
 * 見るのは requested。素の確認（CheckAsync）はここを書かないので、
 * 入っていれば「当てにいって転んだ」と言い切れる。
 * 画面側の押した記憶に頼らないので、途中で読み込み直しても判定が残る。
 *
 * @param {object} up /api/update の応答
 * @returns {boolean}
 */
export function isApplyFailure(up) {
  return (up.state === 'failed' || up.state === 'unreachable') && Boolean(up.requested);
}

/**
 * いま出す帯を決める。純粋な組み立てで、DOM は触らない。
 *
 * 並べる順に意味がある。上にあるものほど「いま伝えるべきこと」が強い。
 *
 * @param {object|null} up /api/update の応答
 * @returns {object|null} {key, tone, text, note, keep, act} 出さないなら null
 */
export function bannerOf(up, { stuckAt = null, pressed = false, reloadNow = null, applyNow = null } = {}) {
  // 1. 諦めた。何が起きたか分からないので、確かめ方まで書く
  if (stuckAt !== null) {
    return {
      key: `stuck:${stuckAt}`,
      tone: 'warn',
      text: '更新の返事がありません',
      note: '入れ替わっているかもしれません。読み込み直すか、ClaudeDeck.exe --status で確かめてください',
      keep: true,
      act: { label: '読み込み直す', run: reloadNow },
    };
  }

  if (!up) return null;

  // 2. このサーバーが古い。窓を閉じて開き直しても直らないので、そこまで書く
  if (up.state === OUTDATED.state) {
    return {
      key: OUTDATED.state,
      tone: 'warn',
      text: 'このサーバーは古い版です',
      note: '窓を開き直しても直りません。サーバーを立ち上げ直してください',
      // 覚えない。立ち上げ直すまで直らないので、開くたびに出るのが正しい
      keep: false,
      act: null,
    };
  }

  // 3. 入れ替わった。ここで自動的に読み込み直さない。
  //    いま見えているのは前の版の画面なので、そのことを言ってから人に押させる
  if (up.state === 'done') {
    const fresh = up.changedAt === null || Date.now() - up.changedAt < DONE_FRESH_MS;
    if (!fresh) return null;
    return {
      key: `done:${up.changedAt ?? 0}`,
      tone: '',
      text: up.current ? `入れ替えました（${up.current}）` : '入れ替えました',
      note: 'この画面はまだ前の版です。読み込み直してください',
      keep: true,
      act: { label: '読み込み直す', run: reloadNow },
    };
  }

  // 4. 作業中。押せることは無いので札は出さない
  if (up.state === 'downloading') {
    return {
      key: `downloading:${up.changedAt ?? 0}`,
      tone: 'work',
      text: '新しい版を取り寄せています',
      note: up.requested
        ? `${up.requested} を取り寄せています。回線によっては数分かかります`
        : '回線によっては数分かかります',
      keep: false,
      act: null,
    };
  }
  if (up.state === 'applying') {
    return {
      key: `applying:${up.changedAt ?? 0}`,
      tone: 'work',
      text: '入れ替えています',
      note: 'サーバーがいったん止まって起き直ります。この画面はそのままでお待ちください',
      keep: false,
      act: null,
    };
  }

  // 5. 当てにいって転んだ。動いていることを必ず書き添える。
  //    ランチャは失敗したらサーバーを起こし直すので、実際に動いている
  if (isApplyFailure(up)) {
    return {
      key: `failed:${up.changedAt ?? 0}`,
      tone: 'warn',
      text: up.label,
      // 理由は括弧で終わることが多い（「…求めた 0.2.1）」）。
      // 添える一言まで括弧にすると括弧が2つ並ぶので、句点でつなぐ
      note: up.error ? `${up.error}。いまの版のまま動いています` : 'いまの版のまま動いています',
      keep: true,
      act: up.canApply ? { label: 'もう一度', run: applyNow } : null,
    };
  }

  // 6. 押したが、まだランチャが紙を書いていない。
  //    素通りさせると「更新する」がもう一度出て、二度押しを誘う
  if (pressed && up.state === 'available') {
    return {
      key: 'starting',
      tone: 'work',
      text: '更新を始めています',
      note: 'ランチャを起こしています',
      keep: false,
      act: null,
    };
  }

  // 7. 新しい版がある
  //
  // **鍵は押せるかどうかで分ける。** 同じ鍵にすると、押せないと言われて閉じた帯が、
  // 押せる状態になっても二度と出てこない（閉じた鍵は keep: true で localStorage に残り、
  // 版が変わるまで一致し続けるため）。
  //
  // 実測で踏んだ形はこう。手で立てた server.mjs の画面で
  // 「この起動の仕方では入れ替えられません」を閉じ、そのあとインストールした側から
  // 立て直して canApply が true になったのに、版が同じだから帯が出なかった。
  // 押せない知らせを閉じたことが、押せる知らせまで殺していた。
  //
  // 古い鍵（`available:<版>`）はどちらとも一致しないので、
  // 押せない帯を閉じたまま埋もれていた人も1回だけ出直す。
  if (up.state === 'available') {
    // 版が読めない紙でも知らせる意味はあるので、そこは '?' で通す
    const ver = up.available || '?';
    const text = up.available ? `新しい版があります（${up.available}）` : '新しい版があります';
    if (!up.canApply) {
      return {
        key: `available-cant:${ver}`,
        tone: 'new',
        text,
        note: 'この起動の仕方では入れ替えられません。インストールした ClaudeDeck から起動してください',
        keep: true,
        act: null,
      };
    }
    return {
      key: `available-can:${ver}`,
      tone: 'new',
      text,
      note: up.current ? `いまは ${up.current}` : '',
      keep: true,
      act: { label: '更新する', run: applyNow },
    };
  }

  // 8. 押したのに、ここまでのどれにも当てはまらない。
  //    ランチャは「新しい版は無かった」と判断して none を書いて終わることがある。
  //    黙って帯を消すと「押したのに何も起きなかった」になるので、来た言い方をそのまま出す
  if (pressed) {
    if (up.state === 'none') {
      return {
        key: 'pressed-none',
        tone: '',
        text: '最新です',
        note: '更新は取り下げられていたようです',
        keep: false,
        act: null,
      };
    }
    return {
      key: `pressed:${up.state}:${up.changedAt ?? 0}`,
      tone: 'warn',
      text: up.label,
      note: up.error ?? '',
      keep: false,
      act: null,
    };
  }

  // 確認できなかったことまで帯にすると、回線の細い日に毎回じゃまをする。
  // そちらは版の脇の印と --status に任せる
  return null;
}

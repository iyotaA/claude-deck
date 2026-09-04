/**
 * 更新の帯の組み立て。public/js/update-banner.js の判断だけを見る。
 *
 * 画面側のファイルだが DOM も localStorage も fetch も1つも触らないので、
 * Node から import できる（md.test.mjs と同じ理由。拡張子が .js なのは public/ の決まり）。
 *
 * ここが在る理由は、この帯が**いちばん確かめにくい画面**だから。
 * 出るのは更新の道中だけで、しかも紙（update.json）を書くのは C# のランチャなので、
 * 手で出そうとすると本物の更新を走らせるか紙を偽装するしかない。
 * 純関数に切り出した値打ちは、その手間なしに全分岐を通せることにある。
 *
 * 見るのは3点。
 *   1. 枝の順（上にあるものほど強い）が入れ替わっていないこと
 *   2. 鍵（key）の粒度。**閉じた帯を二度と出さなくする事故がここから出る**
 *   3. 押したときに走らせる仕事が、渡したものそのままであること
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerOf, isApplyFailure, OUTDATED } from '../public/js/update-banner.js';

/** 基準時刻。紙の changedAt はここからの相対で考える。 */
const NOW = Date.now();

/**
 * /api/update の応答を模して組む。
 *
 * 既定は「最新です」。枝ごとに要る鍵だけ上書きして渡す。
 *
 * @param {object} [over] 上書きする項目
 * @returns {object} loadUpdateState の戻りと同じ形（＋ canApply）
 */
function paper(over = {}) {
  return {
    state: 'none',
    label: '最新です',
    current: '0.9.1',
    available: null,
    requested: null,
    notes: null,
    checkedAt: NOW - 1000,
    changedAt: NOW - 1000,
    error: null,
    path: 'C:\\dummy\\update.json',
    canApply: true,
    ...over,
  };
}

/* ---------------------------------------------------------------- 出さない */

test('紙が無ければ帯は出ない', () => {
  assert.equal(bannerOf(null), null);
});

test('最新・確認していない・止めてある・つながらない は帯にしない', () => {
  // 確認できなかったことまで帯にすると、回線の細い日に毎回じゃまをする。
  // そちらは版の脇の印と --status に任せてある
  for (const state of ['none', 'idle', 'off', 'not-installed', 'unreachable', 'stale']) {
    assert.equal(bannerOf(paper({ state })), null, state);
  }
});

/* ------------------------------------------------------------------ 枝の順 */

test('諦めた（stuckAt）は、新しい版の知らせより強い', () => {
  const b = bannerOf(paper({ state: 'available', available: '0.9.2' }), { stuckAt: NOW });
  assert.equal(b.text, '更新の返事がありません');
  assert.equal(b.key, `stuck:${NOW}`);
  assert.equal(b.tone, 'warn');
  // 入れ替わっているかもしれないので、確かめ方まで書く
  assert.match(b.note, /--status/);
});

test('サーバーが古いことは、押した記憶より強い', () => {
  const b = bannerOf(OUTDATED, { pressed: true });
  assert.equal(b.key, 'outdated');
  assert.equal(b.text, 'このサーバーは古い版です');
  // 立ち上げ直すまで直らないので、閉じても覚えない
  assert.equal(b.keep, false);
  assert.equal(b.act, null);
});

/* ------------------------------------------------------------- 入れ替わった */

test('入れ替わったら、読み込み直す口を添える', () => {
  const reloadNow = () => 'reloaded';
  const b = bannerOf(paper({ state: 'done', changedAt: NOW }), { reloadNow });
  assert.equal(b.text, '入れ替えました（0.9.1）');
  assert.equal(b.act.label, '読み込み直す');
  // 配線が入れ替わっていないこと。ここを取り違えると押しても何も起きない
  assert.equal(b.act.run, reloadNow);
});

test('入れ替えましたは10分で黙る', () => {
  // done の紙は次の確認まで上書きされない（--restarted は確認しない）。
  // 期限が無いと翌朝の起動でも「入れ替えました」が出る
  assert.notEqual(bannerOf(paper({ state: 'done', changedAt: NOW - 599000 })), null);
  assert.equal(bannerOf(paper({ state: 'done', changedAt: NOW - 601000 })), null);
});

test('changedAt が読めない done は、期限では消さない', () => {
  // 時刻が取れないことを「古い」と読み替えない。0 と不明を分ける決まりのここでの形
  const b = bannerOf(paper({ state: 'done', changedAt: null }));
  assert.equal(b.key, 'done:0');
});

/* --------------------------------------------------------------- 作業の道中 */

test('取り寄せ中と入れ替え中は、押せる口を出さない', () => {
  for (const state of ['downloading', 'applying']) {
    const b = bannerOf(paper({ state, requested: '0.9.2', changedAt: NOW }));
    assert.equal(b.tone, 'work', state);
    assert.equal(b.act, null, state);
    // 道中は次の紙で必ず変わるので、閉じても覚えない
    assert.equal(b.keep, false, state);
  }
});

test('取り寄せ中の版が読めなくても、待つことは伝える', () => {
  const b = bannerOf(paper({ state: 'downloading', requested: null }));
  assert.equal(b.text, '新しい版を取り寄せています');
  assert.match(b.note, /数分/);
});

/* ------------------------------------------------------- 当てにいって転んだ */

test('requested があるときだけ「当てにいって転んだ」と言える', () => {
  // 素の確認（CheckAsync）は requested を書かない。
  // 押した記憶に頼らないので、途中で読み込み直しても判定が残る
  assert.equal(isApplyFailure(paper({ state: 'failed', requested: '0.9.2' })), true);
  assert.equal(isApplyFailure(paper({ state: 'unreachable', requested: '0.9.2' })), true);
  assert.equal(isApplyFailure(paper({ state: 'failed', requested: null })), false);
  assert.equal(isApplyFailure(paper({ state: 'available', requested: '0.9.2' })), false);
});

test('転んだ帯は、いまの版で動いていることを必ず書き添える', () => {
  const applyNow = () => 'applied';
  const b = bannerOf(
    paper({ state: 'failed', label: '更新に失敗しました', requested: '0.9.2', error: '途中で切れました', changedAt: NOW }),
    { applyNow },
  );
  assert.equal(b.text, '更新に失敗しました');
  assert.equal(b.note, '途中で切れました。いまの版のまま動いています');
  assert.equal(b.act.label, 'もう一度');
  assert.equal(b.act.run, applyNow);
  assert.equal(b.key, `failed:${NOW}`);
});

test('理由が書かれていなくても、動いていることだけは言う', () => {
  const b = bannerOf(paper({ state: 'failed', label: '更新に失敗しました', requested: '0.9.2', error: null }));
  assert.equal(b.note, 'いまの版のまま動いています');
});

test('押せないなら、もう一度の口は出さない', () => {
  const b = bannerOf(
    paper({ state: 'failed', label: '更新に失敗しました', requested: '0.9.2', canApply: false }),
  );
  assert.equal(b.act, null);
});

test('転んだ帯の鍵は紙が動くたびに変わる', () => {
  // 同じ鍵だと、1度閉じたあとに2度目の失敗が黙って埋もれる
  const one = bannerOf(paper({ state: 'failed', requested: '0.9.2', changedAt: NOW }));
  const two = bannerOf(paper({ state: 'failed', requested: '0.9.2', changedAt: NOW + 1 }));
  assert.notEqual(one.key, two.key);
  assert.equal(one.keep, true);
});

/* ------------------------------------------------------------ 新しい版がある */

test('押せる知らせと押せない知らせで鍵を分ける', () => {
  // **これは実測で踏んだ形。** 手で立てた server.mjs の画面で
  // 「この起動の仕方では入れ替えられません」を閉じ、そのあとインストールした側から
  // 立て直して canApply が true になったのに、版が同じだから帯が出なかった。
  // 押せない知らせを閉じたことが、押せる知らせまで殺していた
  const can = bannerOf(paper({ state: 'available', available: '0.9.2', canApply: true }));
  const cant = bannerOf(paper({ state: 'available', available: '0.9.2', canApply: false }));
  assert.notEqual(can.key, cant.key);
  // 古い鍵（available:<版>）はどちらとも一致しない。
  // 押せない帯を閉じたまま埋もれていた人も1回だけ出直す
  assert.notEqual(can.key, 'available:0.9.2');
  assert.notEqual(cant.key, 'available:0.9.2');
});

test('押せるなら更新する口を、押せないなら入れ直し方を出す', () => {
  const applyNow = () => 'applied';
  const can = bannerOf(paper({ state: 'available', available: '0.9.2' }), { applyNow });
  assert.equal(can.text, '新しい版があります（0.9.2）');
  assert.equal(can.note, 'いまは 0.9.1');
  assert.equal(can.act.label, '更新する');
  assert.equal(can.act.run, applyNow);

  const cant = bannerOf(paper({ state: 'available', available: '0.9.2', canApply: false }), { applyNow });
  assert.equal(cant.act, null);
  assert.match(cant.note, /インストールした ClaudeDeck/);
});

test('版が読めない紙でも、新しい版があることは知らせる', () => {
  const b = bannerOf(paper({ state: 'available', available: null }));
  assert.equal(b.text, '新しい版があります');
  assert.equal(b.key, 'available-can:?');
});

test('いまの版が読めなければ、添え書きは空にする', () => {
  // 取れなかったものを埋めない
  const b = bannerOf(paper({ state: 'available', available: '0.9.2', current: null }));
  assert.equal(b.note, '');
});

/* --------------------------------------------------------- 押したあとの空白 */

test('押した直後は、更新するをもう一度出さない', () => {
  // 素通りさせると二度押しを誘う
  const b = bannerOf(paper({ state: 'available', available: '0.9.2' }), { pressed: true });
  assert.equal(b.key, 'starting');
  assert.equal(b.text, '更新を始めています');
  assert.equal(b.act, null);
});

test('押したのに最新だったときは、取り下げられていたと言う', () => {
  // ランチャは「新しい版は無かった」と判断して none を書いて終わることがある。
  // 黙って帯を消すと「押したのに何も起きなかった」になる
  const b = bannerOf(paper({ state: 'none' }), { pressed: true });
  assert.equal(b.key, 'pressed-none');
  assert.equal(b.text, '最新です');
});

test('押したあとに知らない状態が来たら、来た言い方をそのまま出す', () => {
  const b = bannerOf(
    paper({ state: 'unreachable', label: 'GitHub につながりませんでした', error: 'timeout', changedAt: NOW }),
    { pressed: true },
  );
  assert.equal(b.text, 'GitHub につながりませんでした');
  assert.equal(b.note, 'timeout');
  assert.equal(b.key, `pressed:unreachable:${NOW}`);
  assert.equal(b.keep, false);
});

/* ------------------------------------------------------------------ 形の約束 */

test('OUTDATED は /api/update の応答と同じ形をしている', () => {
  // 読む側（render / fillVersion）に分岐を増やさないため、鍵を欠かさない
  for (const key of Object.keys(paper())) {
    assert.ok(key in OUTDATED, `${key} が無い`);
  }
  // 版は入れない。埋めると古いサーバーの版を知っているように見える
  assert.equal(OUTDATED.current, null);
  assert.equal(OUTDATED.canApply, false);
});

test('OUTDATED は書き換えられない', () => {
  assert.throws(() => { OUTDATED.state = 'none'; }, TypeError);
});

test('出す帯はどれも key と keep を持っている', () => {
  // localStorage に覚える判断がこの2つだけで決まるので、欠けると閉じられない帯ができる
  const cases = [
    [paper({ state: 'available', available: '0.9.2' }), {}],
    [paper({ state: 'available', available: '0.9.2', canApply: false }), {}],
    [paper({ state: 'done', changedAt: NOW }), {}],
    [paper({ state: 'downloading' }), {}],
    [paper({ state: 'applying' }), {}],
    [paper({ state: 'failed', requested: '0.9.2' }), {}],
    [OUTDATED, {}],
    [paper({ state: 'available', available: '0.9.2' }), { pressed: true }],
    [paper({ state: 'none' }), { pressed: true }],
    [paper({ state: 'unreachable' }), { pressed: true }],
    [paper(), { stuckAt: NOW }],
  ];
  for (const [up, opts] of cases) {
    const b = bannerOf(up, opts);
    assert.ok(b, `${up.state} が帯にならない`);
    assert.equal(typeof b.key, 'string', up.state);
    assert.ok(b.key.length > 0, up.state);
    assert.equal(typeof b.keep, 'boolean', up.state);
  }
});

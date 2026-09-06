/**
 * 起こすときの既定値（`src/run/defaults.mjs`）。**判断だけを見る。**
 *
 * 紙の読み書き（`loadRunDefaults` / `saveRunDefaults`）は薄い殻なので触らない。
 * ここで固定するのは3つ。
 *
 *  - 壊れた紙・知らない語で落ちないこと（起こせなくならない）
 *  - **`bypassPermissions` が紙からは入らないこと**（環境変数の関門を迂回させない）
 *  - 知らないキーを消さないこと（同じ紙に通知の設定が入っている）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_DEFAULTS_EMPTY,
  parseRunDefaults,
  applyRunDefaults,
  mergeRunDefaults,
} from '../src/run/defaults.mjs';
import { BUDGET_MIN_USD, BUDGET_MAX_USD } from '../src/run/spec.mjs';

/** 紙の形を1つ作る */
function file(defaults) {
  return { run: { defaults } };
}

test('何も無ければ全部「指定なし」', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { run: 'x' }, file('x'), file(null)]) {
    assert.deepEqual(parseRunDefaults(bad), RUN_DEFAULTS_EMPTY, `落ちた: ${JSON.stringify(bad)}`);
  }
});

test('揃っていれば全部読む', () => {
  assert.deepEqual(parseRunDefaults(file({
    permissionMode: 'auto',
    model: 'claude-opus-5',
    effort: 'high',
    budgetUsd: 12.5,
  })), {
    permissionMode: 'auto',
    model: 'claude-opus-5',
    effort: 'high',
    budgetUsd: 12.5,
  });
});

test('bypassPermissions は紙に書いてあっても読まない', () => {
  // 環境変数（CLAUDE_DECK_RUN_ALLOW_BYPASS）という関門を、紙で迂回させない。
  // **設定ファイルを1行足すだけで最も危険なモードが既定になる**道を作らない
  assert.equal(parseRunDefaults(file({ permissionMode: 'bypassPermissions' })).permissionMode, null);
  assert.equal(applyRunDefaults(RUN_DEFAULTS_EMPTY, { permissionMode: 'bypassPermissions' }).permissionMode, null);
});

test('知らない語は「指定なし」に倒す', () => {
  const got = parseRunDefaults(file({ permissionMode: 'zzz', effort: 'ultra', model: '--evil' }));
  assert.equal(got.permissionMode, null);
  assert.equal(got.effort, null);
  assert.equal(got.model, null, 'フラグに見える文字列を argv へ運ばせない');
});

test('予算は範囲へ丸める。「指定なし」に倒さない', () => {
  // 倒すと $100 と書いた人の意図（上限を掛けたい）が「上限なし」に化ける。
  // 逆向きに間違えるほうが危ない
  assert.equal(parseRunDefaults(file({ budgetUsd: 9999 })).budgetUsd, BUDGET_MAX_USD);
  assert.equal(parseRunDefaults(file({ budgetUsd: 0.0001 })).budgetUsd, BUDGET_MIN_USD);
  // 数でない・0以下は「指定なし」。上限として意味を成さない
  for (const v of [0, -5, 'x', NaN, Infinity, null, '']) {
    assert.equal(parseRunDefaults(file({ budgetUsd: v })).budgetUsd, null, `${v} が数として通った`);
  }
});

test('予算は浮動小数のごみを残さない', () => {
  assert.equal(parseRunDefaults(file({ budgetUsd: 0.1 + 0.2 })).budgetUsd, 0.3);
});

test('文字列で来た数も読む', () => {
  // 画面の <input type="number"> は文字列で送ってくる
  assert.equal(parseRunDefaults(file({ budgetUsd: ' 12.5 ' })).budgetUsd, 12.5);
});

test('重ねるとき、キーの無いものは触らない', () => {
  const cur = parseRunDefaults(file({ permissionMode: 'auto', budgetUsd: 5 }));
  const next = applyRunDefaults(cur, { effort: 'max' });
  assert.equal(next.permissionMode, 'auto', '送っていない項目が消えた');
  assert.equal(next.budgetUsd, 5, '送っていない項目が消えた');
  assert.equal(next.effort, 'max');
});

test('空文字と null は「消す」', () => {
  // 画面の欄を空にしたときに来るのが空文字。両方を同じ意味にしないと
  // 「消したのに消えない」になる
  const cur = parseRunDefaults(file({ permissionMode: 'auto', effort: 'high', budgetUsd: 5 }));
  assert.equal(applyRunDefaults(cur, { budgetUsd: '' }).budgetUsd, null);
  assert.equal(applyRunDefaults(cur, { effort: '' }).effort, null);
  assert.equal(applyRunDefaults(cur, { permissionMode: null }).permissionMode, null);
});

test('重ねる相手が壊れていても落ちない', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(applyRunDefaults(RUN_DEFAULTS_EMPTY, bad), RUN_DEFAULTS_EMPTY);
  }
});

test('書き戻しても知らないキーは残る', () => {
  // 同じ紙に通知の設定と、起こしてよいフォルダが入っている
  const got = mergeRunDefaults(
    { notify: { on: true }, run: { dirs: ['C:/a'] }, future: 1 },
    { permissionMode: 'auto', model: null, effort: null, budgetUsd: null },
  );
  assert.deepEqual(got.notify, { on: true });
  assert.deepEqual(got.run.dirs, ['C:/a']);
  assert.equal(got.future, 1);
  assert.deepEqual(got.run.defaults, { permissionMode: 'auto' });
});

test('「指定なし」はキーごと書かない', () => {
  // 残すと、紙を読んだ人が「わざわざ null を指定してある」と読める
  const got = mergeRunDefaults(file({ effort: 'max', budgetUsd: 3 }), {
    permissionMode: null, model: null, effort: 'high', budgetUsd: null,
  });
  assert.deepEqual(got.run.defaults, { effort: 'high' });
});

test('全部「指定なし」なら、空のかたまりを紙に残さない', () => {
  const got = mergeRunDefaults({ run: { dirs: ['C:/a'], defaults: { effort: 'max' } } }, RUN_DEFAULTS_EMPTY);
  assert.deepEqual(got.run, { dirs: ['C:/a'] });
});

test('書き戻しは、こちらの知らないキーも defaults の中で残す', () => {
  // 版が上がって項目が増えたとき、古い版で保存しても新しい項目を落とさない
  const got = mergeRunDefaults(file({ effort: 'max', futureKey: 'x' }), {
    ...RUN_DEFAULTS_EMPTY, effort: 'low',
  });
  assert.deepEqual(got.run.defaults, { effort: 'low', futureKey: 'x' });
});

test('読んで書き戻すと同じ形に落ち着く', () => {
  const src = { notify: { on: true }, run: { dirs: ['C:/a'], defaults: { permissionMode: 'auto', budgetUsd: 7 } } };
  const once = mergeRunDefaults(src, parseRunDefaults(src));
  const twice = mergeRunDefaults(once, parseRunDefaults(once));
  assert.deepEqual(twice, once);
});

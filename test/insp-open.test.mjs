/**
 * 右の紙（インスペクタ）を開いて始めるか（`public/js/insp-open.js`）。
 *
 * import ゼロの純関数なので Node から呼べる（`groups.js` / `next-step.js` と同じ形）。
 * 画面刷新④の D10・D12 の決め。
 *
 * - **URL（`?insp=usage|basics`）が先。** 配ったブックマークを切らない。覚えた開閉より強い
 * - URL が無ければ、**広い窓（1281px 以上）は覚えた開閉**（既定は開く）、
 *   **それより狭い窓は閉じて始める**（覚えた値を見ない）
 * - `?insp=out` は中央の「成果」へ読み替える URL なので、右の紙の指定としては読まない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initialInspector, inspQueryValue, INSPECTOR_TABS, INSP_DEFAULT_TAB, INSP_WIDE_QUERY,
} from '../public/js/insp-open.js';

test('URL で開く紙を指定したら、覚えた開閉と窓の広さより URL を守る', () => {
  for (const insp of ['usage', 'basics']) {
    for (const stored of [null, '0', '1']) {
      for (const wide of [true, false]) {
        assert.equal(initialInspector({ insp, stored, wide }), insp, `${insp} / ${stored} / ${wide}`);
      }
    }
  }
});

test('広い窓は覚えた開閉に従う。覚えていなければ開く', () => {
  assert.equal(initialInspector({ insp: null, stored: null, wide: true }), INSP_DEFAULT_TAB);
  assert.equal(initialInspector({ insp: null, stored: '1', wide: true }), INSP_DEFAULT_TAB);
  assert.equal(initialInspector({ insp: null, stored: '0', wide: true }), null);
  // 人が書き換えられる場所なので、知らない値は「閉じた」と読まない（既定の開くへ落とす）
  assert.equal(initialInspector({ insp: null, stored: 'yes', wide: true }), INSP_DEFAULT_TAB);
});

test('狭い窓（1280px 以下）は覚えた値に関わらず閉じて始める', () => {
  // 開くと中央が削られて読めなくなる（一覧と紙を両方開くと中央は約400px）
  for (const stored of [null, '0', '1']) {
    assert.equal(initialInspector({ insp: null, stored, wide: false }), null, `stored=${stored}`);
  }
});

test('知らない ?insp= の値と ?insp=out は、右の紙の指定として読まない', () => {
  // out は中央の「成果」タブへ読み替える URL（store.js の initialDetailTab）
  for (const insp of ['out', 'nope', '', undefined]) {
    assert.equal(initialInspector({ insp, stored: null, wide: true }), INSP_DEFAULT_TAB, `insp=${insp}`);
    assert.equal(initialInspector({ insp, stored: null, wide: false }), null, `insp=${insp}`);
  }
});

test('出せる紙は数値（usage）と診断（basics）の2つ。id は配った URL のまま', () => {
  // ?insp=basics は v0.6.0 で配っている。名前を変えるとブックマークが切れる
  assert.deepEqual([...INSPECTOR_TABS].sort(), ['basics', 'usage']);
  assert.equal(INSP_DEFAULT_TAB, 'usage');
});

test('広い窓の境目は 1281px。狭い窓のボトムシート（860px 以下）より広い', () => {
  assert.equal(INSP_WIDE_QUERY, '(min-width: 1281px)');
  const narrow = fs.readFileSync(fileURLToPath(new URL('../public/css/narrow.css', import.meta.url)), 'utf8');
  const m = narrow.match(/@media \(max-width: (\d+)px\)/);
  assert.ok(m, 'narrow.css の境目が読めない');
  assert.ok(Number(m[1]) < 1281, `ボトムシートの境目（${m[1]}px）が広い窓の境目以上になっている`);
});

test('URL に書くのは既定でない紙（診断）だけ。既定の紙（数値）と閉じているときは書かない', () => {
  // 広い窓では紙が最初から開くので、開いている紙をそのまま書くと ?insp=usage が常に付き、
  // その URL を控えると「閉じた」を覚えていても開いて始まる（URL は覚えた開閉より強い）
  assert.equal(inspQueryValue('usage'), null);
  assert.equal(inspQueryValue(INSP_DEFAULT_TAB), null);
  assert.equal(inspQueryValue('basics'), 'basics');
  assert.equal(inspQueryValue(null), null);
  assert.equal(inspQueryValue('nope'), null);
  assert.equal(inspQueryValue(), null);
  // 書いた値は読む側で同じ紙に戻る（狭い窓でも・閉じたのを覚えていても）
  assert.equal(initialInspector({ insp: inspQueryValue('basics'), stored: '0', wide: false }), 'basics');
  // 読む側は今どおり usage / basics を受ける（配ったブックマークを切らない）
  assert.equal(initialInspector({ insp: 'usage', stored: '0', wide: false }), 'usage');
});

test('store.js の syncQuery は右の紙を inspQueryValue を通して書く', () => {
  const store = fs.readFileSync(fileURLToPath(new URL('../public/js/store.js', import.meta.url)), 'utf8');
  assert.match(store, /set\('insp', work \? inspQueryValue\(store\.inspector\) : null\)/,
    'syncQuery が開いている紙をそのまま ?insp= に書いている');
});

test('入ってきた値を書き換えない・引数が無くても落ちない', () => {
  assert.equal(initialInspector(), null);
  const arg = Object.freeze({ insp: null, stored: null, wide: true });
  assert.doesNotThrow(() => initialInspector(arg));
});

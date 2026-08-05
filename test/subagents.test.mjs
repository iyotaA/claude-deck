/**
 * サブエージェントの突き合わせのテスト。
 *
 * ここで守りたいのは2つ。
 * 入れ子の記録を「呼び出しが見つからないから」と消さないこと。
 * そして取れなかったものを 0 と書かないこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinSubagents } from '../src/view/subagent.mjs';
import { T0 } from './helpers.mjs';

/** 親ログの Agent 呼び出し1件ぶん。digest.agents に入る形 */
function item(over = {}) {
  return {
    kind: 'agent',
    at: T0,
    toolUseId: 't1',
    agentId: 'a1',
    agentType: 'Explore',
    description: '親ログ側の指示',
    status: 'completed',
    durationMs: 12_000,
    tokens: 3400,
    toolUseCount: 7,
    reportChars: 4200,
    ...over,
  };
}

/** ディスクの記録1件ぶん。listSubagents が返す形 */
function ref(over = {}) {
  return {
    agentId: 'a1',
    file: 'C:\\x\\subagents\\agent-a1.jsonl',
    size: 357 * 1024,
    mtimeMs: T0 + 30_000,
    agentType: 'Explore',
    description: 'メタ側の指示',
    toolUseId: 't1',
    spawnDepth: 1,
    model: null,
    parentAgentId: null,
    ...over,
  };
}

test('toolUseId で呼び出しと記録を結ぶ', () => {
  const { items } = joinSubagents([item()], [ref()]);
  assert.equal(items.length, 1);
  assert.equal(items[0].linked, true);
  // 呼び出し側にしか無い値が乗る
  assert.equal(items[0].durationMs, 12_000);
  assert.equal(items[0].reportChars, 4200);
  assert.equal(items[0].log.exists, true);
});

test('toolUseId が無ければ agentId で結ぶ', () => {
  // 非同期起動だと呼び出し時点の情報しか無く、toolUseId が .meta.json 側に無いこともある
  const { items } = joinSubagents([item()], [ref({ toolUseId: null })]);
  assert.equal(items[0].linked, true);
  assert.equal(items[0].agentId, 'a1');
});

test('同じ項目は結ぶのは1件だけで、記録ごとに使い回さない', () => {
  const refs = [ref({ agentId: 'a1' }), ref({ agentId: 'a2', toolUseId: null })];
  const { items, counts } = joinSubagents([item()], refs);
  // 記録は2件あるが呼び出しは1件。2件目に同じ呼び出しの数字を貼ると、
  // 所要時間や報告の長さが二重に出てしまう
  assert.equal(items.length, 2);
  assert.equal(items.filter((i) => i.linked).length, 1);
  assert.equal(counts.unlinked, 1);
});

test('呼び出しに結びつかない記録も残す', () => {
  // 深さ2以上の toolUseId は親ログに無い（親サブエージェントのログの中にある）。
  // 呼び出しを軸にすると入れ子の記録が丸ごと消える
  const { items, counts } = joinSubagents([], [ref({ agentId: 'deep', toolUseId: 'tX', spawnDepth: 2 })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].linked, false);
  assert.equal(items[0].spawnDepth, 2);
  assert.equal(items[0].log.exists, true);
  assert.equal(counts.unlinked, 1);
});

test('記録のファイルが無い呼び出しも行として出す', () => {
  const { items, counts } = joinSubagents([item()], []);
  assert.equal(items.length, 1);
  assert.equal(items[0].log.exists, false);
  // 大きさは「不明」。0 と書くと空のファイルがあるように見える
  assert.equal(items[0].log.size, null);
  assert.equal(counts.missingLog, 1);
  assert.equal(counts.withLog, 0);
});

test('同じ項目が取れるならディスク側の値を先に採る', () => {
  // 非同期起動の結果は呼び出し時点の情報しか持たない。.meta.json のほうが当たる
  const { items } = joinSubagents([item({ agentType: 'claude' })], [ref()]);
  assert.equal(items[0].agentType, 'Explore');
  assert.equal(items[0].description, 'メタ側の指示');
});

test('時刻の無い記録はログの更新時刻で並べる', () => {
  const refs = [
    ref({ agentId: 'late', toolUseId: null, mtimeMs: T0 + 90_000 }),
    ref({ agentId: 'early', toolUseId: null, mtimeMs: T0 + 10_000 }),
  ];
  const { items } = joinSubagents([], refs);
  // at が取れない行を最後にまとめると、実際の順番と食い違って読めなくなる
  assert.deepEqual(items.map((i) => i.agentId), ['early', 'late']);
});

test('数え上げに「実行中」を作らない', () => {
  const agents = [
    item({ agentId: 'a1', toolUseId: 't1', status: 'completed' }),
    item({ agentId: 'a2', toolUseId: 't2', status: 'launched' }),
    item({ agentId: 'a3', toolUseId: 't3', status: null }),
  ];
  const refs = [ref({ agentId: 'a1', toolUseId: 't1' }), ref({ agentId: 'a2', toolUseId: 't2' })];
  const { counts } = joinSubagents(agents, refs);

  assert.equal(counts.total, 3);
  assert.equal(counts.withLog, 2);
  assert.equal(counts.missingLog, 1);
  // 終わったセッションの記録を見ているのに「実行中」と書くと嘘になる。
  // 起動しか分かっていないものは launched のまま置き、取れないものは unknown にする
  assert.deepEqual(counts.byStatus, { completed: 1, launched: 1, unknown: 1 });
});

test('材料が何も無ければ空で返す', () => {
  const { items, counts } = joinSubagents([], []);
  assert.deepEqual(items, []);
  assert.equal(counts.total, 0);
  assert.deepEqual(counts.byStatus, {});
});

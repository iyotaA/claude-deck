/**
 * 一覧に出す情報をログの末尾から拾う処理のテスト。
 *
 * Claude Code が書く type は公開仕様ではないので、
 * 実測で分かっている形（ai-title / last-prompt / permission-mode / mode）をここで固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMeta } from '../src/parse/meta.mjs';
import { T0, at, say, call, prompt } from './helpers.mjs';

test('専用の行からタイトルと直近の指示を拾う', () => {
  const meta = extractMeta([
    { type: 'ai-title', aiTitle: '  構成のリファクタリング  ' },
    { type: 'last-prompt', lastPrompt: '構成を\n整理して' },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'mode', mode: 'bypassPermissions' },
  ]);
  assert.equal(meta.title, '構成のリファクタリング');
  // 改行は空白に潰して一行にする
  assert.equal(meta.lastPrompt, '構成を 整理して');
  assert.equal(meta.permissionMode, 'plan');
  assert.equal(meta.mode, 'bypassPermissions');
});

test('タイトルが空文字だけの行は無視する', () => {
  const meta = extractMeta([
    { type: 'ai-title', aiTitle: '本物のタイトル' },
    { type: 'ai-title', aiTitle: '   ' },
  ]);
  assert.equal(meta.title, '本物のタイトル');
});

test('作業場所やバージョンはどの行からでも拾う', () => {
  const meta = extractMeta([
    { ...prompt('やって'), cwd: 'C:\\work\\deck', version: '2.1.0', gitBranch: 'main', slug: 'deck-refactor' },
  ]);
  assert.equal(meta.cwd, 'C:\\work\\deck');
  assert.equal(meta.version, '2.1.0');
  assert.equal(meta.gitBranch, 'main');
  assert.equal(meta.slug, 'deck-refactor');
});

test('後ろの行が前の行を上書きする（末尾がいまの状態）', () => {
  const meta = extractMeta([
    { ...prompt('前'), gitBranch: 'feature/a' },
    { ...prompt('後', { ms: 100 }), gitBranch: 'feature/b' },
  ]);
  assert.equal(meta.gitBranch, 'feature/b');
});

test('モデルと文脈量は assistant の行から拾う', () => {
  const entry = say('うん');
  entry.message.model = 'claude-opus-5';
  entry.message.usage = {
    input_tokens: 1000,
    cache_read_input_tokens: 20000,
    cache_creation_input_tokens: 500,
  };
  entry.effort = 'high';

  const meta = extractMeta([entry]);
  assert.equal(meta.model, 'claude-opus-5');
  assert.equal(meta.effort, 'high');
  // 直近リクエストの入力量。キャッシュ読み出しも文脈を抱えている量に含める
  assert.equal(meta.contextTokens, 21500);
});

test('usage の一部が欠けていても落ちない', () => {
  const entry = say('うん');
  entry.message.usage = { input_tokens: 300 };
  assert.equal(extractMeta([entry]).contextTokens, 300);

  const zero = say('うん');
  zero.message.usage = {};
  assert.equal(extractMeta([zero]).contextTokens, null);
});

test('サブエージェントの発言からはモデルを拾わない', () => {
  const sub = say('サブの発言');
  sub.message.model = 'claude-haiku-4-5';
  sub.isSidechain = true;
  sub.cwd = 'C:\\work\\deck';

  const meta = extractMeta([sub]);
  assert.equal(meta.model, null);
  assert.equal(meta.lastAssistantText, null);
  // 作業場所はサブエージェントの行にも正しく入っているので拾ってよい
  assert.equal(meta.cwd, 'C:\\work\\deck');
});

test('直近の発言と直近の指示を別々に持つ', () => {
  const meta = extractMeta([
    prompt('最初の指示'),
    say('一つ目の返事', { ms: 100 }),
    prompt('二つ目の指示', { ms: 200 }),
    say('二つ目の返事', { ms: 300 }),
  ]);
  assert.equal(meta.lastUserPrompt, '二つ目の指示');
  assert.equal(meta.lastAssistantText, '二つ目の返事');
});

test('長い発言と指示は詰める', () => {
  const meta = extractMeta([prompt('あ'.repeat(300)), say('い'.repeat(300), { ms: 100 })]);
  assert.equal(meta.lastUserPrompt.length, 240);
  assert.ok(meta.lastUserPrompt.endsWith('…'));
  assert.equal(meta.lastAssistantText.length, 240);
});

test('ツール結果の行は指示として拾わない', () => {
  const meta = extractMeta([
    prompt('これやって'),
    { type: 'user', timestamp: at(100), message: { role: 'user', content: [] }, toolUseResult: { stdout: 'ok' } },
  ]);
  assert.equal(meta.lastUserPrompt, 'これやって');
});

test('同じスキルが何度も出たら最後の1回だけ残す', () => {
  const meta = extractMeta([
    call('Skill', { skill: 'pr-review', args: '1234' }, { id: 's1', ms: 0 }),
    call('Skill', { skill: 'fix-review' }, { id: 's2', ms: 100 }),
    call('Skill', { skill: 'pr-review', args: '1234' }, { id: 's3', ms: 200 }),
  ]);
  assert.deepEqual(meta.skills.map((s) => s.skill), ['pr-review', 'fix-review']);
  // 残るのは最後に出たときの時刻
  assert.equal(meta.skills[0].at, T0 + 200);
  assert.equal(meta.skills[1].args, null);
});

test('スキルは末尾の4件までにする', () => {
  const entries = [];
  for (let i = 0; i < 6; i += 1) {
    entries.push(call('Skill', { skill: `skill-${i}` }, { id: `s${i}`, ms: i }));
  }
  assert.deepEqual(
    extractMeta(entries).skills.map((s) => s.skill),
    ['skill-2', 'skill-3', 'skill-4', 'skill-5'],
  );
});

test('スラッシュコマンドもスキルとして数える', () => {
  const meta = extractMeta([
    prompt('<command-name>/pr-review</command-name>\n<command-args>1234</command-args>'),
  ]);
  // 先頭の / は落として、スキル名と同じ並びで見せる
  assert.deepEqual(meta.skills.map((s) => [s.skill, s.args]), [['pr-review', '1234']]);
});

test('サブエージェントの呼び出しを記録する', () => {
  const meta = extractMeta([
    call('Agent', { subagent_type: 'general-purpose', description: 'CSS を調査' }, { id: 'g1' }),
    call('Task', { description: '別名でも同じ扱い' }, { id: 'g2', ms: 100 }),
  ]);
  assert.deepEqual(meta.agents.map((a) => [a.type, a.description]), [
    ['general-purpose', 'CSS を調査'],
    [null, '別名でも同じ扱い'],
  ]);
  assert.equal(meta.agents[0].at, T0);
});

test('Claude の中間報告と、その時刻を拾う', () => {
  const meta = extractMeta([
    { type: 'system', subtype: 'away_summary', timestamp: at(100), content: '古い報告' },
    {
      type: 'system',
      subtype: 'away_summary',
      timestamp: at(200),
      content: 'テストを通して\nコミットしました (disable recaps in /config)',
    },
  ]);
  // 後ろの行がいまの状態。断り書きは落として、本文は一行に詰める
  assert.equal(meta.recap, 'テストを通して コミットしました');
  assert.equal(meta.recapAt, T0 + 200);
});

test('中間報告の行からも作業場所やバージョンを拾える', () => {
  const meta = extractMeta([
    {
      type: 'system',
      subtype: 'away_summary',
      timestamp: at(0),
      content: '進捗の報告',
      cwd: 'C:\\work\\deck',
      version: '2.1.0',
    },
  ]);
  // 中間報告を switch の case で処理すると、ここが飛ばされて null になる
  assert.equal(meta.cwd, 'C:\\work\\deck');
  assert.equal(meta.version, '2.1.0');
  assert.equal(meta.recap, '進捗の報告');
});

test('空のログでも形の揃った結果を返す', () => {
  const meta = extractMeta([]);
  assert.equal(meta.title, null);
  assert.equal(meta.recap, null);
  assert.equal(meta.recapAt, null);
  assert.equal(meta.cwd, null);
  assert.equal(meta.contextTokens, null);
  assert.deepEqual(meta.skills, []);
  assert.deepEqual(meta.agents, []);
});

test('知らない type の行が混ざっても落ちない', () => {
  const meta = extractMeta([
    { type: 'まだ知らない種類', なにか: true },
    null,
    { ...prompt('やって'), cwd: 'C:\\work' },
  ]);
  assert.equal(meta.cwd, 'C:\\work');
  assert.equal(meta.lastUserPrompt, 'やって');
});

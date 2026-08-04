/**
 * Claude Code がローカルへ出力するデータの場所を解決する。
 *
 * ここで参照しているのは Claude Code の内部データ形式であり、公開された API ではない。
 * バージョンが上がると変わりうるため、呼び出し側は「無ければ無いで進む」前提で扱うこと。
 * このモジュール以下、~/.claude 配下へ書き込む処理は一切持たせない（読み取り専用）。
 */
import os from 'node:os';
import path from 'node:path';

/** ~/.claude。CLAUDE_CONFIG_DIR が設定されていればそちらを優先する。 */
export const configDir = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(os.homedir(), '.claude');

/** 稼働中セッションの登録簿。<PID>.json が並ぶ。 */
export const sessionsDir = path.join(configDir, 'sessions');

/** 会話ログ。<スラッグ化した cwd>/<セッションID>.jsonl が並ぶ。 */
export const projectsDir = path.join(configDir, 'projects');

/** TODO の状態。<セッションID>/ が並ぶ。 */
export const tasksDir = path.join(configDir, 'tasks');

/** プランファイル。 */
export const plansDir = path.join(configDir, 'plans');

/** 全セッション横断の入力ログ。 */
export const historyFile = path.join(configDir, 'history.jsonl');

/**
 * cwd から projects 配下のディレクトリ名を作る。
 *
 * 英数字以外をすべて `-` に置き換える規則。
 * 例: C:\Users\me\work -> C--Users-me-work
 *
 * ただしこの変換は不可逆（`_` と `-` と `\` が同じ `-` になる）。
 * スラッグからパスを復元してはいけない。cwd は登録簿とログの各行から直接取ること。
 */
export function slugifyCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

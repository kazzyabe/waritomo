# 開発ルール

## 実装は worktree で行う

- ファイルを変更する作業は、規模を問わずすべて git worktree 上で行う。
  1行修正・typo 修正も例外ではない。
- main の working tree は常にクリーンに保つ。main のチェックアウト先で
  直接 Edit / Write / sed による書き換えを行わない。
- 手順:
  1. 実装開始時に worktree を作成する（`EnterWorktree` ツール、
     無ければ `git worktree add ../waritomo-<branch> -b <branch>`）
  2. その worktree 内で実装と動作確認を行う
  3. 完了後に main へマージ、または PR を作成する
  4. マージ後に worktree を削除する（`git worktree remove`）
- 対象外: リポジトリ外のファイル（計画ファイル、メモリ、スクラッチパッド）。
  読み取りのみの調査も worktree を作る必要はない。

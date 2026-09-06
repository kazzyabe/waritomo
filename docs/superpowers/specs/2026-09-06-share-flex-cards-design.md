# 招待・精算シェアメッセージのFlex化

## 背景

ワリトモの招待/精算共有は`liff.shareTargetPicker()`にプレーンテキストを渡すのみで、LINEのトーク上では地味な見た目になっている。プロダクトの成長は招待リンクを介したバイラル拡散（幹事が複数人を巻き込む）に依存するため、シェアされた瞬間の見た目を強化する。

## スコープ

- 対象: 招待メッセージ・精算結果メッセージの2つ（`public/index.html`の`shareInvite` / `shareSettlement`）。
- 対象外: 支払い請求メッセージ（`requestPayment`）、OGPメタタグ、未参加者向けプレビュー画面、次の旅行への導線、画像/写真素材、サーバー側API変更。これらは別スコープとして扱う。
- 絵文字は使わない（色・図形・タイポグラフィのみで構成する）。

## コンポーネント

いずれも`public/index.html`内の純粋関数として追加する。既存の`inviteText(link)` / `settlementText(link)`はそのまま残し、`altText`とクリップボードフォールバック用に再利用する（表示文言の二重管理をしない）。

### `buildInviteFlexBubble(link)`

招待メッセージ用。デザイン案「B」（メンバーのアバター強調）を採用。

- ヘッダー: 背景色`#1878b8`、白文字でグループ名（`state.groupName`）。
- ボディ:
  - 既存メンバー一覧（`state.members`）を、既存の`memberTone(member.id)`と同じ色トーンでイニシャルバッジ表示（Flexの`box`に`cornerRadius`を大きく指定して円形に近似し、`flex: 0`を指定して横並びの親boxに伸縮されないようにする）。メンバー数が多い場合は先頭6人＋「ほかN人」のテキストで打ち切る。
  - 「参加する」という短い案内テキスト。
- フッター: `uri`アクション付きの`button`。ラベル「参加する」、リンク先は招待permanent link（引数の`link`）。

### `buildSettlementFlexBubble(link)`

精算結果メッセージ用。デザイン案「A」（金額と内訳）を採用。

- ヘッダー: 背景色`#06c755`、白文字で「ワリトモ・精算」。
- ボディ:
  - グループ名（小さめ、グレー）。
  - 合計金額（`yen(totalExpenses())`、大きく太字）。
  - 精算内訳（`settlement.items`）を最大5件、`from → to 金額`の行で表示。6件以上ある場合は6件目以降を「ほかN件」の1行にまとめる。0件の場合は「清算は不要です」を表示する（既存`settlementText`と同じ分岐）。
- フッター: `uri`アクションの`button`。ラベル「開いて確認する」、リンク先は`link`。

## データフロー

`shareInvite()` / `shareSettlement()`内の`liff.shareTargetPicker([{ type: "text", text }])`呼び出しを、以下に差し替える。

```js
liff.shareTargetPicker([
  {
    type: "flex",
    altText: flexAltText(text), // 既存のinviteText(link) / settlementText(link)の戻り値をLINEのaltText上限(400文字)に丸めたもの
    contents: buildInviteFlexBubble(link), // or buildSettlementFlexBubble(link)
  },
]);
```

`flexAltText(text)`は`text.length > 400 ? text.slice(0, 400) : text`という単純な丸め関数。`settlementText(link)`は精算内訳の件数分だけ行が伸びる（打ち切りなし）ため、Flexメッセージの`altText`に使う際にLINEの400文字上限を超える可能性があり、それを防ぐために追加した。クリップボードコピー用のフォールバック（`copyText(text)`）は丸めていない元の`text`をそのまま使う。

新規のサーバー呼び出しやスキーマ変更はなく、データソースは既存のクライアント状態（`state.members` / `state.groupName` / `settlement.items`）のみ。

## エラーハンドリング

- `liff.isApiAvailable("shareTargetPicker")`が偽、または`shareTargetPicker`が例外を投げた場合の挙動は変更しない。既存どおりクリップボードコピー（プレーンテキスト）にフォールバックする。
- Flex bubble構築関数自体は純粋な同期関数（例外を投げるI/Oを含まない）とし、失敗時のフォールバック処理を新設する必要はない。
- `altText`はLINEのFlexメッセージ仕様上400文字の上限があるため、`flexAltText(text)`で丸めてから渡す（上記データフロー参照）。

## 公式アカウントとの関係（確認事項の記録）

`shareTargetPicker`はユーザー自身がメッセージを転送する形の送信であり、LINE公式アカウント（Bot）は不要。公式アカウントが必要になるのは`docs/line-mini-app.md`記載の「Service Messages」（roadmap Phase5、能動的なプッシュ通知）のみで、本スコープには含まない。

## テスト

`public/index.html`のフロントエンドJSは現状ユニットテスト対象外（`test/`配下はサーバー・DB系のみ）。本変更でも自動テストは追加せず、以下の手動確認を行う。

- ローカル起動（`HOST=127.0.0.1 PORT=4312 npm run start`）し、`buildInviteFlexBubble` / `buildSettlementFlexBubble`の戻り値をブラウザのコンソールで直接呼び出し、LINEのFlex Message仕様（`type`, `box`, `text`, `button`のプロパティ）に沿った構造になっているか目視確認する。
- メンバー0人・6人以上、精算0件・6件以上の境界ケースで打ち切り表示（「ほかN人」「ほかN件」）が正しく出るか確認する。
- 可能であればLINEミニアプリのレビュー環境/実機トークで実際の表示を確認する。

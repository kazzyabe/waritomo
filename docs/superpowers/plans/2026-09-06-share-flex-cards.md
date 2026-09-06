# 招待・精算シェアメッセージのFlex化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `public/index.html`の招待・精算シェアメッセージを、`liff.shareTargetPicker`に渡すプレーンテキストからLINEのFlex Messageに差し替え、シェアされた瞬間の見た目を強化する。

**Architecture:** 既存の`inviteText(link)` / `settlementText(link)`は`altText`とクリップボードフォールバック用にそのまま残す。新規に`buildInviteFlexBubble(link)` / `buildSettlementFlexBubble(link)`という2つの純粋関数を追加し、`shareInvite()` / `shareSettlement()`内の`shareTargetPicker`呼び出しの`messages`引数だけを差し替える。バックエンド・スキーマ変更なし。絵文字は使わない。

**Tech Stack:** バニラJS（`public/index.html`内のインラインscript）、LINE LIFF SDK（`liff.shareTargetPicker`）、LINE Flex Message仕様。

参照設計書: `docs/superpowers/specs/2026-09-06-share-flex-cards-design.md`

---

## 前提知識（既存コードの参照点）

- `colors`（1758行目付近）: `["#157f35", "#2171b8", "#147b74", "#2b63d4", "#1a7d58", "#167795"]` — メンバーアバターの色。CSSの`--tone-0`〜`--tone-5`と対応。
- `memberTone(memberId)`（2310行目付近）: メンバーIDから`colors`配列のインデックス（0〜5）を返す。
- `initials(name)`（2315行目付近）: 表示名から先頭2文字を返す。
- `yen(value)`（2052行目付近）: 数値を`¥1,234`形式の文字列にフォーマット。
- `totalExpenses()`（2319行目付近）: `state.expenses`の合計金額を返す。
- `state.members`: `{ id, name, ... }`の配列。
- `settlement.items`: `{ fromMemberId, toMemberId, amount, ... }`の配列（`refreshSettlement()`で更新される）。
- `inviteText(link)` / `settlementText(link)`（3501行目・3561行目付近）: 既存のプレーンテキスト生成関数。そのまま残す。
- `shareInvite()` / `shareSettlement()`（3527行目・3569行目付近）: `liff.shareTargetPicker([{ type: "text", text }])`を呼んでいる箇所。ここを変更する。

---

### Task 1: `buildInviteFlexBubble` の追加

**Files:**
- Modify: `public/index.html`（`inviteText`関数の直前、3561行目付近に新規関数を追加）

- [ ] **Step 1: 関数を追加する**

`function inviteText(link) {` の直前に以下を追加する。

```js
      function inviteMemberAvatarBox(member) {
        return {
          type: "box",
          layout: "vertical",
          width: "28px",
          height: "28px",
          cornerRadius: "14px",
          backgroundColor: colors[memberTone(member.id)],
          justifyContent: "center",
          alignItems: "center",
          contents: [
            {
              type: "text",
              text: initials(member.name),
              color: "#ffffff",
              size: "xs",
              weight: "bold",
              align: "center",
              gravity: "center",
            },
          ],
        };
      }

      function buildInviteFlexBubble(link) {
        const shown = state.members.slice(0, 6);
        const overflowCount = state.members.length - shown.length;
        const avatarRow = {
          type: "box",
          layout: "horizontal",
          spacing: "xs",
          contents: shown.map(inviteMemberAvatarBox),
        };
        const bodyContents = [avatarRow];
        if (overflowCount > 0) {
          bodyContents.push({
            type: "text",
            text: `ほか${overflowCount}人`,
            size: "xs",
            color: "#767676",
            margin: "sm",
          });
        }
        bodyContents.push({
          type: "text",
          text: "リンクを開いて、自分の名前を選んでください。",
          size: "sm",
          color: "#3c3c3c",
          wrap: true,
          margin: "md",
        });

        return {
          type: "bubble",
          header: {
            type: "box",
            layout: "vertical",
            backgroundColor: "#1878b8",
            paddingAll: "16px",
            contents: [
              {
                type: "text",
                text: state.groupName || "ワリトモ",
                color: "#ffffff",
                weight: "bold",
                size: "md",
                wrap: true,
              },
            ],
          },
          body: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            paddingAll: "16px",
            contents: bodyContents,
          },
          footer: {
            type: "box",
            layout: "vertical",
            paddingAll: "12px",
            contents: [
              {
                type: "button",
                style: "link",
                height: "sm",
                action: { type: "uri", label: "参加する", uri: link },
              },
            ],
          },
        };
      }

```

- [ ] **Step 2: ブラウザで手動確認する**

サーバーを起動する。

```bash
HOST=127.0.0.1 PORT=4312 npm run start
```

ブラウザで `http://127.0.0.1:4312/` を開き、DevToolsのコンソールで以下を実行する（アプリのグループ画面を1つ開いた状態で実行すること）。

```js
console.log(JSON.stringify(buildInviteFlexBubble("https://miniapp.line.me/test/groups/demo/invite"), null, 2));
```

Expected（チェックする点）:
- トップレベルが`{"type": "bubble", "header": {...}, "body": {...}, "footer": {...}}`の形になっている。
- `header.contents[0].text`が現在開いているグループ名と一致する。
- `body.contents[0].contents`の要素数が、グループのメンバー数（6人まで）と一致し、各要素の`backgroundColor`が画面上のアバター色（`.avatar.tone-N`）と一致する。
- メンバーが7人以上のグループがあれば、`body.contents`に`"ほかN人"`のテキストが含まれる。
- `footer.contents[0].action.uri`が渡した引数の文字列と一致する。

- [ ] **Step 3: コミットする**

```bash
git add public/index.html
git commit -m "招待メッセージ用のFlex bubble生成関数を追加"
```

---

### Task 2: `buildSettlementFlexBubble` の追加

**Files:**
- Modify: `public/index.html`（`settlementText`関数の直前、3501行目付近に新規関数を追加）

- [ ] **Step 1: 関数を追加する**

`function settlementText(link) {` の直前に以下を追加する。

```js
      function settlementFlexRow(item) {
        const from = memberById(item.fromMemberId)?.name ?? "不明";
        const to = memberById(item.toMemberId)?.name ?? "不明";
        return {
          type: "box",
          layout: "horizontal",
          contents: [
            { type: "text", text: `${from} → ${to}`, size: "sm", color: "#3c3c3c", flex: 3, wrap: true },
            { type: "text", text: yen(item.amount), size: "sm", color: "#3c3c3c", flex: 2, align: "end" },
          ],
        };
      }

      function buildSettlementFlexBubble(link) {
        const items = settlement.items ?? [];
        const shown = items.slice(0, 5);
        const overflowCount = items.length - shown.length;

        const bodyContents = [
          { type: "text", text: state.groupName || "ワリトモ", size: "sm", color: "#767676", wrap: true },
          { type: "text", text: yen(totalExpenses()), size: "xxl", weight: "bold", color: "#3c3c3c", margin: "sm" },
          { type: "separator", margin: "md" },
        ];

        if (shown.length === 0) {
          bodyContents.push({
            type: "text",
            text: "清算は不要です",
            size: "sm",
            color: "#3c3c3c",
            margin: "md",
          });
        } else {
          shown.forEach((item, index) => {
            bodyContents.push(
              Object.assign(settlementFlexRow(item), { margin: index === 0 ? "md" : "sm" }),
            );
          });
          if (overflowCount > 0) {
            bodyContents.push({
              type: "text",
              text: `ほか${overflowCount}件`,
              size: "xs",
              color: "#767676",
              margin: "sm",
            });
          }
        }

        return {
          type: "bubble",
          header: {
            type: "box",
            layout: "vertical",
            backgroundColor: "#06c755",
            paddingAll: "16px",
            contents: [
              { type: "text", text: "ワリトモ・精算", color: "#ffffff", weight: "bold", size: "md" },
            ],
          },
          body: {
            type: "box",
            layout: "vertical",
            paddingAll: "16px",
            contents: bodyContents,
          },
          footer: {
            type: "box",
            layout: "vertical",
            paddingAll: "12px",
            contents: [
              {
                type: "button",
                style: "link",
                height: "sm",
                action: { type: "uri", label: "開いて確認する", uri: link },
              },
            ],
          },
        };
      }

```

- [ ] **Step 2: ブラウザで手動確認する**

サーバーが起動していない場合は起動する。

```bash
HOST=127.0.0.1 PORT=4312 npm run start
```

ブラウザで精算タブを開いた状態で、DevToolsのコンソールで以下を実行する。

```js
console.log(JSON.stringify(buildSettlementFlexBubble("https://miniapp.line.me/test/groups/demo/settlement"), null, 2));
```

Expected（チェックする点）:
- `body.contents[1].text`が画面に表示されている合計金額（`¥`付き）と一致する。
- 精算項目が1件以上あるグループでは、`body.contents`に`from → to`形式のテキストを含む`box`が、画面の精算リストと同じ順序・同じ人数分含まれる。
- 精算項目が6件以上ある場合、`"ほかN件"`のテキストが含まれる。
- 精算項目が0件のグループ（全員清算済み、または支出なし）では`"清算は不要です"`というテキストが含まれる。

- [ ] **Step 3: コミットする**

```bash
git add public/index.html
git commit -m "精算メッセージ用のFlex bubble生成関数を追加"
```

---

### Task 3: `shareInvite` / `shareSettlement` をFlexメッセージに差し替え

**Files:**
- Modify: `public/index.html:3527-3541`（`shareSettlement`）
- Modify: `public/index.html:3569-3584`（`shareInvite`）

- [ ] **Step 1: `shareSettlement`を書き換える**

現在の実装:

```js
      async function shareSettlement() {
        const link = await inviteLink();
        const text = settlementText(link);

        if (window.liff?.isInClient?.() && window.liff?.isApiAvailable?.("shareTargetPicker")) {
          await liff.shareTargetPicker([{ type: "text", text }]);
          trackEvent("settlement_shared", { method: "share_target_picker" });
          showToast("LINEで共有しました");
          return;
        }

        await copyText(text);
        trackEvent("settlement_shared", { method: "clipboard" });
        showToast("共有文をコピーしました");
      }
```

これを以下に置き換える。

```js
      async function shareSettlement() {
        const link = await inviteLink();
        const text = settlementText(link);

        if (window.liff?.isInClient?.() && window.liff?.isApiAvailable?.("shareTargetPicker")) {
          await liff.shareTargetPicker([
            { type: "flex", altText: text, contents: buildSettlementFlexBubble(link) },
          ]);
          trackEvent("settlement_shared", { method: "share_target_picker" });
          showToast("LINEで共有しました");
          return;
        }

        await copyText(text);
        trackEvent("settlement_shared", { method: "clipboard" });
        showToast("共有文をコピーしました");
      }
```

- [ ] **Step 2: `shareInvite`を書き換える**

現在の実装:

```js
      async function shareInvite() {
        const link = await inviteLink();
        const text = inviteText(link);

        if (window.liff?.isInClient?.() && window.liff?.isApiAvailable?.("shareTargetPicker")) {
          await liff.shareTargetPicker([{ type: "text", text }]);
          trackEvent("invite_shared", { method: "share_target_picker" });
          showToast("LINEで招待を送りました");
        } else {
          await copyText(text);
          trackEvent("invite_shared", { method: "clipboard" });
          showToast("招待メッセージをコピーしました");
        }

        dismissSharePrompt();
      }
```

これを以下に置き換える。

```js
      async function shareInvite() {
        const link = await inviteLink();
        const text = inviteText(link);

        if (window.liff?.isInClient?.() && window.liff?.isApiAvailable?.("shareTargetPicker")) {
          await liff.shareTargetPicker([
            { type: "flex", altText: text, contents: buildInviteFlexBubble(link) },
          ]);
          trackEvent("invite_shared", { method: "share_target_picker" });
          showToast("LINEで招待を送りました");
        } else {
          await copyText(text);
          trackEvent("invite_shared", { method: "clipboard" });
          showToast("招待メッセージをコピーしました");
        }

        dismissSharePrompt();
      }
```

`requestPayment`（支払い請求メッセージ）は本スコープ外なので変更しない。

- [ ] **Step 3: 差分を確認する**

```bash
git diff public/index.html
```

Expected: `shareSettlement`と`shareInvite`内の`shareTargetPicker`呼び出しの引数だけが変わっており、`copyText`のフォールバック分岐（プレーンテキストの`text`を使う側）は変更されていないこと。

- [ ] **Step 4: コミットする**

```bash
git add public/index.html
git commit -m "招待・精算のLINEシェアをFlexメッセージに切り替え"
```

---

### Task 4: 結合確認

**Files:** なし（動作確認のみ）

- [ ] **Step 1: サーバーを起動する**

```bash
HOST=127.0.0.1 PORT=4312 npm run start
```

- [ ] **Step 2: ブラウザ（LIFF外）で共有フォールバックを確認する**

`http://127.0.0.1:4312/` をLINEアプリ外の通常ブラウザで開き、グループを1つ開いて「メンバーを招待」→「精算結果を送る」を実行する。

Expected: `window.liff.isInClient()`が偽になるため、いずれもクリップボードコピーの分岐に入り、「招待メッセージをコピーしました」「共有文をコピーしました」というトーストが表示される。コピーされた内容は変更前と同じプレーンテキスト（`inviteText` / `settlementText`の出力）であること。

- [ ] **Step 3: 境界ケースをコンソールで再確認する**

Task 1・Task 2のStep 2で使ったコンソールコマンドを、以下の3パターンのグループで再実行し、想定通りの出力になることを確認する。

- メンバーが1〜2人の小さいグループ
- メンバーが7人以上の大きいグループ（`buildInviteFlexBubble`で「ほかN人」が出るか）
- 精算項目が6件以上あるグループ（`buildSettlementFlexBubble`で「ほかN件」が出るか）

- [ ] **Step 4: `docs/roadmap.md`の該当箇所は変更不要であることを確認する**

本機能はPhase2「LINE share target picker with copy fallback」の実装強化であり、roadmap自体の更新は不要。差分がないことを確認する。

```bash
git status
```

Expected: `public/index.html`以外に変更ファイルがない。

# tick と競合せずにワークフロー修正を push する手順

作成日: 2026-07-25

## 事前調査の結果（この手順の前提）

`git fetch` して確認した、いま起きている状況:

| 項目 | 状態 |
|---|---|
| ローカル `main` | `9e9f056` |
| `origin/main` | `65f50c2` |
| 差 | **ローカルが 83 コミット遅れ**（ほぼ全部 tick の自動コミット） |
| リモートが変更したファイル | `PERSONAL_CONTEXT.md` / `data/notes.md` / `data/report.md` / `data/state.json` / `summaries/*.md` |
| ローカルで「変更あり」と表示されるファイル | 11個 |
| **そのうち実質の変更があるのは** | **`.github/workflows/agent.yml` と `weekly.yml` の2つだけ** |
| 残り9個の正体 | **CRLF 改行への変換ノイズ**（中身は1文字も変わっていない） |

### いちばん危険なのはここ

`git diff --ignore-cr-at-eol` で確認すると、以下の9ファイルは**実質差分ゼロ**です:

```
PERSONAL_CONTEXT.md   README.md   agent.js   weekly.js
package.json   package-lock.json
data/notes.md   data/report.md   data/state.json
```

つまり Windows 側のエディタか同期が、全ファイルを CRLF で保存し直しただけ。
にもかかわらず git はこれを「全行の変更」と見なすため、

- このまま `git pull` すると **「ローカルの変更が上書きされます」で停止**
- 無理に commit すると **tick が更新した `data/` と全行レベルで衝突**
- しかも中身は同じなので、解決しても得るものが何もない

**リモートは `.github/` を一切触っていない**（確認済み）ので、
CRLF ノイズさえ捨てれば競合はゼロになります。

---

## 手順

以下は **自分の PC の Git Bash**（PowerShell でも可）で実行してください。
`push` には GitHub の認証情報が必要なため、この作業だけは手元で行う必要があります。

```bash
cd ~/Claude/Projects/Yokubo-Agent   # 実際のパスに合わせてください
```

---

### Step 0 — tick を止める（最重要）

作業中に tick が新しいコミットを push すると、また追いかけっこになります。先に止めます。

> **`gh` コマンドは不要です。** `gh` は GitHub CLI という別途インストールが必要なツールで、
> この作業では一度も必須になりません。以下はすべてブラウザで完結します。

**ブラウザで:**

1. https://github.com/atsko/yokubo-agent/actions/workflows/agent.yml を開く
2. 右上の `···`（三点メニュー）をクリック
3. **Disable workflow** を選択
4. ページ上部に `This workflow was disabled manually` と表示されれば成功

**確認:** 同じページの実行履歴に、以後 `yokubo-agent` の新しい実行が
増えなくなります（5〜10分ほど様子を見ると確実）。

> weekly は今日すでに走って `65f50c2` を push 済みなので、止めなくて構いません。

<details>
<summary>GitHub CLI を入れたい場合（任意）</summary>

PowerShell で:

```powershell
winget install --id GitHub.cli
```

インストール後は**ターミナルを開き直して** `gh auth login` で認証してください。
以降は `gh workflow disable agent.yml` が使えますが、この Runbook には不要です。

</details>

---

### Step 1 — 退避ブランチを作る（保険）

いまの状態にいつでも戻れるようにしておきます。

```bash
git branch backup/before-crlf-fix
git stash push -u -m "作業前の全変更(CRLFノイズ込み)"
git stash list      # stash@{0} が出ればOK(PowerShellでも表示は問題なし)
```

`stash` に逃がしたので、この時点でワークツリーは `9e9f056` のきれいな状態です。

---

### Step 2 — リモートに追いつく

ローカルに独自コミットは無い（83コミット遅れているだけ）ので、素直に早送りできます。

```bash
git fetch origin
git status -sb          # "behind 83" と出るはず
git merge --ff-only origin/main
```

`Fast-forward` と表示されれば成功です。これで `data/` も `summaries/` も
`PERSONAL_CONTEXT.md` も **GitHub 上の最新＝正**になりました。

> `--ff-only` を付けているので、もし想定外のローカルコミットがあれば
> マージせずエラーで止まります。安全装置です。

---

### Step 3 — ワークフローの修正だけを戻す

stash には CRLF ノイズも混ざっているので、**丸ごと戻さず、必要な2ファイルだけ**取り出します。

> **PowerShell 注意:** `stash@{0}` と書くと失敗します。
> PowerShell は `@{` を**ハッシュテーブル リテラル**として解釈するため、
> git に届く前に引数が壊れ、``error: unknown switch `e'`` になります。
> 対策は2つ:
> - クォートする → `'stash@{0}'`
> - **波かっこを使わない** → `stash`（`stash@{0}` と同じ意味。こちらを推奨）

> **stash の構造に注意:** `git stash push -u` は
> **追跡済みの変更を `stash`、未追跡ファイルを `stash^3`** という
> 別々の場所に格納します。片方だけ取り出すと未追跡ファイルが消えたままです。

```powershell
# 追跡済み(ワークフロー2ファイル)
git checkout 'stash' -- .github/workflows/agent.yml .github/workflows/weekly.yml

# 未追跡(Step 1 の時点で存在した新規ファイル)
git checkout 'stash^3' -- .gitattributes
```

<details>
<summary>stash の中身を先に確認したい場合</summary>

```powershell
git stash list
git ls-tree --name-only -r 'stash'      # 追跡済みの退避分
git ls-tree --name-only -r 'stash^3'    # 未追跡の退避分
```

</details>

`data/` や `agent.js` には一切触れていないことを確認:

```bash
git status --short
```

期待する出力（この3行**だけ**。RUNBOOK 自体も未追跡なら4行）:

```
M  .github/workflows/agent.yml
M  .github/workflows/weekly.yml
A  .gitattributes
```

もし `data/...` や `agent.js` が出てきたら、Step 2 が正しく終わっていません。
`git restore --staged --worktree data/ agent.js` などで戻してからやり直してください。

---

### Step 4 — 改行コードを LF に正規化する（再発防止）

`.gitattributes` を追加して、二度と CRLF が入り込まないようにします。
（このファイルは作成済みです）

```bash
cat .gitattributes          # 中身を確認
git add .gitattributes
git add --renormalize .
```

コミット済みのファイルは全て LF であることを確認済みなので、
`--renormalize` で余計な差分は出ません。念のため確認:

```bash
git status --short          # 依然として3ファイルだけのはず
```

---

### Step 5 — コミットする

```bash
git add .github/workflows/agent.yml .github/workflows/weekly.yml
git commit -m "weekly と tick の同時実行を防止(concurrency統一 + push リトライ)

- weekly.yml に agent.yml と同じ concurrency グループを設定し直列化
- rebase → push を最大5回リトライ(|| true での握りつぶしを廃止)
- set -euo pipefail を追加、summaries/ 不在時のガード
- .gitattributes で改行コードを LF に固定"
```

---

### Step 6 — push する

tick は Step 0 で止めてあるので、競合相手はいません。

```bash
git fetch origin
git status -sb              # "ahead 1" のみ、behind 0 であること
git push origin main
```

万一 behind が出た場合（weekly が動いた等）:

```bash
git pull --rebase origin main
git push origin main
```

---

### Step 7 — tick を再開する

**ブラウザで:**

1. https://github.com/atsko/yokubo-agent/actions/workflows/agent.yml を開く
2. 右上の `···` → **Enable workflow**
3. `This workflow was disabled manually` の表示が消えれば成功

有効化直後はすぐ走らず、次の cron のタイミング（最大数十分後）から再開します。
すぐ動かしたい場合は同じページの **Run workflow** ボタンで手動実行できます。

---

### Step 8 — 検証する

**8-1. 直列化が効いているか**

これが今回の修正の本丸の確認です。**2つを意図的に同時に走らせます。**

1. https://github.com/atsko/yokubo-agent/actions/workflows/weekly.yml を開く
2. **Run workflow** → `main` を選んで実行
3. **すぐに**別タブで
   https://github.com/atsko/yokubo-agent/actions/workflows/agent.yml を開き、
   こちらも **Run workflow** で実行
4. https://github.com/atsko/yokubo-agent/actions （全体の一覧）を開く

**期待する状態:**

| ワークフロー | 状態 |
|---|---|
| `weekly-digest` | 🟡 In progress（黄色い丸が回っている） |
| `yokubo-agent` | ⏸ **Queued / Pending（待機）** |

`yokubo-agent` が待たされていれば **concurrency が効いています**。
weekly が終わった後に自動で走り出し、両方 ✅ 緑になれば成功です。

**失敗パターン:** 両方が同時に 🟡 In progress になり、
どちらかが赤 ❌（`Updates were rejected` / `non-fast-forward`）で落ちる。
その場合は `concurrency` のグループ名が両ファイルで一致しているか確認してください
（どちらも `yokubo-agent` である必要があります）:

```bash
grep -A2 "^concurrency" .github/workflows/agent.yml .github/workflows/weekly.yml
```

**8-2. 中身を壊していないか**

```bash
DRY_RUN=1 node weekly.js     # 実ファイル・Notion には書かない
```

**8-3. 改行コードが元に戻っていないか**

```bash
git status --short           # 何も出なければ成功
```

数日後にもう一度これを叩いて、また9ファイルが `M` になるようなら、
エディタ側（VS Code なら右下の `CRLF` 表示）を `LF` に変えてください。

---

## この手順が競合を避けられる理由

1. **tick を止めてから作業する** → 作業中に新コミットが降ってこない
2. **stash で退避してから ff-only マージ** → リモートの `data/` を無傷で取り込む
3. **stash から2ファイルだけ取り出す** → CRLF ノイズをリポジトリに持ち込まない
4. **`.gitattributes` で LF 固定** → 同じ事故が二度と起きない
5. **リモートは `.github/` を触っていない** → 実質差分の衝突面積がゼロ

## 補足

- `summaries/` は既にリモートに存在します（`2026-07-19.md`, `2026-07-25.md`）。
  weekly.yml に入れた `mkdir -p summaries` は、いまとなっては保険です。
- 退避ブランチ `backup/before-crlf-fix` と stash は、
  Step 8 まで問題なく終わったら消して構いません:

  ```bash
  git stash drop
  git branch -D backup/before-crlf-fix
  ```

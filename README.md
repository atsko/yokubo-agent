# yokubo-agent 🥚

ホメオスタシス型の自律リサーチエージェント。
内部欲求(好奇心・退屈・社交欲・体力)が時間で高まり、しきい値を超えると **Claudeが自分の意思で行動を選んで** 動きます。

```
[5分ごとのtick] → 欲求ドリフト → しきい値(70)超え?
                                      ↓ yes
                          Claudeに自我判断させる(decide)
                 ┌──────────┼──────────┬─────────┐
              research     digest      report      rest
           Web検索して調査  ノートを読み  飼い主へ日報  休んで体力回復
           →notes.mdへ要約  返して考察   →report.md
                 └────── 欲求フィードバック & 記憶に追加 ──────┘
```

**🌙 夜間モード(22時〜8時)**: Web検索・日報はお休みし、その日の記憶の整理(要点まとめと「明日しらべたいこと」)だけを1晩に最大2回行います。体力は睡眠でぐんぐん回復し、朝から元気に調査を再開します。人間の「睡眠中の記憶固定化」と同じ発想です。

## セットアップ(3分)

Node.js 18+ が必要です。

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # https://console.anthropic.com で取得
```

## 動かす

```bash
npm run dry        # ① APIキー不要の配線テスト(ダミー応答で1周)
node agent.js --once   # ② 本番APIで強制的に1回行動(動作確認)
npm start          # ③ 常駐モード開始(Ctrl+Cで停止)
```

| コマンド | 動作 |
|---|---|
| `npm start` | 常駐。5分ごとに欲求が変動し、自律行動する |
| `npm run status` | いまの欲求・本日の行動数・累計トークンを表示 |
| `npm run once` | しきい値を無視して即1回行動(テスト用) |
| `node agent.js --tick` | 欲求を進め、条件を満たせば1回だけ行動して終了(cron/Actions用) |
| `npm run reset` | 欲求と記憶を初期化(ノートは残る) |

## 生成されるファイル(`data/`)

- **notes.md** — 調査要約と考察が溜まる本体。これがエージェントの成果物
- **report.md** — あなた宛ての日報
- **state.json** — 欲求・記憶・調査済みテーマ(エージェントの「心」)
- **agent.log** — 行動ログ

## カスタマイズ(`agent.js` 冒頭の CONFIG)

| 項目 | 意味 | 初期値 |
|---|---|---|
| `interests` | 興味分野。調査の方向性がここで決まる | コーヒー焙煎 / 英語学習 / AIエージェント |
| `tickMinutes` | 欲求更新の間隔 | 5分 |
| `threshold` | 自律行動が起きるライン | 70 |
| `cooldownMinutes` | 行動間の最短間隔 | 20分 |
| `maxActionsPerDay` | 1日の行動上限(コスト安全弁) | 12回 |
| `drift` | 欲求の増加速度。上げるほど活発な性格に | — |
| `night` | 夜間モードの時間帯と1晩の整理回数上限 | 22時〜8時 / 2回 |
| `nightDrift` | 夜間の欲求変化(体力はプラス=睡眠回復) | — |

※ 時刻は実行マシンのローカル時刻です。テスト用に `FAKE_HOUR=23 npm run dry` のように時間帯を偽装できます。

## 常駐化(ずっと生かしておく)

3通りあります。**PCを常時起動できないなら GitHub Actions が手軽**です。

### A. GitHub Actions(サーバー不要・無料枠)

リポジトリに push すれば、GitHubが定期的にエージェントを起こしてくれます。状態(`data/`)は毎回リポジトリにコミットして引き継ぐので、**notes.md が GitHub 上で育っていくノートになります**。

セットアップ:
1. このフォルダを GitHub リポジトリにして push
2. リポジトリの Settings → Secrets and variables → Actions → New repository secret
   `ANTHROPIC_API_KEY` を登録
3. Actions タブでワークフローを有効化(初回は手動の `Run workflow` で動作確認)

これだけで `.github/workflows/agent.yml` が5分ごとに `node agent.js --tick` を実行します。

**知っておくべき注意点:**
- ⏱ **cronは正確な5分間隔にはなりません。** GitHubは高負荷時にスケジュールを遅延・スキップします(数分〜数十分ずれることも)。ただし agent.js は「前回からの実経過時間」で欲求を進めるので、間隔がブレても挙動は自然なままです
- 💰 **課金に注意。** 5分ごと=1日288回の実行。**publicリポジトリはActions無料**ですが、**privateリポジトリは無料枠(月2000分)を超えます**(1回1分課金でも月約8600分)。privateで使うなら `agent.yml` の cron を `"*/15 * * * *"`(15分)や `"*/30 * * * *"`(30分)に緩めるのがおすすめ。エージェントは1日せいぜい12回しか行動しないので、間隔を空けてもほぼ同じように動きます
- 🔑 APIキーは必ず Secrets に。コードには書かない

### B. pm2(自分のPC / VPS / Raspberry Pi)
```bash
npm i -g pm2
ANTHROPIC_API_KEY=sk-ant-... pm2 start agent.js --name yokubo
pm2 logs yokubo      # ようすを見る
pm2 save && pm2 startup   # OS再起動後も自動復活
```

**手軽にバックグラウンド実行**
```bash
nohup node agent.js >> data/agent.log 2>&1 &
```

Raspberry Pi や安価なVPSに置けば24時間「生きて」いられます。

## コストについて

- 上限12回/日 × Sonnet の小さな呼び出しなので基本は小規模ですが、**web_search はツール使用ごとの従量課金が別途** かかります。最新の価格は https://docs.claude.com を確認してください
- `npm run status` の累計トークンが目安になります。まずは `maxActionsPerDay: 5` くらいから始めるのも安心です

## 拡張アイデア

- notes.md の保存先を Notion に(MCP / Notion API 経由)
- report を LINE Notify や Slack Webhook に飛ばす
- 欲求の種類を増やす(例:「かたづけたい」= 古いノートのアーカイブ)
- 好奇心の`drift`を夜だけ下げて「睡眠リズム」を作る

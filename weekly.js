#!/usr/bin/env node
/* ============================================================
   weekly.js — 週次統合スクリプト
   (パーソナルコーチ化_指示書.md フェーズ1+2 の実装)

   毎週1回:
   1. Notion「学習ログ」DBから直近7日のログを読む
   2. LLMで週次サマリーを生成(前週サマリーと比較)
   3. Notion(type=weekly_summary)と summaries/YYYY-MM-DD.md に保存
   4. PERSONAL_CONTEXT.md を再生成(携帯できる自分)
   5. (任意)Gmailで自分宛てに送信

   使い方:
     DRY_RUN=1 node weekly.js   APIキー不要の配線テスト(実ファイルを汚さない)
     node weekly.js             本番実行

   環境変数:
     NOTION_TOKEN     必須(DRY時不要)。agent.js と同じもの
     NOTION_DB_ID     必須(DRY時不要)。学習ログDBのID(32桁)
     ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY
                      いずれか1つ(この優先順で自動選択)
     WEEKLY_MODEL     (任意)モデル名の上書き
     GMAIL_USER / GMAIL_APP_PASSWORD / REPORT_TO  (任意)メール送信

   設計原則(指示書§3): 記憶はモデルの外に。LLM呼び出しは llm() の
   1関数に集約し、プロバイダはAPIキーの有無で差し替え可能。
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.env.DRY_RUN === "1";

// ---------------- 設定 ----------------
const OWNER = "コウ";

// Notion「学習ログ」DBのプロパティ名(README由来。実DBと違う場合はここを直す。
// 起動時に実DBと突き合わせ、食い違いがあればエラーメッセージで実物の名前を表示する)
const PROPS = {
  date: "日付",       // Date
  source: "source",   // Select
  type: "type",       // Select
  title: "タイトル",  // Title
  body: "本文",       // Text (rich_text)
  tags: "タグ",       // Multi-select
};

const PATHS = {
  summaries: path.join(__dirname, DRY ? "data/weekly-dry/summaries" : "summaries"),
  context: path.join(__dirname, DRY ? "data/weekly-dry/PERSONAL_CONTEXT.md" : "PERSONAL_CONTEXT.md"),
};

// ---------------- 汎用ヘルパー ----------------
const log = (m) => console.log(`[weekly] ${m}`);
// JST基準の日付文字列(実行環境がUTCでも正しく動く: 指示書§8)
const jstDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
};
const chunk = (str, size = 1900) => {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out.length ? out : [""];
};

// ---------------- LLMアダプタ(モデル非依存の要) ----------------
const PROVIDERS = [
  { env: "ANTHROPIC_API_KEY", name: "anthropic", model: "claude-haiku-4-5-20251001" },
  { env: "GEMINI_API_KEY", name: "gemini", model: "gemini-2.5-flash" },
  { env: "OPENAI_API_KEY", name: "openai", model: "gpt-4o-mini" },
];
// ↑ モデル名は変わりやすいので、合わなければ WEEKLY_MODEL で上書きする

function pickProvider() {
  for (const p of PROVIDERS) if (process.env[p.env]) return p;
  return null;
}

async function llm(prompt, maxTokens = 1600) {
  if (DRY) return dryAnswer();
  const p = pickProvider();
  if (!p) throw new Error("LLMのAPIキーが未設定(ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY のいずれか)");
  const model = process.env.WEEKLY_MODEL || p.model;
  log(`LLM: ${p.name} / ${model}`);

  if (p.name === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env[p.env],
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }
  if (p.name === "gemini") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env[p.env]}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("\n").trim();
  }
  // openai
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env[p.env]}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}

function dryAnswer() {
  return [
    `## 週次サマリー ${jstDate()}`,
    ``,
    `(DRY_RUNダミー)今週は新規語彙12・ステージ昇格3・完了タスク9・習慣達成率71%・スピーキング4回(平均WPM 98)。`,
    ``,
    `伸びた領域: スピーキング(前週2回→4回)。停滞している領域: 語彙のステージ3→4昇格が2週連続ゼロ。`,
    ``,
    `### 次の一手`,
    `1. ステージ3の語から10個選び、フリースピーキングで意識的に使う`,
    `2. 焙煎38回目のDTRをストライクゾーンと比較する`,
    `3. マルタの国の「英語」タグ習慣を朝に移す`,
    ``,
    `### if-thenルール候補(焙煎)`,
    `- 1ハゼが10分を超えたら、次回はボトム後の火力を1段上げる`,
  ].join("\n");
}

// ---------------- Notion ----------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;

async function notion(pathname, method = "GET", body = null) {
  const res = await fetch(`https://api.notion.com/v1/${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${method} ${pathname} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// 実DBとプロパティ名を突き合わせる(指示書§8「DBプロパティ名は未検証」への対処)
async function verifyDatabase() {
  const db = await notion(`databases/${NOTION_DB_ID}`);
  const actual = db.properties || {};
  const names = Object.keys(actual);
  // タイトル型プロパティは実物から自動検出(名前が違っても自己修復)
  const titleProp = names.find((n) => actual[n].type === "title");
  if (titleProp && titleProp !== PROPS.title) {
    log(`タイトルプロパティを自動調整: 「${PROPS.title}」→「${titleProp}」`);
    PROPS.title = titleProp;
  }
  const missing = [PROPS.date, PROPS.source, PROPS.type, PROPS.body].filter((n) => !actual[n]);
  if (missing.length) {
    throw new Error(
      `DBに次のプロパティが見つからない: ${missing.join(", ")}\n` +
      `実際のプロパティ: ${names.join(", ")}\n` +
      `→ weekly.js 冒頭の PROPS を実物に合わせて修正してください`
    );
  }
  log(`DB確認OK(プロパティ: ${names.join(", ")})`);
}

const plain = (arr) => (arr || []).map((x) => x.plain_text || "").join("");

function pageToEntry(page) {
  const p = page.properties || {};
  return {
    date: p[PROPS.date]?.date?.start || "",
    source: p[PROPS.source]?.select?.name || "",
    type: p[PROPS.type]?.select?.name || "",
    title: plain(p[PROPS.title]?.title),
    body: plain(p[PROPS.body]?.rich_text),
    tags: (p[PROPS.tags]?.multi_select || []).map((t) => t.name),
  };
}

// 直近7日のログ(weekly_summary自身は除外: 自己ループ汚染防止)
async function fetchWeekLogs() {
  if (DRY) return dryLogs();
  const since = jstDate(-7);
  const results = [];
  let cursor = undefined;
  do {
    const body = {
      page_size: 100,
      start_cursor: cursor,
      filter: {
        and: [
          { property: PROPS.date, date: { on_or_after: since } },
          { property: PROPS.type, select: { does_not_equal: "weekly_summary" } },
        ],
      },
      sorts: [{ property: PROPS.date, direction: "ascending" }],
    };
    if (!cursor) delete body.start_cursor;
    const res = await notion(`databases/${NOTION_DB_ID}/query`, "POST", body);
    results.push(...res.results.map(pageToEntry));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  log(`直近7日のログ: ${results.length}件`);
  return results;
}

async function fetchPrevSummary() {
  if (DRY) return "(前週サマリーなし: DRY_RUN初回想定)";
  const res = await notion(`databases/${NOTION_DB_ID}/query`, "POST", {
    page_size: 1,
    filter: { property: PROPS.type, select: { equals: "weekly_summary" } },
    sorts: [{ property: PROPS.date, direction: "descending" }],
  });
  if (!res.results.length) return "なし(今回が初回)";
  return pageToEntry(res.results[0]).body || "なし(今回が初回)";
}

function dryLogs() {
  const d = jstDate(-2);
  return [
    { date: d, source: "vocab-tracker", type: "vocab_entry", title: "ubiquitous", body: "ステージ2→3に昇格", tags: ["英語", "語彙"] },
    { date: d, source: "speaking-levelup", type: "free_speaking", title: "お題: 旅行の失敗談", body: "112語 / WPM 98", tags: ["英語"] },
    { date: jstDate(-1), source: "maruta", type: "task_done", title: "焙煎データ整理", body: "XP+30", tags: ["タスク"] },
    { date: jstDate(-1), source: "roasting", type: "roast_log", title: "38th Roast", body: "グアテマラ 500g / 1ハゼ 10:17", tags: ["焙煎"] },
  ];
}

// ---------------- サマリー生成 ----------------
function formatLogs(entries) {
  const MAX = 250;
  const shown = entries.slice(0, MAX);
  const lines = shown.map(
    (e) => `- [${e.date}] (${e.source}/${e.type}) ${e.title}${e.body ? ": " + e.body.slice(0, 240) : ""}`
  );
  if (entries.length > MAX) {
    const counts = {};
    for (const e of entries.slice(MAX)) counts[`${e.source}/${e.type}`] = (counts[`${e.source}/${e.type}`] || 0) + 1;
    lines.push(`(他${entries.length - MAX}件省略: ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ")})`);
  }
  return lines.join("\n") || "(この週のログはありません)";
}

// 統合プロンプト(指示書§4。素のテキストなのでどのモデルにも渡せる)
function buildPrompt(prevSummary, logsText) {
  return [
    `あなたは学習ログの統合を担当します。以下は直近1週間の学習・活動ログです。`,
    ``,
    `1. 進捗を300字以内で要約する(数値を含める: 新規語彙数、ステージ昇格数、`,
    `   完了タスク数、習慣達成率、スピーキング練習回数・WPMなど)`,
    `2. 前週サマリーと比較し、伸びた領域と停滞している領域を1つずつ指摘する`,
    `3. 来週の「次の一手」を3つ以内で提案する(見出しは「### 次の一手」、具体的な行動レベルで)`,
    `4. ログに焙煎記録が含まれる場合、if-thenルール(「◯◯が観察されたら△△する」)の候補を最大2つ抽出する`,
    ``,
    `出力はMarkdownで、冒頭の見出しを「## 週次サマリー ${jstDate()}」とすること。`,
    ``,
    `[前週サマリー]`,
    prevSummary,
    ``,
    `[今週のログ]`,
    logsText,
  ].join("\n");
}

async function writeSummaryToNotion(dateStr, text) {
  if (DRY) {
    log(`[DRY] Notionへの書き込みをスキップ。payload例: type=weekly_summary, タイトル=週次サマリー ${dateStr}`);
    return;
  }
  await notion("pages", "POST", {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      [PROPS.title]: { title: [{ text: { content: `週次サマリー ${dateStr}` } }] },
      [PROPS.date]: { date: { start: dateStr } },
      [PROPS.source]: { select: { name: "weekly" } },
      [PROPS.type]: { select: { name: "weekly_summary" } },
      [PROPS.body]: { rich_text: chunk(text).map((c) => ({ text: { content: c } })) },
      ...(PROPS.tags ? { [PROPS.tags]: { multi_select: [{ name: "週次" }] } } : {}),
    },
  });
  log("Notionに週次サマリーを登録した");
}

// ---------------- PERSONAL_CONTEXT.md(フェーズ2) ----------------
// 固定部(プロフィール等)はこのテンプレートが正本。変えたいときはここを編集する
const CONTEXT_PROFILE = [
  `## プロフィール`,
  `個人開発者。React + LLM API で自分用の生産性・学習ツールを構築・運用。`,
  `日本語UI・モバイルファースト(Android Chrome)・ピクセルフォント DotGothic16 を好む。`,
  `関心領域: スペシャルティコーヒー焙煎(Aillio実機・仲村式メソッド)、英語学習(CEFR B1→B2、シャドーイング/スピーキング)、ゲーミフィケーション(DQM・たまごっち風)。`,
].join("\n");

const CONTEXT_STYLE = [
  `## 依頼時の希望スタイル`,
  `- 日本語で簡潔に。説明より動くもの・具体例を先に`,
  `- UIは日本語、モバイル前提、DotGothic16`,
  `- 方向修正は簡潔に来る。即従うこと`,
].join("\n");

function projectStats(entries) {
  const bySource = {};
  for (const e of entries) {
    if (!bySource[e.source]) bySource[e.source] = { count: 0, last: "" };
    bySource[e.source].count++;
    if (e.date > bySource[e.source].last) bySource[e.source].last = e.date;
  }
  const lines = Object.entries(bySource).map(
    ([s, v]) => `- ${s}: 直近7日 ${v.count}件(最終活動 ${v.last})`
  );
  return lines.join("\n") || "- (直近7日の記録なし)";
}

function latestSummaries(n = 3, capEach = 600) {
  try {
    const files = fs.readdirSync(PATHS.summaries).filter((f) => f.endsWith(".md")).sort().slice(-n);
    return files
      .reverse()
      .map((f) => {
        const t = fs.readFileSync(path.join(PATHS.summaries, f), "utf8").trim();
        return t.length > capEach ? t.slice(0, capEach) + `\n…(全文: summaries/${f})` : t;
      })
      .join("\n\n");
  } catch {
    return "";
  }
}

function buildPersonalContext(entries) {
  const summaries = latestSummaries() || "(まだない: 次回のweekly実行から自動で埋まる)";
  const doc = [
    `# 個人コンテキスト(最終更新: ${jstDate()} / weekly.js が毎週自動更新)`,
    ``,
    `任意のAIとの対話冒頭に、このファイルと CLAUDE.md を貼って使う。`,
    ``,
    CONTEXT_PROFILE,
    ``,
    `## 進行中プロジェクト(直近7日の活動量)`,
    projectStats(entries),
    ``,
    `## 直近の週次サマリー(最新3件)`,
    summaries,
    ``,
    CONTEXT_STYLE,
    ``,
  ].join("\n");
  // 旧指示書§4の圧縮ルール: 2,000字を大きく超えないよう機械的に切り詰める
  if (doc.length > 2400) {
    log(`PERSONAL_CONTEXT が ${doc.length} 字 → サマリー部を切り詰めて圧縮`);
    return doc.slice(0, 2350) + "\n…(圧縮済み。全文は summaries/ を参照)\n";
  }
  return doc;
}

// ---------------- メール(任意) ----------------
async function sendMail(subject, text) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return;
  if (DRY) { log("[DRY] メール送信をスキップ"); return; }
  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await transporter.sendMail({ from: `"ヨクボー(週次)" <${user}>`, to: process.env.REPORT_TO || user, subject, text });
  log("メールを送信した");
}

// ---------------- メイン ----------------
async function main() {
  log(`開始 ${jstDate()}${DRY ? " [DRY_RUN: 実ファイル・Notionには書かない]" : ""}`);

  if (!DRY) {
    if (!NOTION_TOKEN || !NOTION_DB_ID) {
      console.error("エラー: NOTION_TOKEN と NOTION_DB_ID を設定してください。");
      console.error("配線テストだけなら: DRY_RUN=1 node weekly.js");
      process.exit(1);
    }
    await verifyDatabase();
  }

  // 1. 読む
  const [entries, prevSummary] = [await fetchWeekLogs(), await fetchPrevSummary()];

  // 2. 統合
  const summary = await llm(buildPrompt(prevSummary, formatLogs(entries)), 1600);
  if (!summary || summary.length < 50) throw new Error("サマリー生成結果が短すぎる(LLM応答を確認)");

  // 3. 保存
  const dateStr = jstDate();
  fs.mkdirSync(PATHS.summaries, { recursive: true });
  const file = path.join(PATHS.summaries, `${dateStr}.md`);
  fs.writeFileSync(file, summary + "\n");
  log(`保存: ${path.relative(__dirname, file)}`);
  await writeSummaryToNotion(dateStr, summary);

  // 4. PERSONAL_CONTEXT.md 再生成
  const ctx = buildPersonalContext(entries);
  fs.writeFileSync(PATHS.context, ctx);
  log(`保存: ${path.relative(__dirname, PATHS.context)}(${ctx.length}字)`);

  // 5. 通知(任意)
  try {
    await sendMail(`[ヨクボー] 週次サマリー ${dateStr}`, summary);
  } catch (e) {
    log(`メール送信に失敗(処理は継続): ${e.message || e}`);
  }

  log("完了");
}

main().catch((e) => {
  console.error("[weekly] 失敗:", e.message || e);
  process.exit(1);
});

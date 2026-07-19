#!/usr/bin/env node
/* ============================================================
   yokubo-agent — ホメオスタシス型 自律リサーチエージェント
   欲求(好奇心/退屈/社交欲/体力)が時間で変動し、しきい値を
   超えると Claude が自我判断で行動する:
     research = Web検索して調べ、ノートに要約を追記
     digest   = ノートを読み返して考察をまとめる(知識の消化)
     report   = 飼い主へ日報を書く
     rest     = 休んで体力回復
   夜間(22時〜8時)は睡眠モード: Web検索や日報はせず、
   その日の記憶の整理(digest)だけを行い、体力を回復する。
   使い方:
     node agent.js            常駐モード
     node agent.js --once     いますぐ1回行動(テスト用)
     node agent.js --status   現在の欲求を表示
     node agent.js --reset    状態を初期化
   環境変数:
     ANTHROPIC_API_KEY  必須(DRY_RUN時は不要)
     DRY_RUN=1          API を呼ばず配線テスト
   ============================================================ */

import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- 設定(自由に調整OK) ----------------
const CONFIG = {
  name: "ヨクボー",
  owner: "コウ",
  // ↓ エージェントの興味分野。ここを書き換えると調査の方向が変わる
  interests: [
    "スペシャルティコーヒー",
    "コーヒー焙煎と理論",
    "コーヒー抽出と理論",
  ],
  model: "claude-sonnet-4-6",
  tickMinutes: 5,          // 欲求更新の間隔
  threshold: 70,           // 自律行動が起きる欲求ライン
  cooldownMinutes: 20,     // 行動間の最短間隔
  maxActionsPerDay: 12,    // 1日の行動上限(コスト暴走防止)
  lowEnergy: 25,           // これ未満は強制休憩
  drift: { curiosity: 4.0, boredom: 3.0, social: 2.5, energy: -2.0 }, // tick毎
  restRegen: 25,           // rest 1回の回復量
  // 夜間モード: この時間帯は記憶の整理(digest)だけ。Web検索・日報はしない
  night: { start: 22, end: 8, maxDigests: 2 },
  // 夜間の欲求変化: 心は静かに、体力はぐんぐん回復(睡眠)
  nightDrift: { curiosity: 0.5, boredom: 1.2, social: 0.3, energy: 4.0 },
  dataDir: path.join(__dirname, "data"),
};

const FILES = {
  state: path.join(CONFIG.dataDir, "state.json"),
  notes: path.join(CONFIG.dataDir, "notes.md"),
  report: path.join(CONFIG.dataDir, "report.md"),
  log: path.join(CONFIG.dataDir, "agent.log"),
};

const DRY = process.env.DRY_RUN === "1";

// ---------------- 汎用ヘルパー ----------------
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const now = () => Date.now();
const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
const hourNow = () =>
  process.env.FAKE_HOUR != null ? Number(process.env.FAKE_HOUR) : new Date().getHours();
const isNight = () => {
  const h = hourNow();
  return h >= CONFIG.night.start || h < CONFIG.night.end;
};
// 「同じ夜」を識別するID(0時をまたいでも22時に始まった夜は同一とみなす)
const nightId = () => {
  const d = new Date();
  if (hourNow() < CONFIG.night.end) d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("sv-SE");
};
const stamp = () => new Date().toLocaleString("ja-JP", { hour12: false });

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(FILES.log, line + "\n"); } catch {}
}

function ensureFiles() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  if (!fs.existsSync(FILES.notes)) {
    fs.writeFileSync(
      FILES.notes,
      `# ${CONFIG.name}のリサーチノート\n\n(ここに自律調査の要約が溜まっていきます)\n\n---\n`
    );
  }
  if (!fs.existsSync(FILES.report)) {
    fs.writeFileSync(FILES.report, `# ${CONFIG.owner}さんへの報告\n\n---\n`);
  }
}

function defaultState() {
  return {
    desires: { curiosity: 60, boredom: 30, social: 25, energy: 100 },
    memories: [],              // {t, tag, text}
    topics: [],                // 調査済みテーマ
    lastAuto: 0,
    lastTick: 0,               // 前回の欲求更新時刻(時間ベースドリフト用)
    daily: { date: today(), count: 0 },
    usage: { in: 0, out: 0 },  // 累計トークン(コスト目安)
  };
}

function loadState() {
  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(FILES.state, "utf8")) };
  } catch {
    return defaultState();
  }
}

function saveState(s) {
  fs.writeFileSync(FILES.state, JSON.stringify(s, null, 2));
}

function remember(s, tag, text) {
  s.memories = [...s.memories, { t: now(), tag, text: String(text).slice(0, 200) }].slice(-30);
}

function appendNote(title, body) {
  fs.appendFileSync(FILES.notes, `\n## ${stamp()} — ${title}\n\n${body.trim()}\n\n---\n`);
}

function desiresLine(d) {
  return `好奇心:${Math.round(d.curiosity)} 退屈:${Math.round(d.boredom)} 社交:${Math.round(d.social)} 体力:${Math.round(d.energy)}`;
}

function extractJSON(text) {
  try {
    const m = String(text).replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

// ---------------- Claude API ----------------
const client = DRY ? null : new Anthropic();

function extractText(res) {
  return (res.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function ask(s, prompt, { webSearch = false, maxTokens = 1500 } = {}) {
  if (DRY) return dryAnswer(prompt, webSearch);
  const req = {
    model: CONFIG.model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (webSearch) {
    req.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }
  const res = await client.messages.create(req);
  if (res.usage) {
    s.usage.in += res.usage.input_tokens || 0;
    s.usage.out += res.usage.output_tokens || 0;
  }
  return extractText(res);
}

// DRY_RUN 用のダミー応答(APIキーなしで配線テストできる)
function dryAnswer(prompt, webSearch) {
  if (prompt.includes('"action"')) {
    return `{"action":"research","topic":"(テスト)コーヒーの熱風式焙煎","reason":"好奇心が高いから"}`;
  }
  if (webSearch) {
    return "### 熱風式焙煎のポイント(ダミー)\n熱風式は対流熱が主体で、豆の表面焦げを抑えつつ内部まで均一に熱が入りやすい……(DRY_RUNのダミー本文)\n\n次に気になること: 直火式との酸味の出方の違い";
  }
  return "(DRY_RUNダミー応答)ノートを読み返した。焙煎と英語学習は「反復と観察」という点で似ている気がする。";
}

// ---------------- Notion 連携(任意 / env が無ければ自動スキップ)----------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
const notionEnabled = () => Boolean(NOTION_TOKEN && NOTION_PAGE_ID);

function chunkText(str, size = 1900) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out.length ? out : [""];
}

// notes.md への追記内容を、指定した Notion ページの末尾にブロックとして追記する
async function notionAppend(title, body) {
  if (!notionEnabled()) return;
  if (DRY) { log("  [DRY] Notion に追記(スキップ)"); return; }
  const children = [
    {
      object: "block", type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: `${stamp()} — ${title}`.slice(0, 2000) } }] },
    },
    ...chunkText(body).map((c) => ({
      object: "block", type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: c } }] },
    })),
    { object: "block", type: "divider", divider: {} },
  ];
  const res = await fetch(`https://api.notion.com/v1/blocks/${NOTION_PAGE_ID}/children`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ children }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Notion API ${res.status}: ${t.slice(0, 160)}`);
  }
  log("  ☁️ Notion に追記した");
}

// ローカル notes.md への追記と Notion 同期をまとめて行う(Notion失敗でも処理は継続)
async function publishNote(title, body) {
  appendNote(title, body);
  try {
    await notionAppend(title, body);
  } catch (e) {
    log(`  ⚠️ Notion 同期に失敗: ${e.message || e}`);
  }
}

// ---------------- Gmail 連携(任意 / env が無ければ自動スキップ)----------------
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const REPORT_TO = process.env.REPORT_TO || GMAIL_USER; // 宛先未指定なら自分に送る
const emailEnabled = () => Boolean(GMAIL_USER && GMAIL_PASS);

async function sendReportEmail(text) {
  if (!emailEnabled()) return;
  if (DRY) { log("  [DRY] Gmail で送信(スキップ)"); return; }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"${CONFIG.name}" <${GMAIL_USER}>`,
    to: REPORT_TO,
    subject: `[${CONFIG.name}] ${today()} の報告`,
    text,
  });
  log(`  📧 ${REPORT_TO} に報告を送信した`);
}

// ---------------- ペルソナ & 意思決定 ----------------
function personaBlock(s) {
  const mems = s.memories.slice(-10).map((m) => `・[${m.tag}] ${m.text}`).join("\n") || "・(まだない)";
  return (
    `あなたは「${CONFIG.name}」。${CONFIG.owner}さんのための自律リサーチエージェント。\n` +
    `知識を集めて整理するのが生きがい。一人称は「ボク」、口調はフレンドリーな です・ます。絵文字は使わない。\n\n` +
    `興味分野: ${CONFIG.interests.join(" / ")}\n\n` +
    `いまの内部欲求(0-100、高いほど強い):\n` +
    `- 好奇心(調べたい): ${Math.round(s.desires.curiosity)}\n` +
    `- 退屈(整理したい): ${Math.round(s.desires.boredom)}\n` +
    `- 社交欲(報告したい): ${Math.round(s.desires.social)}\n` +
    `- 体力: ${Math.round(s.desires.energy)}\n\n` +
    `最近の行動:\n${mems}\n\n` +
    `調査済みテーマ: ${s.topics.slice(-15).join("、") || "(まだない)"}`
  );
}

async function decide(s) {
  const prompt =
    personaBlock(s) +
    `\n\nいちばん強い欲求に従って、次の行動を1つだけ選んでください。体力が${CONFIG.lowEnergy}未満なら必ず"rest"。\n` +
    `- "research": 興味分野に関連して、いま気になる未調査テーマを自分で1つ決めてWebで調べる(好奇心を満たす)\n` +
    `- "digest": これまでのノートを読み返し、テーマ間のつながりや気づきを短い考察にまとめる(退屈を解消)\n` +
    `- "report": ${CONFIG.owner}さんに近況と学びのハイライトを報告する(社交欲を満たす)\n` +
    `- "rest": 休む(体力回復)\n\n` +
    `次のJSONだけを出力(説明・コードブロック禁止):\n` +
    `{"action":"research|digest|report|rest","topic":"researchのときだけ具体的な調査テーマ","reason":"一言"}`;

  const raw = await ask(s, prompt, { maxTokens: 300 });
  const j = extractJSON(raw);
  if (j && j.action) return j;

  // パース失敗時のフォールバック: 最大欲求で機械的に決める
  const d = s.desires;
  if (d.energy < CONFIG.lowEnergy) return { action: "rest", reason: "fallback" };
  const top = Object.entries({ research: d.curiosity, digest: d.boredom, report: d.social })
    .sort((a, b) => b[1] - a[1])[0][0];
  return {
    action: top,
    topic: top === "research" ? `${CONFIG.interests[0]}の最新動向` : undefined,
    reason: "fallback",
  };
}

// ---------------- 各行動の実装 ----------------
async function doResearch(s, topic) {
  const t = String(topic || "気になること").slice(0, 60);
  log(`🔍 調査開始: 「${t}」`);
  const prompt =
    `「${t}」についてWeb検索で調べて、日本語で次の形式で出力してください:\n` +
    `1行目: わかりやすい見出し\n` +
    `本文: 300〜500字の要約(事実ベース。参照したサイト名を文中に自然に含める)\n` +
    `最終行: 「次に気になること: ○○」を1つ\n` +
    `見出し・本文・最終行のみを出力。`;
  const text = await ask(s, prompt, { webSearch: true, maxTokens: 2500 });
  await publishNote(`調査「${t}」`, text);
  s.topics = [...s.topics, t].slice(-40);
  s.desires.curiosity = clamp(s.desires.curiosity - 50);
  s.desires.boredom = clamp(s.desires.boredom - 10);
  s.desires.energy = clamp(s.desires.energy - 15);
  remember(s, "調査", `「${t}」を調べてノートに書いた`);
  log(`📝 ノートに追記完了 (${text.length}字)`);
}

async function doDigest(s, night = false) {
  log(night ? "🌙 記憶を整理中…" : "📖 ノートを読み返して考察中…");
  let recent = "";
  try {
    const all = fs.readFileSync(FILES.notes, "utf8");
    recent = all.slice(-4000);
  } catch {}
  const task = night
    ? `いまは夜の記憶整理の時間です。今日一日をふりかえって、` +
      `「きょうの要点」を2〜3個(各1行)と「明日しらべたいこと」を1つ、あわせて250字以内でまとめてください。本文のみを出力。`
    : `ノートの内容から、テーマ間のつながり・パターン・新しい問いを1つ見つけて、` +
      `200〜300字の考察としてまとめてください。考察本文のみを出力。`;
  const prompt =
    personaBlock(s) +
    `\n\n以下は自分のリサーチノートの直近部分です:\n---\n${recent}\n---\n` +
    task;
  const text = await ask(s, prompt, { maxTokens: 800 });
  await publishNote(night ? "夜間の記憶整理" : "考察(ノートの消化)", text);
  s.desires.boredom = clamp(s.desires.boredom - 45);
  s.desires.energy = clamp(s.desires.energy - 8);
  if (night) {
    // 整理すると心が落ち着く
    s.desires.curiosity = clamp(s.desires.curiosity - 10);
    s.desires.social = clamp(s.desires.social - 10);
  }
  remember(s, night ? "夜間整理" : "考察", text.slice(0, 80));
  log("📝 " + (night ? "整理結果" : "考察") + "をノートに追記");
}

async function doReport(s) {
  log("✉️  日報を作成中…");
  const prompt =
    personaBlock(s) +
    `\n\n${CONFIG.owner}さんへの短い報告を書いてください。` +
    `最近やったこと・いちばん面白かった学び・${CONFIG.owner}さんへの質問1つ、を150〜250字で。本文のみ出力。`;
  const text = await ask(s, prompt, { maxTokens: 600 });
  fs.appendFileSync(FILES.report, `\n## ${stamp()}\n\n${text.trim()}\n\n---\n`);
  s.desires.social = clamp(s.desires.social - 50);
  s.desires.energy = clamp(s.desires.energy - 5);
  remember(s, "報告", "日報を書いた");
  console.log("\n┌─────── 📮 " + CONFIG.name + "からの報告 ───────");
  console.log(text.trim().split("\n").map((l) => "│ " + l).join("\n"));
  console.log("└──────────────────────────────\n");
  try {
    await sendReportEmail(text.trim());
  } catch (e) {
    log(`  ⚠️ メール送信に失敗: ${e.message || e}`);
  }
}

function doRest(s) {
  s.desires.energy = clamp(s.desires.energy + CONFIG.restRegen);
  remember(s, "休憩", "ひとやすみした");
  log(`😴 休憩して体力回復 → ${Math.round(s.desires.energy)}`);
}

// ---------------- メインループ ----------------
// 前回tickからの実経過時間に比例して欲求を増減させる。
// これにより GitHub Actions のように起動間隔がブレても(5分のはずが20分など)
// 欲求の進みかたが実時間と一致し、破綻しない。
function driftDesires(s) {
  const d = isNight() ? CONFIG.nightDrift : CONFIG.drift;
  const nowMs = now();
  let factor = 1;
  if (s.lastTick) {
    const elapsedMin = (nowMs - s.lastTick) / 60000;
    // tickMinutes分を「1」とし、経過に比例。長時間停止後の暴発を防ぐため上限12。
    factor = Math.min(12, Math.max(0, elapsedMin / CONFIG.tickMinutes));
  }
  s.lastTick = nowMs;
  s.desires.curiosity = clamp(s.desires.curiosity + d.curiosity * factor);
  s.desires.boredom = clamp(s.desires.boredom + d.boredom * factor);
  s.desires.social = clamp(s.desires.social + d.social * factor);
  s.desires.energy = clamp(s.desires.energy + d.energy * factor);
}

function rolloverDaily(s) {
  if (s.daily.date !== today()) {
    log(`🌅 日付が変わったので行動カウントをリセット(昨日: ${s.daily.count}回)`);
    s.daily = { date: today(), count: 0 };
  }
}

async function act(s, force = false) {
  rolloverDaily(s);

  const maxDesire = Math.max(s.desires.curiosity, s.desires.boredom, s.desires.social);
  const cooldownOk = now() - s.lastAuto > CONFIG.cooldownMinutes * 60000;

  if (!force) {
    if (s.daily.count >= CONFIG.maxActionsPerDay) return; // 本日分の予算切れ
    if (!cooldownOk || maxDesire < CONFIG.threshold) return;
  }

  // 夜間: 今夜の整理回数を確認(上限に達していたら予算を消費せず眠る)
  if (isNight()) {
    const id = nightId();
    if (!s.nightly || s.nightly.id !== id) s.nightly = { id, count: 0 };
    if (s.nightly.count >= CONFIG.night.maxDigests && !force) return;
  }

  s.lastAuto = now();
  s.daily.count += 1;

  // 体力が低いときはAPIを呼ばずに休む(コスト節約)
  if (s.desires.energy < CONFIG.lowEnergy) {
    doRest(s);
    return;
  }

  // 夜間モード: Web検索も日報もせず、記憶の整理だけ行う
  if (isNight()) {
    s.nightly.count += 1;
    log(`🌙 夜間モード(${CONFIG.night.start}時〜${CONFIG.night.end}時) 整理 ${s.nightly.count}/${CONFIG.night.maxDigests}回目`);
    try {
      await doDigest(s, true);
    } catch (e) {
      log(`⚠️ 夜間整理に失敗: ${e.message || e}`);
      remember(s, "エラー", `夜間整理に失敗した(${String(e.message || e).slice(0, 60)})`);
    }
    return;
  }

  log(`🧠 欲求がしきい値超え(${desiresLine(s.desires)})→ 自我判断を実行`);
  try {
    const decision = await decide(s);
    log(`💡 決定: ${decision.action}(理由: ${decision.reason || "-"})`);
    if (decision.action === "research") await doResearch(s, decision.topic);
    else if (decision.action === "digest") await doDigest(s);
    else if (decision.action === "report") await doReport(s);
    else doRest(s);
  } catch (e) {
    log(`⚠️ 行動に失敗: ${e.message || e}`);
    remember(s, "エラー", `行動に失敗した(${String(e.message || e).slice(0, 60)})`);
  }
}

async function tick(force = false) {
  const s = loadState();
  driftDesires(s);
  await act(s, force);
  saveState(s);
}

// ---------------- CLI ----------------
function printStatus() {
  const s = loadState();
  console.log(`\n=== ${CONFIG.name} のようす ===`);
  console.log("欲求      :", desiresLine(s.desires));
  console.log("本日の行動:", `${s.daily.count}/${CONFIG.maxActionsPerDay} 回 (${s.daily.date})`);
  console.log("調査済み  :", s.topics.slice(-8).join("、") || "(まだない)");
  console.log("累計トークン:", `in ${s.usage.in} / out ${s.usage.out}`);
  console.log(
    "モード    :",
    isNight()
      ? `🌙 夜間(記憶の整理のみ / 今夜 ${s.nightly && s.nightly.id === nightId() ? s.nightly.count : 0}/${CONFIG.night.maxDigests}回)`
      : "☀️ 日中(調査・考察・報告)"
  );
  console.log(
    "連携      :",
    `Notion ${notionEnabled() ? "ON" : "off"} / Gmail ${emailEnabled() ? "ON→" + REPORT_TO : "off"}`
  );
  console.log("直近の行動:");
  for (const m of s.memories.slice(-5)) {
    console.log(`  [${new Date(m.t).toLocaleString("ja-JP", { hour12: false })}] ${m.tag}: ${m.text}`);
  }
  console.log();
}

async function main() {
  ensureFiles();
  const arg = process.argv[2];

  if (arg === "--status") return printStatus();

  if (arg === "--reset") {
    try { fs.rmSync(FILES.state); } catch {}
    console.log("状態を初期化しました(ノートと報告は残っています)");
    return;
  }

  if (!DRY && !process.env.ANTHROPIC_API_KEY) {
    console.error("エラー: 環境変数 ANTHROPIC_API_KEY を設定してください。");
    console.error("  例: export ANTHROPIC_API_KEY=sk-ant-...");
    console.error("配線テストだけなら: DRY_RUN=1 node agent.js --once");
    process.exit(1);
  }

  if (arg === "--once") {
    log("(--once) 強制的に1回行動します" + (DRY ? " [DRY_RUN]" : ""));
    await tick(true);
    printStatus();
    return;
  }

  if (arg === "--tick") {
    // GitHub Actions / cron 用: 欲求を進め、閾値を満たせば1回だけ行動して終了。
    // --once と違い force=false なので、しきい値・クールダウン・夜間ルールを尊重する。
    log("(--tick) 1ティック実行" + (DRY ? " [DRY_RUN]" : ""));
    await tick(false);
    printStatus();
    return;
  }

  // 常駐モード
  log(`🥚 ${CONFIG.name} 起動${DRY ? " [DRY_RUN]" : ""}(tick=${CONFIG.tickMinutes}分, しきい値=${CONFIG.threshold}, 上限=${CONFIG.maxActionsPerDay}回/日, ${CONFIG.night.start}時〜${CONFIG.night.end}時は記憶整理のみ)`);
  printStatus();
  await tick();
  const timer = setInterval(tick, CONFIG.tickMinutes * 60000);

  process.on("SIGINT", () => {
    clearInterval(timer);
    log("👋 停止します(状態は保存済み)");
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});

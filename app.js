/* 인생이야기 영상 제작기 — 웹 버전 (GitHub Pages)
 * 타입캐스트 연결은 크롬 확장 프로그램(사이드바)이 도와줌
 * 대본(화자 태그 + 장면 번호) + 사진 → 타입캐스트 음성 → 브라우저 안에서 영상(MP4) 렌더링
 */
"use strict";

// ───────────────────────── 설정 ─────────────────────────
const PARAMS = new URLSearchParams(location.search);
const CFG = {
  host: PARAMS.get("host") || "https://api.typecast.ai",
  model: "ssfm-v30",
  lang: "kor",
  lufs: -16,
  W: 1920, H: 1080, fps: 30,
  videoBitrate: 5_000_000,
  audioBitrate: 128_000,
  sampleRate: 48000,
  zoom: 1.08,
  startPad: 0.4, endPad: 2.0,
  gapSame: 0.35, gapSpeaker: 0.55, gapScene: 0.9,
  lineMax: 24,
  subMargin: 70,
  narColor: "#FFFFFF", diaColor: "#FFE45C",
  narrator: "내레이션",
  ttsConcurrency: 2,
  previewSample: "안녕하세요. 오늘도 귀한 이야기 한 편 들려드리겠습니다.",
};
const FORCE_MEMORY_SAVE = PARAMS.get("nosave") === "1"; // 테스트용

const EMOTIONS = {
  "보통": "normal", "기본": "normal", "normal": "normal",
  "기쁨": "happy", "행복": "happy", "happy": "happy",
  "슬픔": "sad", "sad": "sad",
  "분노": "angry", "화남": "angry", "angry": "angry",
  "속삭임": "whisper", "whisper": "whisper",
  "톤업": "toneup", "toneup": "toneup", "높게": "toneup",
  "톤다운": "tonedown", "tonedown": "tonedown", "낮게": "tonedown",
  "자동": "smart", "smart": "smart",
};
const GENDER_KO = { female: "여성", male: "남성" };
const AGE_KO = { child: "어린이", teenager: "청소년", young_adult: "청년", middle_age: "중년", elder: "노년" };

// ───────────────────────── 공통 ─────────────────────────
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (t) => {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
const srtTime = (t) => {
  let ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
};
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
async function sha1(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
function download(name, blob) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// 저장소: 확장 프로그램이면 chrome.storage, 아니면 localStorage
const store = {
  async get(k, d) {
    try {
      if (globalThis.chrome?.storage?.local) { const r = await chrome.storage.local.get(k); return r[k] ?? d; }
      const v = localStorage.getItem("insaeng:" + k); return v == null ? d : JSON.parse(v);
    } catch { return d; }
  },
  async set(k, v) {
    try {
      if (globalThis.chrome?.storage?.local) return chrome.storage.local.set({ [k]: v });
      localStorage.setItem("insaeng:" + k, JSON.stringify(v));
    } catch { /* 무시 */ }
  },
};

// 확장 프로그램 연결 (타입캐스트 서버는 웹페이지에서 직접 부르면 막힐 수 있어 확장 프로그램이 대신 요청)
const bridge = {
  ready: false, version: "", seq: 0, waits: new Map(),
  init() {
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.src !== "insaeng-ext") return;
      const d = e.data;
      if (d.type === "hello") { this.ready = true; this.version = d.version || ""; updateExtState(); return; }
      const w = this.waits.get(d.id); if (!w) return;
      this.waits.delete(d.id); d.error ? w.rej(new Error(d.error)) : w.res(d);
    });
    if (document.documentElement.dataset.insaengExt) { this.ready = true; this.version = document.documentElement.dataset.insaengExt; }
    window.postMessage({ src: "insaeng-page", type: "ping" }, location.origin);
  },
  async waitReady(ms = 1500) {
    const t = performance.now();
    while (!this.ready && performance.now() - t < ms) await sleep(100);
    return this.ready;
  },
  fetch(url, opts) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      window.postMessage({ src: "insaeng-page", type: "fetch", id, url, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body || null }, location.origin);
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error("확장 프로그램 응답 없음")); } }, 180000);
    }).then((d) => {
      const bin = d.b64 ? Uint8Array.from(atob(d.b64), (c) => c.charCodeAt(0)) : new Uint8Array();
      return new Response(d.status === 204 ? null : bin, { status: d.status, headers: { "Content-Type": d.ctype || "application/octet-stream" } });
    });
  },
};
async function apiFetch(url, opts) {
  if (await bridge.waitReady()) return bridge.fetch(url, opts);
  try { return await fetch(url, opts); }
  catch (e) { throw new ApiError("타입캐스트에 연결하려면 크롬 확장 프로그램 ‘인생이야기 사이드바’가 필요합니다. 설치 후 이 페이지를 새로고침하세요.", true); }
}
function updateExtState() {
  const s = $("#ext-state"); if (!s) return;
  s.textContent = bridge.ready ? "✓ 확장 프로그램 연결됨" : "확장 프로그램 없음 (무음 테스트만 가능)";
  s.className = "ext " + (bridge.ready ? "ok" : "warn");
}

// IndexedDB: 만든 음성 저장 (다시 만들 때 크레딧 절약)
const idb = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open("insaeng-video", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("tts");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("tts", mode); const s = t.objectStore("tts");
      const req = fn(s); t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error);
    });
  },
  get(k) { return this.tx("readonly", (s) => s.get(k)); },
  put(k, v) { return this.tx("readwrite", (s) => s.put(v, k)); },
  clear() { return this.tx("readwrite", (s) => s.clear()); },
  count() { return this.tx("readonly", (s) => s.count()); },
};

// ───────────────────────── 상태 ─────────────────────────
const state = {
  apiKey: "",
  scenes: [], problems: [], speakers: [],
  voices: [],            // [{id, name, gender, age, uses, preview}]
  cast: {},              // 이름 → {voice_id, speed, pitch, emotion}
  images: new Map(),     // 장면번호 → File
  imageOrder: [],        // 번호 없는 파일들 (순서 배치용)
  building: false, cancel: false,
};

// ───────────────────────── 대본 읽기 ─────────────────────────
const RE_SCENE = /^\[\s*장면\s*(\d+)\s*\]\s*$/;
const RE_CHAPTER = /^\[\s*챕터\s*\]\s*(.*)$/;
const RE_TAG = /^\[([^\]]+)\]\s*(.*)$/;

function parseScript(text) {
  const scenes = []; const problems = []; const loose = []; let pendingChapter = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim(); const ln = i + 1;
    if (!s || s.startsWith("#")) return;
    let m = s.match(RE_SCENE);
    if (m) { scenes.push({ num: +m[1], chapter: pendingChapter, lines: [], ln }); pendingChapter = null; return; }
    m = s.match(RE_CHAPTER);
    if (m) { pendingChapter = m[1].trim() || "챕터"; return; }
    let speaker = CFG.narrator, emotion = null, intensity = null, body = s;
    m = s.match(RE_TAG);
    if (m) {
      const parts = m[1].split("|").map((p) => p.trim());
      speaker = parts[0] || CFG.narrator;
      if (parts[1]) {
        emotion = EMOTIONS[parts[1].toLowerCase()];
        if (!emotion) { problems.push({ t: "warn", m: `${ln}번째 줄: 모르는 감정 '${parts[1]}' → 자동으로 처리` }); emotion = "smart"; }
      }
      if (parts[2]) {
        const v = parseFloat(parts[2]);
        if (isNaN(v)) problems.push({ t: "warn", m: `${ln}번째 줄: 감정 세기 '${parts[2]}' 는 숫자(0~2)여야 합니다` });
        else intensity = Math.max(0, Math.min(2, v));
      }
      body = m[2].trim();
    }
    if (!body) return;
    const line = { speaker, emotion, intensity, text: body };
    if (!scenes.length) { line.chapter = pendingChapter; pendingChapter = null; loose.push({ line, ln }); return; }
    scenes[scenes.length - 1].lines.push(line);
  });
  const seen = new Map();
  for (const sc of scenes) {
    if (seen.has(sc.num)) problems.push({ t: "warn", m: `장면 ${pad3(sc.num)} 번호가 두 번 나옵니다` });
    seen.set(sc.num, true);
    if (!sc.lines.length) problems.push({ t: "warn", m: `장면 ${pad3(sc.num)} 에 문장이 없습니다` });
  }
  if (scenes.length && loose.length) problems.push({ t: "warn", m: `${loose[0].ln}번째 줄: [장면 001] 보다 먼저 나온 문장 ${loose.length}개는 건너뜁니다` });
  return { scenes: scenes.filter((s) => s.lines.length), problems, loose: scenes.length ? [] : loose.map((x) => x.line) };
}

// 장면 표시가 없는 대본 → 사진 장수(없으면 약 35초 간격)에 맞춰 자동으로 나누기
function autoScenes(lines, n) {
  const total = lines.reduce((a, l) => a + l.text.length, 0);
  n = Math.max(1, n);
  const target = total / n;
  // 너무 긴 문단은 문장 단위로 쪼개서 고르게 나눌 수 있게
  const units = [];
  for (const l of lines) {
    if (l.text.length <= target * 1.5) { units.push(l); continue; }
    const sents = (l.text.match(/[^.?!…]+[.?!…]*["'”’」)]*\s*/g) || [l.text]).map((x) => x.trim()).filter(Boolean);
    let cur = "", first = true;
    for (const x of sents) {
      if (cur && cur.length + x.length > target) { units.push({ ...l, text: cur.trim(), chapter: first ? l.chapter : null }); first = false; cur = ""; }
      cur += x + " ";
    }
    if (cur.trim()) units.push({ ...l, text: cur.trim(), chapter: first ? l.chapter : null });
  }
  n = Math.min(n, units.length);
  const scenes = []; let acc = 0;
  for (const u of units) {
    const k = Math.min(n - 1, Math.floor(acc / (total / n) + 1e-9));
    while (scenes.length <= k) scenes.push({ num: scenes.length + 1, chapter: null, lines: [] });
    const sc = scenes[scenes.length - 1];
    if (u.chapter && !sc.chapter) sc.chapter = u.chapter;
    sc.lines.push(u); acc += u.text.length;
  }
  return scenes.filter((x) => x.lines.length).map((x, i) => ({ ...x, num: i + 1 }));
}
const photoCount = () => state.images.size + state.imageOrder.length;
const pad3 = (n) => String(n).padStart(3, "0");
const charCount = (s) => s.replace(/\s/g, "").length;

function splitLong(text, limit = 900) {
  if (text.length <= limit) return [text];
  const sents = text.match(/[^.?!…]+[.?!…]*\s*/g) || [text];
  const out = []; let cur = "";
  for (const s of sents) {
    if (cur.length + s.length > limit && cur) { out.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ───────────────────────── 화면: 대본 ─────────────────────────
function onScriptChange() {
  const text = $("#script").value;
  store.set("script", text);
  let { scenes, problems, loose } = parseScript(text);
  state.auto = false;
  if (!scenes.length && loose.length) {
    const est = estimate([{ lines: loose }]).secs;
    const n = photoCount() || Math.max(1, Math.round(est / 35));
    scenes = autoScenes(loose, n); state.auto = true;
  }
  state.scenes = scenes; state.problems = problems;
  const counts = new Map();
  for (const sc of scenes) for (const l of sc.lines) {
    const who = state.single ? CFG.narrator : l.speaker;
    counts.set(who, (counts.get(who) || 0) + l.text.length);
  }
  state.speakers = [...counts.entries()].sort((a, b) => (a[0] === CFG.narrator ? -1 : b[0] === CFG.narrator ? 1 : b[1] - a[1]));
  renderSummary(); renderCast(); renderGrid();
}

function estimate(scenes) {
  let chars = 0, lines = 0, spoken = 0;
  for (const sc of scenes) for (const l of sc.lines) { chars += l.text.length; spoken += charCount(l.text); lines++; }
  return { chars, lines, secs: spoken * 0.16 + lines * 0.5 };
}

function renderSummary() {
  const box = $("#script-summary"); box.innerHTML = "";
  const st = $("#script-state");
  if (!state.scenes.length) {
    st.textContent = $("#script").value.trim() ? "장면 번호를 찾지 못함" : ""; st.className = "state err";
    if ($("#script").value.trim()) box.append(el("div", { class: "msgs msg-err" }, "[장면 001] 같은 장면 번호 줄이 있어야 합니다. ‘대본 형식 보기’를 눌러 확인하세요."));
    return;
  }
  const e = estimate(state.scenes);
  const chapters = state.scenes.filter((s) => s.chapter).length;
  const k = (big, small) => el("div", { class: "k" }, el("b", {}, big), el("span", {}, small));
  box.append(
    k(`${state.scenes.length}개`, "장면 (= 필요한 사진 수)"),
    k(`약 ${clock(e.secs)}`, "예상 영상 길이 (±15%)"),
    k(`${e.chars.toLocaleString()}자`, "글자 수 ≈ 크레딧"),
    k(`${state.speakers.length}명`, "목소리 (내레이션 포함)"),
    k(`${chapters}개`, "챕터"),
  );
  if (state.auto) {
    box.append(el("div", { class: "msgs" }, photoCount()
      ? `장면 표시가 없어서 사진 ${photoCount()}장에 맞춰 대본을 ${state.scenes.length}개 장면으로 자동으로 나눴습니다.`
      : `장면 표시가 없어서 약 35초마다 사진이 바뀌도록 ${state.scenes.length}개 장면으로 나눴습니다. 사진을 넣으면 사진 장수에 맞춰 다시 나눕니다.`));
  }
  if (state.problems.length) {
    box.append(el("div", { class: "msgs" }, ...state.problems.slice(0, 8).map((p) => el("div", { class: p.t === "err" ? "msg-err" : "msg-warn" }, "· " + p.m))));
  }
  st.textContent = "✓ 읽기 완료"; st.className = "state ok";
}

// ───────────────────────── 타입캐스트 ─────────────────────────
class ApiError extends Error { constructor(msg, fatal) { super(msg); this.fatal = fatal; } }

async function tcFetch(path, opts = {}, tries = 6) {
  if (!state.apiKey) throw new ApiError("1번 칸에 타입캐스트 API 키를 먼저 저장하세요.", true);
  let last = "";
  for (let a = 0; a < tries; a++) {
    let r;
    try {
      r = await apiFetch(CFG.host + path, { ...opts, headers: { "X-API-KEY": state.apiKey, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
    } catch (e) { if (e.fatal) throw e; last = "인터넷 연결 문제"; await sleep(2000 * (a + 1)); continue; }
    if (r.ok) return r;
    const body = (await r.text().catch(() => "")).slice(0, 300);
    if (r.status === 401) throw new ApiError("API 키가 잘못되었습니다. 1번 칸의 키를 확인하세요.", true);
    if (r.status === 402) throw new ApiError("타입캐스트 크레딧이 부족합니다. 요금제·사용량을 확인하세요.", true);
    if ([400, 404, 422].includes(r.status)) throw new ApiError(`타입캐스트 요청 오류 (${r.status}) ${body}`, false);
    last = `HTTP ${r.status}`;
    await sleep(2000 * (a + 1));
  }
  throw new ApiError(`타입캐스트 연결 실패 (${last}). 잠시 후 다시 시도하세요.`, false);
}

// 음성 만들기 요청 (최신 모델이 안 되는 목소리는 구형 모델로 한 번 더)
async function ttsRequest(body) {
  try {
    return await (await tcFetch("/v1/text-to-speech", { method: "POST", body: JSON.stringify(body) })).blob();
  } catch (e) {
    if (e.fatal || body.model !== "ssfm-v30") throw e;
    const b2 = { ...body, model: "ssfm-v21", prompt: { emotion_preset: ["normal", "happy", "sad", "angry"].includes(body.prompt?.emotion_preset) ? body.prompt.emotion_preset : "normal", emotion_intensity: body.prompt?.emotion_intensity ?? 1 } };
    return await (await tcFetch("/v1/text-to-speech", { method: "POST", body: JSON.stringify(b2) })).blob();
  }
}

async function loadVoices(force = false) {
  const info = $("#voices-info");
  const cached = await store.get("voices2", null);
  if (!force && cached && Date.now() - cached.at < 3 * 86400_000 && cached.list?.length) {
    state.voices = cached.list; info.textContent = `목소리 ${state.voices.length}개`; renderCast(); return;
  }
  if (!state.apiKey) { info.textContent = "API 키를 먼저 저장하세요"; return; }
  info.textContent = "불러오는 중…";
  try {
    let list;
    try {
      list = await (await tcFetch(`/v3/voices`, {}, 2)).json();
    } catch (e) {
      if (e.fatal) throw e;
      list = await (await tcFetch(`/v2/voices`, {}, 3)).json();
    }
    if (!Array.isArray(list)) list = list.voices || list.data || list.items || [];
    state.voices = list.map((v) => ({
      id: v.voice_id,
      name: typeof v.voice_name === "object" ? (v.voice_name.kor || v.voice_name.eng) : v.voice_name,
      alt: typeof v.voice_name === "object" ? (v.voice_name.eng || "") : "",
      gender: v.gender || "", age: v.age || "",
      uses: (v.use_cases || []).join(", "),
      preview: v.preview_url || "",
      models: (v.models || []).map((m) => m.version || m).filter(Boolean),
    })).filter((v) => v.id).sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
    await store.set("voices2", { at: Date.now(), list: state.voices });
    info.textContent = `목소리 ${state.voices.length}개`;
    renderCast();
  } catch (e) {
    info.textContent = ""; toast(e.message, 6000);
  }
}

function modelFor(voiceId) {
  const v = state.voices.find((x) => x.id === voiceId);
  if (!v || !v.models?.length || v.models.includes("ssfm-v30")) return "ssfm-v30";
  return v.models.includes("ssfm-v21") ? "ssfm-v21" : v.models[0];
}
function ttsBody(text, v, emotion, intensity, prev, next, forceModel) {
  const model = forceModel || modelFor(v.voice_id);
  const body = {
    voice_id: v.voice_id, text, model, language: CFG.lang,
    output: { target_lufs: CFG.lufs, audio_pitch: +v.pitch || 0, audio_tempo: +v.speed || 1, audio_format: "wav" },
  };
  if (model !== "ssfm-v30") {
    // 구형 모델: 자동 감정·속삭임 등은 없음 → 보통/기쁨/슬픔/분노만
    const ok = ["normal", "happy", "sad", "angry"].includes(emotion) ? emotion : "normal";
    body.prompt = { emotion_preset: ok, emotion_intensity: intensity };
  } else if (emotion === "smart") {
    body.prompt = { emotion_type: "smart" };
    if (prev) body.prompt.previous_text = prev.slice(-1500);
    if (next) body.prompt.next_text = next.slice(0, 1500);
  } else {
    body.prompt = { emotion_type: "preset", emotion_preset: emotion, emotion_intensity: intensity };
  }
  return body;
}

// 오디오 → 48kHz 모노 Float32
async function decodeAudio(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, CFG.sampleRate);
  const buf = await ctx.decodeAudioData(arrayBuffer);
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels; }
  return out;
}

// ───────────────────────── 화면: 목소리 ─────────────────────────
function castDefault(name) {
  return { voice_id: "", speed: name === CFG.narrator ? 0.95 : 1.0, pitch: 0, emotion: name === CFG.narrator ? "normal" : "smart", fg: "", fa: "" };
}

function renderCast() {
  const box = $("#cast"); box.innerHTML = "";
  if (!state.speakers.length) { box.append(el("p", { class: "empty" }, "대본을 붙여넣으면 등장인물이 여기에 나타납니다.")); updateCastState(); return; }
  for (const [name, chars] of state.speakers) {
    const c = state.cast[name] || (state.cast[name] = castDefault(name));
    const row = el("div", { class: "cast-row" + (c.voice_id ? "" : " missing") });
    const fg = el("select", { class: "f", title: "성별" }, el("option", { value: "" }, "성별 전체"), ...Object.entries(GENDER_KO).map(([k, v]) => el("option", { value: k }, v)));
    const fa = el("select", { class: "f", title: "나이대" }, el("option", { value: "" }, "나이 전체"), ...Object.entries(AGE_KO).map(([k, v]) => el("option", { value: k }, v)));
    fg.value = c.fg || ""; fa.value = c.fa || "";
    const sel = el("select", { class: "voice" });
    const q = el("input", { type: "text", class: "q", placeholder: "이름 검색 (예: 소영)", title: "타입캐스트 목소리 ID(tc_…)를 붙여넣고 엔터를 눌러도 됩니다" });
    q.value = c.q || "";
    const fill = () => {
      sel.innerHTML = "";
      sel.append(el("option", { value: "" }, state.voices.length ? "— 목소리 선택 —" : "— 위의 ‘목소리 목록 불러오기’를 누르세요 —"));
      const kw = q.value.trim().toLowerCase();
      const list = state.voices.filter((v) => (!fg.value || v.gender === fg.value) && (!fa.value || v.age === fa.value)
        && (!kw || String(v.name).toLowerCase().includes(kw) || String(v.alt).toLowerCase().includes(kw) || v.id.toLowerCase() === kw));
      let found = false;
      for (const v of list) {
        const label = [v.name, GENDER_KO[v.gender], AGE_KO[v.age], v.models?.length && !v.models.includes("ssfm-v30") ? "구형 모델" : ""].filter(Boolean).join(" · ");
        sel.append(el("option", { value: v.id }, label)); if (v.id === c.voice_id) found = true;
      }
      if (c.voice_id && !found) {
        const v = state.voices.find((x) => x.id === c.voice_id);
        sel.append(el("option", { value: c.voice_id }, v ? `${v.name} (필터 밖)` : c.voice_id));
      }
      if (kw && list.length === 0 && !c.voice_id) sel.options[0].textContent = "— 검색 결과 없음 —";
      sel.value = c.voice_id || "";
      if (kw && list.length === 1 && !c.voice_id) { sel.value = list[0].id; sel.onchange?.(); }
    };
    fill();
    let qd; q.oninput = () => { clearTimeout(qd); qd = setTimeout(() => { c.q = q.value; fill(); }, 200); };
    q.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const id = q.value.trim();
      if (/^tc_[0-9a-z]+$/i.test(id)) { c.voice_id = id; q.value = ""; c.q = ""; fill(); row.classList.remove("missing"); saveCast(); updateCastState(); toast("목소리 ID 를 직접 넣었습니다"); }
    };
    fg.onchange = () => { c.fg = fg.value; fill(); saveCast(); };
    fa.onchange = () => { c.fa = fa.value; fill(); saveCast(); };
    sel.onchange = () => { c.voice_id = sel.value; row.classList.toggle("missing", !c.voice_id); saveCast(); updateCastState(); };
    const play = el("button", { class: "btn play", title: "미리 듣기", onclick: () => previewVoice(c, play) }, "▶ 듣기");
    const speed = el("select", { title: "속도" }, ...[0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15].map((s) => el("option", { value: s }, `속도 ${s}`)));
    speed.value = String(c.speed); speed.onchange = () => { c.speed = +speed.value; saveCast(); };
    const emo = el("select", { title: "감정 표시가 없는 줄의 기본 감정" }, el("option", { value: "smart" }, "감정 자동"), el("option", { value: "normal" }, "감정 보통"), el("option", { value: "tonedown" }, "차분하게"));
    emo.value = c.emotion; emo.onchange = () => { c.emotion = emo.value; saveCast(); };
    row.append(
      el("div", { class: "cast-name" }, el("b", {}, name), el("span", {}, `${chars.toLocaleString()}자`)),
      el("div", { class: "cast-pick" }, q, fg, fa, sel, play),
      el("div", { class: "cast-extra" }, speed, emo),
    );
    box.append(row);
  }
  updateCastState();
}
function saveCast() { store.set("cast", state.cast); }
function updateCastState() {
  const st = $("#cast-state");
  if (!state.speakers.length) { st.textContent = ""; return; }
  const miss = state.speakers.filter(([n]) => !state.cast[n]?.voice_id).length;
  st.textContent = miss ? `${miss}명 선택 필요` : "✓ 모두 선택됨"; st.className = "state " + (miss ? "warn" : "ok");
}

async function previewVoice(c, btn) {
  if (!c.voice_id) return toast("먼저 목소리를 고르세요");
  const player = $("#player");
  const v = state.voices.find((x) => x.id === c.voice_id);
  btn.disabled = true; const old = btn.textContent; btn.textContent = "…";
  try {
    if (v?.preview) {
      try { player.src = v.preview; await player.play(); return; } catch { /* 샘플을 직접 만들어 재생 */ }
    }
    const body = ttsBody(CFG.previewSample, c, "normal", 1, "", "");
    const key = "pv:" + await sha1(JSON.stringify(body));
    let rec = await idb.get(key);
    if (!rec) { rec = { blob: await ttsRequest(body) }; await idb.put(key, rec); }
    player.src = URL.createObjectURL(rec.blob); await player.play();
  } catch (e) { toast("미리 듣기 실패: " + (e.message || e), 8000); }
  finally { btn.disabled = false; btn.textContent = old; }
}

// ───────────────────────── 화면: 사진 ─────────────────────────
function addImages(files) {
  const imgs = [...files].filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!imgs.length) return toast("사진 파일이 아닙니다");
  imgs.sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
  let numbered = 0;
  for (const f of imgs) {
    const m = f.name.match(/(\d+)/);
    if (m) { state.images.set(+m[1], f); numbered++; } else state.imageOrder.push(f);
  }
  toast(`사진 ${imgs.length}장 추가`);
  if (state.auto) onScriptChange(); else renderGrid();
}
function imageFor(num, idx) {
  if (state.images.has(num)) return state.images.get(num);
  // 번호 없는 사진은 장면 순서대로
  return state.imageOrder[idx] || null;
}
const thumbCache = new Map();
function thumbURL(f) { if (!thumbCache.has(f)) thumbCache.set(f, URL.createObjectURL(f)); return thumbCache.get(f); }

function renderGrid() {
  const g = $("#grid"); g.innerHTML = "";
  const st = $("#img-state");
  if (!state.scenes.length) {
    g.append(el("p", { class: "empty" }, state.images.size + state.imageOrder.length ? `사진 ${state.images.size + state.imageOrder.length}장 들어옴 — 대본을 넣으면 장면별로 보여줍니다.` : "대본을 넣으면 장면별 사진 칸이 생깁니다."));
    st.textContent = ""; return;
  }
  let miss = 0;
  state.scenes.forEach((sc, i) => {
    const f = imageFor(sc.num, i);
    if (!f) miss++;
    const ph = el("div", { class: "ph" }, f ? "" : "사진 없음");
    if (f) ph.style.backgroundImage = `url("${thumbURL(f)}")`;
    g.append(el("div", { class: "tile" + (f ? "" : " miss") }, ph,
      el("div", { class: "cap" }, el("b", {}, pad3(sc.num)), sc.chapter ? `· ${sc.chapter}` : "", el("span", {}, sc.lines[0].text))));
  });
  if (miss) { st.textContent = `${miss}장 비어 있음 (앞 사진을 이어서 씀)`; st.className = "state warn"; }
  else { st.textContent = "✓ 모든 장면에 사진 있음"; st.className = "state ok"; }
}

// ───────────────────────── 자막 나누기 ─────────────────────────
function wrapLines(text, lineMax) {
  if (text.length <= lineMax) return [text];
  const w = text.split(" "); let best = null, bd = Infinity;
  for (let i = 1; i < w.length; i++) {
    const a = w.slice(0, i).join(" "), b = w.slice(i).join(" ");
    if (a.length <= lineMax + 2 && b.length <= lineMax + 2 && Math.abs(a.length - b.length) < bd) { best = [a, b]; bd = Math.abs(a.length - b.length); }
  }
  if (best) return best;
  const h = Math.ceil(text.length / 2); return [text.slice(0, h), text.slice(h)];
}
function splitSubtitle(text, lineMax) {
  const chunkMax = lineMax * 2;
  let sents = (text.match(/[^.?!…]+[.?!…]*["'”’」)]*\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
  if (!sents.length) sents = [text];
  const chunks = [];
  for (let s of sents) {
    while (s.length > chunkMax) {
      let cut = -1;
      for (const mark of [", ", ",", " "]) { const p = s.lastIndexOf(mark, chunkMax); if (p > chunkMax * 0.4) { cut = p + mark.length; break; } }
      if (cut < 0) cut = chunkMax;
      chunks.push(s.slice(0, cut).trim()); s = s.slice(cut).trim();
    }
    if (s) chunks.push(s);
  }
  const merged = [];
  for (const c of chunks) {
    if (merged.length && merged[merged.length - 1].length + 1 + c.length <= chunkMax && c.length <= 6) merged[merged.length - 1] += " " + c;
    else merged.push(c);
  }
  return merged.map((c) => ({ lines: wrapLines(c, lineMax), n: Math.max(1, charCount(c)) }));
}

// ───────────────────────── 제작 ─────────────────────────
function setStage(text, frac, eta) {
  $("#stage").textContent = text;
  if (frac != null) { $("#bar-fill").style.width = (frac * 100).toFixed(1) + "%"; $("#pct").textContent = Math.floor(frac * 100) + "%"; }
  $("#eta").textContent = eta || "";
}
function checkCancel() { if (state.cancel) throw new ApiError("중지했습니다.", true); }

async function build() {
  if (state.building) return;
  const mock = $("#opt-mock").checked;
  const previewOnly = $("#opt-preview").checked;
  const previewN = Math.max(1, +$("#opt-preview-n").value || 3);
  const useSub = $("#opt-sub").checked, useZoom = $("#opt-zoom").checked, subSize = +$("#opt-subsize").value;

  // 확인
  if (!state.scenes.length) return toast("2번 칸에 대본을 먼저 넣으세요");
  if (!mock) {
    if (!state.apiKey) return toast("1번 칸에 API 키를 먼저 저장하세요");
    const miss = state.speakers.filter(([n]) => !state.cast[n]?.voice_id).map(([n]) => n);
    if (miss.length) return toast(`목소리를 고르지 않은 인물: ${miss.join(", ")}`, 5000);
  }
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return toast("이 브라우저는 영상 만들기를 지원하지 않습니다. 최신 크롬을 사용하세요.", 6000);

  const scenes = previewOnly ? state.scenes.slice(0, previewN) : state.scenes;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const baseName = `인생이야기_${stamp}${previewOnly ? `_미리보기${scenes.length}장면` : ""}${mock ? "_무음테스트" : ""}`;

  // 저장 위치 (버튼을 누른 직후에 물어봐야 함)
  let writable = null, fileHandle = null;
  if (PARAMS.get("opfs") === "1") { // 테스트용: 브라우저 내부 저장소에 바로 쓰기
    fileHandle = await (await navigator.storage.getDirectory()).getFileHandle("test.mp4", { create: true });
    writable = await fileHandle.createWritable();
  } else if (!FORCE_MEMORY_SAVE && window.showSaveFilePicker) {
    try {
      fileHandle = await showSaveFilePicker({ suggestedName: baseName + ".mp4", types: [{ description: "MP4 영상", accept: { "video/mp4": [".mp4"] } }] });
      writable = await fileHandle.createWritable();
    } catch (e) {
      if (e.name === "AbortError") return toast("저장 위치를 고르지 않아 취소했습니다");
      writable = null;
    }
  }

  state.building = true; state.cancel = false;
  $("#build").disabled = true; $("#cancel").hidden = false; $("#progress").hidden = false; $("#result").hidden = true;
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* 무시 */ }
  const t0 = performance.now();
  try {
    // 1) 음성
    const jobs = await prepareJobs(scenes, mock);
    await makeVoices(jobs, mock);
    checkCancel();
    // 2) 시간 계산
    const tl = buildTimeline(scenes);
    const cues = useSub ? buildCues(scenes) : [];
    // 3) 렌더링
    const out = await render({ scenes, tl, cues, useZoom, subSize, writable, mock, t0 });
    // 4) 결과물
    const srt = buildSrt(buildCues(scenes));
    const chapters = buildChapters(scenes);
    showResult({ baseName, out, srt, chapters, dur: tl.total, secs: (performance.now() - t0) / 1000, mock, fileHandle });
  } catch (e) {
    console.error(e);
    try { await writable?.abort(); } catch { /* 무시 */ }
    const r = $("#result"); r.hidden = false; r.className = "result err"; r.innerHTML = "";
    r.append(el("h3", {}, state.cancel ? "중지됨" : "만들지 못했습니다"), el("div", {}, e.message || String(e)),
      el("p", { class: "hint" }, "다시 누르면 이미 만든 음성은 다시 쓰고, 나머지만 이어서 만듭니다."));
  } finally {
    state.building = false; $("#build").disabled = false; $("#cancel").hidden = true;
    try { await wakeLock?.release(); } catch { /* 무시 */ }
    refreshCacheInfo();
  }
}

async function prepareJobs(scenes, mock) {
  const flat = []; for (const sc of scenes) for (const l of sc.lines) flat.push(l);
  const jobs = [];
  for (let i = 0; i < flat.length; i++) {
    const l = flat[i];
    const who = state.single ? CFG.narrator : l.speaker;
    const v = state.cast[who] || castDefault(who);
    const emo = l.emotion || v.emotion || "smart";
    const inten = l.intensity ?? 1;
    const pieces = splitLong(l.text);
    l.pieces = [];
    for (let k = 0; k < pieces.length; k++) {
      let prev = k === 0 ? (flat[i - 1]?.text || "") : pieces[k - 1];
      let next = k === pieces.length - 1 ? (flat[i + 1]?.text || "") : pieces[k + 1];
      if (emo !== "smart") prev = next = "";
      const body = ttsBody(pieces[k], { ...v, voice_id: v.voice_id || "mock" }, emo, inten, prev, next);
      const job = { text: pieces[k], body, key: (mock ? "mock:" : "tts:") + await sha1(JSON.stringify(body)) };
      l.pieces.push(job); jobs.push(job);
    }
  }
  return jobs;
}

async function makeVoices(jobs, mock) {
  setStage("음성 확인 중…", 0);
  const todo = [];
  for (const j of jobs) {
    if (mock) { j.samples = Math.round(Math.max(0.8, charCount(j.text) * 0.16) * CFG.sampleRate); continue; }
    const rec = await idb.get(j.key);
    if (rec?.samples) j.samples = rec.samples; else todo.push(j);
  }
  if (!todo.length) return;
  const chars = todo.reduce((a, j) => a + j.text.length, 0);
  let done = 0, stop = false; const errors = [];
  const label = () => `음성 만드는 중 ${done}/${todo.length}줄 (약 ${chars.toLocaleString()}자${jobs.length > todo.length ? `, ${jobs.length - todo.length}줄은 저장된 음성 사용` : ""})`;
  setStage(label(), 0);
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length && !state.cancel && !stop) {
      const j = todo[idx++];
      try {
        const blob = await ttsRequest(j.body);
        const pcm = await decodeAudio(await blob.arrayBuffer());
        j.samples = pcm.length;
        await idb.put(j.key, { blob, samples: pcm.length });
      } catch (e) {
        if (e.fatal) { stop = true; errors.unshift(e); return; }
        errors.push(new Error(`‘${j.text.slice(0, 20)}…’ ${e.message}`));
      }
      done++; setStage(label(), done / todo.length * 0.25);
    }
  };
  await Promise.all(Array.from({ length: CFG.ttsConcurrency }, worker));
  if (errors.length) {
    const e = errors[0];
    throw new ApiError(e.fatal ? e.message : `${errors.length}줄의 음성을 만들지 못했습니다. 다시 누르면 실패한 줄만 다시 만듭니다.\n${e.message}`, true);
  }
  checkCancel();
}

function buildTimeline(scenes) {
  const sr = CFG.sampleRate;
  const segs = []; // {silence: n} | {job}
  let s = Math.round(CFG.startPad * sr); segs.push({ silence: s });
  const flat = []; scenes.forEach((sc, si) => sc.lines.forEach((l) => flat.push([si, l])));
  flat.forEach(([si, l], i) => {
    const sc = scenes[si];
    if (l === sc.lines[0]) sc.start = si === 0 ? 0 : s / sr;
    for (const p of l.pieces) { p.start = s / sr; p.dur = p.samples / sr; segs.push({ job: p }); s += p.samples; }
    let gap;
    if (i + 1 < flat.length) {
      const [nsi, nl] = flat[i + 1];
      gap = nsi !== si ? CFG.gapScene : nl.speaker !== l.speaker ? CFG.gapSpeaker : CFG.gapSame;
    } else gap = CFG.endPad;
    const g = Math.round(gap * sr); segs.push({ silence: g }); s += g;
  });
  const total = s / sr;
  scenes.forEach((sc, i) => (sc.end = i + 1 < scenes.length ? scenes[i + 1].start : total));
  return { segs, total, totalSamples: s };
}

function buildCues(scenes) {
  const cues = [];
  for (const sc of scenes) for (const l of sc.lines) {
    const dialog = l.speaker !== CFG.narrator;
    for (const p of l.pieces) {
      const parts = splitSubtitle(p.text, CFG.lineMax);
      const tot = parts.reduce((a, x) => a + x.n, 0);
      let t = p.start;
      for (const x of parts) { const d = p.dur * x.n / tot; cues.push({ start: t, end: t + d, lines: x.lines, dialog }); t += d; }
    }
  }
  for (let i = 0; i + 1 < cues.length; i++) { const gap = cues[i + 1].start - cues[i].end; if (gap > 0 && gap < 0.25) cues[i].end = cues[i + 1].start; }
  return cues;
}
function buildSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join("\n")}\n`).join("\n");
}
function buildChapters(scenes) {
  const ch = scenes.filter((s) => s.chapter);
  if (!ch.length) return "";
  const out = [];
  if (ch[0] !== scenes[0]) out.push("0:00 오프닝");
  for (const s of ch) out.push(`${clock(s === scenes[0] ? 0 : s.start)} ${s.chapter}`);
  return out.join("\n") + "\n";
}

// 음성 이어 붙이기 (필요한 만큼씩 꺼내 씀)
class AudioReader {
  constructor(segs, mock) { this.segs = segs; this.mock = mock; this.i = 0; this.off = 0; this.cur = null; }
  async ensure() {
    const seg = this.segs[this.i];
    if (!seg || seg.silence != null || this.mock) return;
    if (this.cur?.job !== seg.job) {
      const rec = await idb.get(seg.job.key);
      const pcm = await decodeAudio(await rec.blob.arrayBuffer());
      this.cur = { job: seg.job, pcm };
    }
  }
  async read(n) {
    const out = new Float32Array(n); let w = 0;
    while (w < n && this.i < this.segs.length) {
      const seg = this.segs[this.i];
      const len = seg.silence != null ? seg.silence : seg.job.samples;
      const take = Math.min(n - w, len - this.off);
      if (seg.silence == null && !this.mock) {
        await this.ensure();
        const src = this.cur.pcm;
        const end = Math.min(this.off + take, src.length);
        if (end > this.off) out.set(src.subarray(this.off, end), w);
      }
      w += take; this.off += take;
      if (this.off >= len) { this.i++; this.off = 0; if (seg.silence == null) this.cur = null; }
    }
    return out;
  }
}

async function pickCodecs() {
  const { W, H, fps } = CFG;
  const vCands = [
    { mux: "avc", cfg: { codec: "avc1.640028", width: W, height: H, bitrate: CFG.videoBitrate, framerate: fps, avc: { format: "avc" } } },
    { mux: "avc", cfg: { codec: "avc1.4d0028", width: W, height: H, bitrate: CFG.videoBitrate, framerate: fps, avc: { format: "avc" } } },
    { mux: "vp9", cfg: { codec: "vp09.00.40.08", width: W, height: H, bitrate: CFG.videoBitrate, framerate: fps } },
  ];
  let video = null;
  for (const c of vCands) {
    for (const hw of ["prefer-hardware", "no-preference"]) {
      const cfg = { ...c.cfg, hardwareAcceleration: hw, latencyMode: "quality" };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) { video = { mux: c.mux, cfg }; break; } } catch { /* 다음 */ }
    }
    if (video) break;
  }
  const aCands = [
    { mux: "aac", cfg: { codec: "mp4a.40.2", sampleRate: CFG.sampleRate, numberOfChannels: 1, bitrate: CFG.audioBitrate } },
    { mux: "opus", cfg: { codec: "opus", sampleRate: CFG.sampleRate, numberOfChannels: 1, bitrate: CFG.audioBitrate } },
  ];
  let audio = null;
  for (const c of aCands) { try { if ((await AudioEncoder.isConfigSupported(c.cfg)).supported) { audio = c; break; } } catch { /* 다음 */ } }
  if (!video || !audio) throw new Error("이 컴퓨터의 크롬에서 영상 인코딩을 지원하지 않습니다. 크롬을 최신 버전으로 업데이트하세요.");
  return { video, audio };
}

// 사진 불러오기 (화면을 덮는 크기로 미리 줄여서 메모리 절약)
async function loadBitmap(file, zoom) {
  if (!file) return null;
  let bmp = await createImageBitmap(file);
  const s = Math.max(CFG.W / bmp.width, CFG.H / bmp.height) * zoom;
  const tw = Math.ceil(bmp.width * s), th = Math.ceil(bmp.height * s);
  if (tw < bmp.width * 0.9) {
    const small = await createImageBitmap(bmp, { resizeWidth: tw, resizeHeight: th, resizeQuality: "high" });
    bmp.close(); bmp = small;
  }
  return bmp;
}

function drawSubtitle(ctx, cue, size) {
  const { W, H } = CFG;
  ctx.font = `bold ${size}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", "Noto Sans CJK KR", sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const lh = Math.round(size * 1.32);
  const widths = cue.lines.map((l) => ctx.measureText(l).width);
  const bw = Math.max(...widths) + size * 0.9, bh = lh * cue.lines.length + size * 0.45;
  const bx = (W - bw) / 2, by = H - CFG.subMargin - bh;
  ctx.fillStyle = "rgba(0,0,0,0.58)";
  const r = size * 0.22;
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, r) : ctx.rect(bx, by, bw, bh); ctx.fill();
  ctx.fillStyle = cue.dialog ? CFG.diaColor : CFG.narColor;
  cue.lines.forEach((l, i) => ctx.fillText(l, W / 2, by + size * 0.225 + lh * (i + 0.5)));
}

async function render({ scenes, tl, cues, useZoom, subSize, writable, mock, t0 }) {
  const { W, H, fps, sampleRate } = CFG;
  const codecs = await pickCodecs();
  const target = writable ? new Mp4Muxer.FileSystemWritableFileStreamTarget(writable) : new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: codecs.video.mux, width: W, height: H, frameRate: fps },
    audio: { codec: codecs.audio.mux, numberOfChannels: 1, sampleRate },
    fastStart: writable ? false : "in-memory",
    firstTimestampBehavior: "offset",
  });
  let encErr = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (encErr = e) });
  venc.configure(codecs.video.cfg);
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (encErr = e) });
  aenc.configure(codecs.audio.cfg);

  const canvas = $("#preview");
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingQuality = "high";
  const zoom = useZoom ? CFG.zoom : 1;

  // 장면별 사진 (번호 → 없으면 앞 장면 사진)
  const files = []; let lastF = null;
  scenes.forEach((sc) => { const idx = state.scenes.indexOf(sc); const f = imageFor(sc.num, idx) || lastF; files.push(f); lastF = f; });
  const bmpCache = new Map(); // 장면 index → Promise<bitmap>
  const getBmp = (i) => { if (i >= scenes.length) return null; if (!bmpCache.has(i)) bmpCache.set(i, loadBitmap(files[i], zoom)); return bmpCache.get(i); };

  const reader = new AudioReader(tl.segs, mock);
  const totalFrames = Math.max(1, Math.round(tl.total * fps));
  let si = 0, ci = 0, bmp = await getBmp(0); getBmp(1);
  let audioWritten = 0;
  const waitQueue = async (enc, max) => { while (enc.encodeQueueSize > max) { await new Promise((r) => enc.addEventListener("dequeue", r, { once: true })); } };
  const tStart = performance.now();

  for (let f = 0; f < totalFrames; f++) {
    if (state.cancel) throw new ApiError("중지했습니다.", true);
    if (encErr) throw encErr;
    const t = f / fps;
    // 1초마다 해당 구간 음성 넣기
    if (f % fps === 0) {
      const upto = Math.min(tl.totalSamples, Math.round((f / fps + 1) * sampleRate));
      const n = upto - audioWritten;
      if (n > 0) {
        const pcm = await reader.read(n);
        const ad = new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round(audioWritten / sampleRate * 1e6), data: pcm });
        aenc.encode(ad); ad.close(); audioWritten = upto;
        await waitQueue(aenc, 4);
      }
    }
    // 장면 바뀜
    while (si + 1 < scenes.length && t >= scenes[si + 1].start) {
      const old = bmpCache.get(si); bmpCache.delete(si);
      si++; bmp = await getBmp(si); getBmp(si + 1);
      old?.then((b) => { if (b && b !== bmp) b.close?.(); });
    }
    // 그림
    ctx.fillStyle = "#101418"; ctx.fillRect(0, 0, W, H);
    if (bmp) {
      const sc = scenes[si];
      const p = Math.min(1, Math.max(0, (t - sc.start) / Math.max(0.001, sc.end - sc.start)));
      const z = !useZoom ? 1 : (si % 2 === 0 ? 1 + (zoom - 1) * p : zoom - (zoom - 1) * p);
      const s = Math.max(W / bmp.width, H / bmp.height) * z;
      const dw = bmp.width * s, dh = bmp.height * s;
      ctx.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    while (ci < cues.length && cues[ci].end <= t) ci++;
    if (ci < cues.length && cues[ci].start <= t) drawSubtitle(ctx, cues[ci], subSize);

    const frame = new VideoFrame(canvas, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: f % (fps * 2) === 0 }); frame.close();
    await waitQueue(venc, 6);

    if (f % 15 === 0) {
      const el2 = (performance.now() - tStart) / 1000;
      const rate = (f + 1) / Math.max(0.001, el2);
      const left = (totalFrames - f) / rate;
      setStage(`영상 만드는 중 — 장면 ${si + 1}/${scenes.length} · ${clock(t)} / ${clock(tl.total)}`, 0.25 + 0.75 * f / totalFrames, f > fps * 3 ? `남은 시간 약 ${clock(left)}` : "");
    }
  }
  // 남은 음성
  if (audioWritten < tl.totalSamples) {
    const n = tl.totalSamples - audioWritten; const pcm = await reader.read(n);
    const ad = new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round(audioWritten / sampleRate * 1e6), data: pcm });
    aenc.encode(ad); ad.close();
  }
  setStage("마무리 중…", 0.99);
  await venc.flush(); await aenc.flush();
  if (encErr) throw encErr;
  venc.close(); aenc.close();
  muxer.finalize();
  for (const p of bmpCache.values()) p?.then((b) => b?.close?.());
  if (writable) { await writable.close(); return { saved: true, codec: codecs }; }
  return { saved: false, blob: new Blob([target.buffer], { type: "video/mp4" }), codec: codecs };
}

function showResult({ baseName, out, srt, chapters, dur, secs, mock, fileHandle }) {
  setStage("완료", 1, "");
  const r = $("#result"); r.hidden = false; r.className = "result"; r.innerHTML = "";
  const row = el("div", { class: "row" });
  if (!out.saved) row.append(el("button", { class: "btn", onclick: () => download(baseName + ".mp4", out.blob) }, "영상 저장"));
  row.append(
    el("button", { class: "btn ghost", onclick: () => download(baseName + "_자막.srt", new Blob(["﻿" + srt], { type: "text/plain" })) }, "자막 파일(.srt) 받기"),
  );
  if (chapters) row.append(el("button", { class: "btn ghost", onclick: () => { navigator.clipboard.writeText(chapters).then(() => toast("챕터 목록을 복사했습니다. 유튜브 설명란에 붙여넣으세요")); } }, "유튜브 챕터 복사"));
  r.append(...[
    el("h3", {}, "영상이 완성되었습니다"),
    el("div", {}, `길이 ${clock(dur)} · 만드는 데 ${clock(secs)} 걸림` + (out.saved ? ` · 저장: ${fileHandle?.name || baseName + ".mp4"}` : "")),
    mock ? el("div", { class: "hint" }, "무음 테스트라 소리는 없습니다. 사진 전환·자막만 확인하세요.") : null,
    out.codec?.video.mux !== "avc" ? el("div", { class: "hint" }, "이 컴퓨터는 VP9 방식으로 저장했습니다. 유튜브 업로드는 문제없습니다.") : null,
    row,
  ].filter(Boolean));
  if (chapters) r.append(el("pre", { class: "hint" }, chapters));
  if (!out.saved) download(baseName + ".mp4", out.blob);
}

async function refreshCacheInfo() {
  try { const n = await idb.count(); $("#cache-info").textContent = `저장된 음성 ${n}개`; } catch { /* 무시 */ }
}

// ───────────────────────── 시작 ─────────────────────────
async function loadChangelog() {
  try {
    const r = await fetch("changelog.json", { cache: "no-store" }); const log = await r.json();
    $("#version").textContent = "v" + log[0].version + " · " + log[0].date;
  } catch { /* 무시 */ }
}

async function init() {
  bridge.init(); setTimeout(updateExtState, 1600); loadChangelog();
  state.apiKey = await store.get("apiKey", "");
  state.cast = await store.get("cast", {});
  state.single = await store.get("single", true);
  $("#opt-single").checked = state.single;
  $("#opt-single").onchange = () => { state.single = $("#opt-single").checked; store.set("single", state.single); onScriptChange(); };
  if (state.apiKey) { $("#api-key").value = state.apiKey; $("#key-state").textContent = "✓ 저장됨"; $("#key-state").className = "state ok"; }
  $("#key-save").onclick = async () => {
    state.apiKey = $("#api-key").value.trim(); await store.set("apiKey", state.apiKey);
    $("#key-state").textContent = state.apiKey ? "✓ 저장됨" : ""; $("#key-state").className = "state ok";
    toast(state.apiKey ? "API 키를 저장했습니다" : "API 키를 지웠습니다");
    if (state.apiKey && !state.voices.length) loadVoices(true);
  };
  const ta = $("#script");
  ta.value = await store.get("script", "");
  let deb; ta.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(onScriptChange, 350); });
  $("#script-file").onchange = async (e) => { const f = e.target.files[0]; if (f) { ta.value = await f.text(); onScriptChange(); } e.target.value = ""; };
  $("#script-clear").onclick = () => { ta.value = ""; onScriptChange(); };
  $("#format-help-btn").onclick = () => ($("#format-help").hidden = !$("#format-help").hidden);
  $("#voices-load").onclick = () => loadVoices(true);

  const drop = $("#drop");
  $("#img-input").onchange = (e) => { addImages(e.target.files); e.target.value = ""; };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addImages(e.dataTransfer.files));
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); if (e.target.closest?.("#drop")) return; if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files); });
  $("#img-clear").onclick = () => { state.images.clear(); state.imageOrder = []; for (const u of thumbCache.values()) URL.revokeObjectURL(u); thumbCache.clear(); if (state.auto) onScriptChange(); else renderGrid(); };

  $("#build").onclick = build;
  $("#cancel").onclick = () => { state.cancel = true; setStage("중지하는 중…"); };
  $("#cache-clear").onclick = async () => { if (confirm("저장된 음성을 모두 지울까요? 다시 만들면 크레딧이 듭니다.")) { await idb.clear(); refreshCacheInfo(); toast("지웠습니다"); } };
  window.addEventListener("beforeunload", (e) => { if (state.building) { e.preventDefault(); e.returnValue = ""; } });

  onScriptChange();
  refreshCacheInfo();
  loadVoices(false);
}
init();

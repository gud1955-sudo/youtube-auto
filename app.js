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
  if (state.mode !== "typecast") { s.textContent = ""; return; }
  s.textContent = bridge.ready ? "✓ 확장 프로그램 연결됨" : "확장 프로그램 없음 (타입캐스트 사용 불가)";
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
  videos: new Map(),     // 장면번호 → [{part, file}] (영상 클립, 장면 앞부분에 순서대로 재생)
  sub: null,             // 구독·좋아요 영상 {file, mode: "full"|"key", sound: bool} — 브라우저에 계속 저장
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
// ───────────────────────── 브루 음성 모드 ─────────────────────────
const VREW_RATE = 24000; // 메모리 절약용 (영상에 넣을 때 48kHz 로 늘림)
state.mode = "vrew";
state.vrew = { pcm: null, dur: 0, audioName: "", srt: null, srtName: "" };

function parseSrt(text) {
  const t = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;
  const out = [];
  for (const block of text.replace(/^﻿/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((x) => x.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const m = lines[ti].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const txt = lines.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!txt) continue;
    const ms = (x) => x.padEnd(3, "0").slice(0, 3);
    out.push({ start: t(m[1], m[2], m[3], ms(m[4])), end: t(m[5], m[6], m[7], ms(m[8])), text: txt });
  }
  return out.sort((a, b) => a.start - b.start);
}

async function decodeAt(arrayBuffer, rate) {
  const ctx = new OfflineAudioContext(1, 1, rate);
  const buf = await ctx.decodeAudioData(arrayBuffer);
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels; }
  return out;
}

async function addVrewFiles(files) {
  for (const f of files) {
    if (/\.srt$/i.test(f.name)) {
      const cues = parseSrt(await f.text());
      if (!cues.length) { toast("자막 파일에서 자막을 찾지 못했습니다 (.srt 파일인지 확인)", 6000); continue; }
      state.vrew.srt = cues; state.vrew.srtName = f.name;
    } else if (f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg)$/i.test(f.name)) {
      $("#vrew-audio-name").textContent = "읽는 중…";
      try {
        const pcm = await decodeAt(await f.arrayBuffer(), VREW_RATE);
        state.vrew.pcm = pcm; state.vrew.dur = pcm.length / VREW_RATE; state.vrew.audioName = f.name;
      } catch (e) { toast("음성 파일을 읽지 못했습니다: " + (e.message || e), 6000); }
    } else toast(`${f.name}: 음성 파일이나 .srt 자막 파일이 아닙니다`, 5000);
  }
  updateVrewState(); onScriptChange();
}

function updateVrewState() {
  const v = state.vrew, st = $("#vrew-state");
  $("#vrew-audio-name").textContent = v.pcm ? `${v.audioName} (${clock(v.dur)})` : "없음";
  $("#vrew-srt-name").textContent = v.srt ? `${v.srtName} (자막 ${v.srt.length}줄)` : "없음";
  if (v.pcm && v.srt) {
    const last = v.srt[v.srt.length - 1].end;
    if (Math.abs(last - v.dur) > 20) { st.textContent = "음성과 자막 길이가 다름 — 같은 프로젝트에서 내보냈는지 확인"; st.className = "state warn"; }
    else { st.textContent = "✓ 준비됨"; st.className = "state ok"; }
  } else { st.textContent = v.pcm ? "자막 파일 필요" : v.srt ? "음성 파일 필요" : ""; st.className = "state warn"; }
}

// 자막 시간에 맞춰 장면 나누기
function vrewScenes() {
  const cues = state.vrew.srt; if (!cues?.length) return [];
  const total = state.vrew.dur || cues[cues.length - 1].end + 1;
  const norm = (x) => x.replace(/[\s\p{P}\p{S}]/gu, "");
  const cl = cues.map((c) => Math.max(1, norm(c.text).length));
  const cum = []; let acc = 0; for (const l of cl) { cum.push(acc); acc += l; }
  const totC = acc;
  const cueAt = (target) => { for (let i = 0; i < cues.length; i++) if (cum[i] + cl[i] / 2 > target) return i; return cues.length - 1; };
  const { scenes: marked, loose } = parseScript($("#script").value);
  const starts = [];
  state.vrewMarked = marked.length > 0;
  if (marked.length) {
    const lens = marked.map((sc) => sc.lines.reduce((x, l) => x + norm(l.text).length, 0));
    const totS = lens.reduce((x, y) => x + y, 0) || 1; let off = 0;
    marked.forEach((sc, i) => { starts.push({ ci: cueAt(off / totS * totC), num: sc.num, chapter: sc.chapter }); off += lens[i]; });
  } else {
    const n = Math.max(1, Math.min(cues.length, photoCount() || Math.round(total / 65)));
    for (let k = 0; k < n; k++) starts.push({ ci: cueAt(k * totC / n), num: k + 1, chapter: null });
  }
  starts[0].ci = 0;
  const fixed = [];
  for (const st of starts) { if (fixed.length && st.ci <= fixed[fixed.length - 1].ci) st.ci = fixed[fixed.length - 1].ci + 1; if (st.ci < cues.length) fixed.push(st); }
  const scenes = fixed.map((st, i) => {
    const endCi = i + 1 < fixed.length ? fixed[i + 1].ci : cues.length;
    return { num: st.num, chapter: st.chapter, lines: cues.slice(st.ci, endCi).map((c) => ({ speaker: CFG.narrator, text: c.text })), start: i === 0 ? 0 : cues[st.ci].start, ci: st.ci };
  });
  scenes.forEach((sc, i) => (sc.end = i + 1 < scenes.length ? scenes[i + 1].start : total));
  // 장면 표시 없이 [챕터] 만 있는 대본 → 글자 위치로 챕터 시간 맞추기
  if (!marked.length && loose.some((l) => l.chapter)) {
    const totS = loose.reduce((x, l) => x + norm(l.text).length, 0) || 1; let off = 0;
    for (const l of loose) {
      if (l.chapter) {
        const ci = cueAt(off / totS * totC);
        let si = scenes.length - 1; while (si > 0 && scenes[si].ci > ci) si--;
        if (!scenes[si].chapter) scenes[si].chapter = l.chapter;
      }
      off += norm(l.text).length;
    }
  }
  return scenes;
}

function vrewReader(pcm) {
  // 24kHz → 48kHz (2배) 로 늘려서 꺼내기
  let pos = 0;
  return {
    async read(n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (pos + i) / 2, i0 = Math.floor(x), fr = x - i0;
        if (i0 >= pcm.length) break;
        const a = pcm[i0], b = i0 + 1 < pcm.length ? pcm[i0 + 1] : a;
        out[i] = a + (b - a) * fr;
      }
      pos += n; return out;
    },
  };
}

function setMode(m) {
  state.mode = ["typecast", "google"].includes(m) ? m : "vrew";
  store.set("mode", state.mode);
  document.body.classList.toggle("mode-vrew", state.mode === "vrew");
  document.body.classList.toggle("mode-typecast", state.mode === "typecast");
  document.body.classList.toggle("mode-google", state.mode === "google");
  document.querySelectorAll("[data-mode]").forEach((e) => (e.hidden = e.dataset.mode !== state.mode));
  document.querySelectorAll("input[name=mode]").forEach((r) => (r.checked = r.value === state.mode));
  let n = 0; document.querySelectorAll("main > .card").forEach((c) => { const num = c.querySelector(".num"); if (num && !c.hidden) num.textContent = ++n; });
  if (state.mode === "vrew") $("#opt-mock").checked = false;
  updateExtState();
  onScriptChange();
}

function onScriptChange() {
  const text = $("#script").value; // 대본은 저장하지 않음 (새로고침하면 비워짐)
  if (state.mode === "vrew") {
    state.problems = [];
    state.auto = false; state.speakers = [];
    state.scenes = vrewScenes();
    renderSummary(); renderGrid(); return;
  }
  let { scenes, problems, loose } = parseScript(text);
  state.auto = false;
  if (!scenes.length && loose.length) {
    const est = estimate([{ lines: loose }]).secs;
    const n = photoCount() || Math.max(1, Math.round(est / 65));
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
  if (state.mode === "vrew") {
    st.textContent = ""; st.className = "state";
    if (!state.scenes.length) { box.append(el("div", { class: "msgs" }, "1번 칸에 브루 자막 파일(.srt)을 넣으면 장면이 나타납니다.")); return; }
    const k = (big, small) => el("div", { class: "k" }, el("b", {}, big), el("span", {}, small));
    const dur = state.vrew.dur || state.scenes[state.scenes.length - 1].end;
    box.append(
      k(`${state.scenes.length}개`, "장면 (= 필요한 사진 수)"),
      k(clock(dur), "영상 길이"),
      k(`약 ${Math.round(dur / state.scenes.length)}초`, "사진 한 장당"),
      k(`${state.scenes.filter((s) => s.chapter).length}개`, "챕터"),
    );
    box.append(el("div", { class: "msgs" }, state.vrewMarked
      ? "대본의 [장면] 표시 위치에 맞춰 자막 시간으로 장면을 나눴습니다."
      : photoCount() ? `사진 ${photoCount()}장에 맞춰 자막을 ${state.scenes.length}개 장면으로 고르게 나눴습니다.`
        : `약 1분마다 사진이 바뀌도록 ${state.scenes.length}개 장면으로 나눴습니다. 사진을 넣으면 사진 장수에 맞춰 다시 나눕니다.`));
    return;
  }
  if (!state.scenes.length) {
    st.textContent = $("#script").value.trim() ? "장면 번호를 찾지 못함" : ""; st.className = "state err";
    if ($("#script").value.trim()) box.append(el("div", { class: "msgs msg-err" }, "[장면 001] 같은 장면 번호 줄이 있어야 합니다. ‘대본 형식 보기’를 눌러 확인하세요."));
    return;
  }
  const e = estimate(state.scenes);
  const chapters = state.scenes.filter((s) => s.chapter).length;
  const k = (big, small) => el("div", { class: "k" }, el("b", {}, big), el("span", {}, small));
  box.append(...[
    k(`약 ${clock(e.secs)}`, "예상 영상 길이 (±15%)"),
    k(`${e.chars.toLocaleString()}자`, state.mode === "google" ? "글자 수 (무료 매달 100만 자)" : "글자 수 ≈ 크레딧"),
    chapters ? k(`${chapters}개`, "챕터") : null,
  ].filter(Boolean));
  if (state.auto) {
    box.append(el("div", { class: "msgs" }, "사진을 넣으면 넣은 장수에 맞춰 대본을 고르게 나눠 사진이 바뀝니다."));
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
    const SPEEDS = [[0.8, "아주 느리게"], [0.85, "느리게"], [0.9, "조금 느리게"], [0.95, "살짝 느리게"], [1.0, "보통"], [1.1, "조금 빠르게"], [1.2, "빠르게"], [1.3, "아주 빠르게"]];
    if (!SPEEDS.some(([v]) => v === +c.speed)) c.speed = 1.0;
    const speed = el("select", { title: "읽는 속도" }, ...SPEEDS.map(([v, t]) => el("option", { value: v }, `속도: ${t}`)));
    speed.value = String(c.speed); speed.onchange = () => { c.speed = +speed.value; saveCast(); };
    const emo = el("select", { title: "감정 표시가 없는 줄에 쓰는 기본 감정" });
    const fillEmo = () => {
      const isNew = modelFor(c.voice_id) === "ssfm-v30";
      const opts = isNew
        ? [["smart", "감정: 자동 (문맥 따라)"], ["normal", "감정: 보통"], ["tonedown", "감정: 차분하게"], ["toneup", "감정: 밝게"], ["sad", "감정: 슬프게"], ["happy", "감정: 기쁘게"]]
        : [["normal", "감정: 보통"], ["happy", "감정: 기쁘게"], ["sad", "감정: 슬프게"], ["angry", "감정: 화나게"]];
      emo.innerHTML = ""; for (const [v, t] of opts) emo.append(el("option", { value: v }, t));
      if (!opts.some(([v]) => v === c.emotion)) c.emotion = opts.some(([v]) => v === "normal") && name === CFG.narrator ? "normal" : opts[0][0];
      emo.value = c.emotion;
      emo.title = isNew ? "감정 표시가 없는 줄에 쓰는 기본 감정" : "구형 모델 목소리라 감정은 보통·기쁘게·슬프게·화나게만 됩니다";
    };
    fillEmo();
    emo.onchange = () => { c.emotion = emo.value; saveCast(); };
    const prevOnChange = sel.onchange;
    sel.onchange = () => { prevOnChange?.(); fillEmo(); saveCast(); };
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

const speedLabel = (v) => ({ 0.8: "아주 느리게", 0.85: "느리게", 0.9: "조금 느리게", 0.95: "살짝 느리게", 1: "보통 속도", 1.1: "조금 빠르게", 1.2: "빠르게", 1.3: "아주 빠르게" }[+v] || `속도 ${v}`);
const emoLabel = (e) => ({ smart: "감정 자동", normal: "감정 보통", tonedown: "차분하게", toneup: "밝게", sad: "슬프게", happy: "기쁘게", angry: "화나게" }[e] || e);
async function previewVoice(c, btn) {
  if (!c.voice_id) return toast("먼저 목소리를 고르세요");
  const player = $("#player");
  const v = state.voices.find((x) => x.id === c.voice_id);
  btn.disabled = true; const old = btn.textContent; btn.textContent = "…";
  try {
    // 지금 고른 속도·감정 그대로 짧은 샘플을 만들어 들려줌 (같은 설정은 저장해 두고 재사용)
    let blob;
    try {
      const body = ttsBody(CFG.previewSample, c, c.emotion || "normal", 1, "", "");
      const key = "pv:" + await sha1(JSON.stringify(body));
      let rec = await idb.get(key);
      if (!rec) { rec = { blob: await ttsRequest(body) }; await idb.put(key, rec); }
      blob = rec.blob;
    } catch (e) {
      if (e.fatal || !v?.preview) throw e;
      player.src = v.preview; await player.play();
      toast("샘플을 만들지 못해 기본 미리듣기를 재생합니다 (속도·감정 미반영)", 5000); return;
    }
    player.src = URL.createObjectURL(blob); await player.play();
    toast(`지금 설정(${speedLabel(c.speed)}, ${emoLabel(c.emotion)})으로 재생 중`, 3000);
  } catch (e) { toast("미리 듣기 실패: " + (e.message || e), 8000); }
  finally { btn.disabled = false; btn.textContent = old; }
}

// ───────────────────────── 화면: 사진 ─────────────────────────
// 압축 파일(zip)로 받은 사진도 풀어서 넣기 (Flow 컬렉션 일괄 다운로드 대비)
async function unzipImages(files) {
  const out = [];
  for (const f of files) {
    if (!/\.zip$/i.test(f.name) && f.type !== "application/zip" && f.type !== "application/x-zip-compressed") { out.push(f); continue; }
    if (typeof JSZip === "undefined") { toast("압축 파일을 열 수 없습니다. 압축을 푼 뒤 사진을 넣어주세요", 6000); continue; }
    toast(`${f.name} 압축 푸는 중…`, 8000);
    const zip = await JSZip.loadAsync(f);
    const entries = Object.values(zip.files).filter((z) => !z.dir && /\.(png|jpe?g|webp|mp4|webm|mov|m4v)$/i.test(z.name) && !/__MACOSX/.test(z.name));
    entries.sort((a, b) => (a.date - b.date) || a.name.localeCompare(b.name, "ko", { numeric: true }));
    for (const z of entries) {
      const blob = await z.async("blob");
      const base = z.name.split("/").pop();
      const type = /\.png$/i.test(base) ? "image/png" : /\.webp$/i.test(base) ? "image/webp" : /\.(mp4|m4v)$/i.test(base) ? "video/mp4" : /\.webm$/i.test(base) ? "video/webm" : /\.mov$/i.test(base) ? "video/quicktime" : "image/jpeg";
      out.push(new File([blob], base, { type, lastModified: z.date ? z.date.getTime() : Date.now() }));
    }
  }
  return out;
}

async function addImages(fileList) {
  const files = await unzipImages([...fileList]);
  // 영상 클립: 001-1.mp4, 001-2.mp4 처럼 장면 번호(+순서)로 이름 붙인 것
  const vids = files.filter((f) => f.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(f.name));
  let vAdded = 0, vSkipped = 0;
  for (const f of vids) {
    const m = f.name.match(/^\s*(\d{1,4})(?:\s*[-_]\s*(\d{1,2}))?(?!\d)/);
    if (!m) { vSkipped++; continue; }
    const num = +m[1], part = m[2] ? +m[2] : 0;
    const list = (state.videos.get(num) || []).filter((x) => x.part !== part);
    list.push({ part, file: f }); list.sort((a, b) => a.part - b.part);
    state.videos.set(num, list); vAdded++;
  }
  if (vSkipped) toast(`영상 ${vSkipped}개는 이름에 장면 번호가 없어 뺐습니다. 001-1.mp4 처럼 이름을 바꿔 넣어주세요`, 7000);
  const imgs = files.filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!imgs.length) {
    if (vAdded) { toast(`영상 클립 ${vAdded}개 추가`); if (state.auto || state.mode === "vrew") onScriptChange(); else renderGrid(); return; }
    return toast("사진·영상 파일이 아닙니다");
  }
  // 파일 이름이 숫자로 시작하면(001.png, 12_장면.jpg) 그 번호의 장면에 넣고,
  // 아니면(Flow 다운로드 이름 등) 다운로드한 순서대로 장면에 넣는다
  const lead = (f) => f.name.match(/^\s*(\d{1,4})(?!\d)/);
  const numbered = imgs.filter(lead);
  if (numbered.length >= imgs.length * 0.8) {
    for (const f of imgs) { const m = lead(f); if (m) state.images.set(+m[1], f); else state.imageOrder.push(f); }
    toast(`사진 ${imgs.length}장${vAdded ? ` · 영상 ${vAdded}개` : ""} 추가 (파일 이름 번호대로)`);
  } else {
    imgs.sort((a, b) => (a.lastModified - b.lastModified) || a.name.localeCompare(b.name, "ko", { numeric: true }));
    state.imageOrder.push(...imgs);
    toast(`사진 ${imgs.length}장${vAdded ? ` · 영상 ${vAdded}개` : ""} 추가 (다운로드한 순서대로)`, 4500);
  }
  if (state.auto || state.mode === "vrew") onScriptChange(); else renderGrid();
}
function imageFor(num, idx) {
  if (state.images.has(num)) return state.images.get(num);
  // 번호 없는 사진은 장면 순서대로
  return state.imageOrder[idx] || null;
}
const thumbCache = new Map();
function thumbURL(f) { if (!thumbCache.has(f)) thumbCache.set(f, URL.createObjectURL(f)); return thumbCache.get(f); }

function renderGrid() {
  drawClips?.();
  const g = $("#grid"); g.innerHTML = "";
  const st = $("#img-state");
  if (!state.scenes.length) {
    g.append(el("p", { class: "empty" }, state.images.size + state.imageOrder.length ? `사진 ${state.images.size + state.imageOrder.length}장 들어옴 — 대본을 넣으면 장면별로 보여줍니다.` : "대본을 넣으면 장면별 사진 칸이 생깁니다."));
    st.textContent = ""; return;
  }
  const first = clipScene();
  for (const [k, list] of [...state.videos]) if (k !== first && list.some((x) => x.part <= 2) && !state.scenes.some((sc) => sc.num === k)) { state.videos.delete(k); state.videos.set(first, [...(state.videos.get(first) || []), ...list].sort((a, b) => a.part - b.part)); }
  const info = state.scenes.map((sc, i) => ({ sc, i, f: imageFor(sc.num, i), nv: state.videos.get(sc.num)?.length || 0 }));
  const missList = info.filter((x) => !x.f && !x.nv);
  const total = info.length, have = total - missList.length;
  const nVid = info.reduce((a, x) => a + x.nv, 0);

  // 사진이 하나도 없으면 빈 칸을 늘어놓지 않고 안내만
  if (!have) {
    g.append(el("div", { class: "img-sum wait" },
      el("b", {}, "사진 아직 없음"),
      el("span", {}, "위 칸에 사진을 넣으면 장면마다 제대로 들어갔는지 여기서 바로 확인됩니다.")));
    st.textContent = ""; st.className = "state"; return;
  }

  // 요약 막대
  const sum = el("div", { class: "img-sum full" },
    el("b", {}, `✓ 사진 ${have}장 들어감`),
    nVid ? el("span", {}, ` · 🎬 영상 ${nVid}개`) : null);
  if (missList.length) {
    const nums = missList.slice(0, 20).map((x) => pad3(x.sc.num)).join(", ") + (missList.length > 20 ? " …" : "");
    sum.append(el("div", { class: "miss-nums" }, `사진 없는 번호: ${nums}`, el("small", {}, " — 사진이 없는 곳은 바로 앞 사진이 이어서 나옵니다")));
    const only = el("label", { class: "only-miss" }, el("input", { type: "checkbox", checked: !!state.onlyMiss, onchange: (e) => { state.onlyMiss = e.target.checked; renderGrid(); } }), " 빠진 장면만 보기");
    sum.append(only);
  }
  g.append(sum);

  const list = missList.length && state.onlyMiss ? missList : info;
  for (const { sc, f, nv } of list) {
    const why = state.gen?.failed?.get("S" + sc.num);
    const ph = el("div", { class: "ph" }, f ? "" : nv ? "🎬 영상" : why ? "생성 실패" : "비어 있음");
    if (f) ph.style.backgroundImage = `url("${thumbURL(f)}")`;
    if (why) ph.title = why;
    const canRegen = state.gen?.scenes?.some((x) => x.num === sc.num);
    const regen = canRegen ? el("button", { class: "regen", title: "이 장면 사진 다시 만들기", onclick: (e) => { e.stopPropagation(); e.target.disabled = true; e.target.textContent = "…"; regenScene(sc.num); } }, "다시") : null;
    const vbadge = nv ? el("span", { class: "vbadge", title: "이 장면 앞부분에 영상 클립이 먼저 나오고, 남는 시간에 사진이 나옵니다" }, `🎬 영상 ${nv}개`) : null;
    const ok = f ? el("span", { class: "okbadge", title: f.name }, "✓") : null;
    g.append(el("div", { class: "tile" + (f || nv ? "" : " miss") }, ph, regen, vbadge, ok,
      el("div", { class: "cap" }, el("b", {}, pad3(sc.num)), sc.chapter ? `· ${sc.chapter}` : "", el("span", {}, f ? f.name : sc.lines[0].text))));
  }
  st.textContent = `✓ 사진 ${have}장`; st.className = "state ok";
}

// ───────────────────────── 맨 앞 하이라이트 영상 1·2 (첫 장면 앞부분에 순서대로) ─────────────────────────
const clipScene = () => state.scenes[0]?.num ?? 1;
function setClip(part, file) {
  const num = clipScene();
  // 다른 번호로 들어가 있던 같은 순서 영상도 정리
  for (const [k, list] of state.videos) { const l = list.filter((x) => x.part !== part); if (l.length) state.videos.set(k, l); else state.videos.delete(k); }
  if (file) { const l = state.videos.get(num) || []; l.push({ part, file }); l.sort((a, b) => a.part - b.part); state.videos.set(num, l); }
  renderGrid();
}
const clipURLs = {};
function drawClips() {
  document.querySelectorAll(".clip-slot").forEach((slot) => {
    const part = +slot.dataset.part;
    let f = null; for (const list of state.videos.values()) { const x = list.find((y) => y.part === part); if (x) f = x.file; }
    slot.querySelector(".clip-name").textContent = f ? "✓ " + f.name : "끌어다 놓거나 클릭";
    slot.classList.toggle("has", !!f);
    const v = slot.querySelector("video");
    if (clipURLs[part] && (!f || clipURLs[part].f !== f)) { URL.revokeObjectURL(clipURLs[part].u); delete clipURLs[part]; v.removeAttribute("src"); }
    if (f && !clipURLs[part]) { clipURLs[part] = { f, u: URL.createObjectURL(f) }; v.src = clipURLs[part].u; }
    v.hidden = !f; slot.querySelector(".clip-del").hidden = !f;
  });
}
function initClips() {
  document.querySelectorAll(".clip-slot").forEach((slot) => {
    const part = +slot.dataset.part, inp = slot.querySelector("input"), drop = slot.querySelector(".drop");
    const take = (f) => { if (!f) return; if (!(f.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(f.name))) return toast("영상 파일(mp4)을 넣어 주세요"); setClip(part, f); };
    inp.onchange = (e) => { take(e.target.files[0]); e.target.value = ""; };
    drop.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); take(e.dataTransfer.files[0]); };
    slot.querySelector(".clip-del").onclick = () => setClip(part, null);
    const v = slot.querySelector("video");
    v.onmouseenter = () => v.play().catch(() => {}); v.onmouseleave = () => { v.pause(); v.currentTime = 0; };
  });
  drawClips();
}

const SUB_VIDEO_ON = false; // 2026-11-01 구독·좋아요 영상 사용 중지 (멘트는 영상 맨 끝에만)
// ───────────────────────── 구독·좋아요 영상 (한 번 넣으면 브라우저에 계속 저장) ─────────────────────────
async function initSub() {
  const box = $("#sub-box"); if (!box) return;
  try { const r = await idb.get("subVideo"); if (r?.blob) state.sub = { file: new File([r.blob], r.name || "구독좋아요.mp4", { type: r.blob.type }), mode: r.mode || "full", sound: !!r.sound, hideSubs: r.hideSubs !== false }; } catch { /* 없음 */ }
  const save = () => state.sub && idb.put("subVideo", { blob: state.sub.file, name: state.sub.file.name, mode: state.sub.mode, sound: state.sub.sound, hideSubs: state.sub.hideSubs }).catch(() => toast("저장 공간이 부족해 다음에는 다시 넣어야 할 수 있습니다"));
  const set = (f) => {
    if (!f || !(f.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(f.name))) return toast("영상 파일(mp4)을 넣어 주세요");
    state.sub = { file: f, mode: state.sub?.mode || "full", sound: state.sub?.sound ?? false, hideSubs: state.sub?.hideSubs ?? true }; save(); draw(); toast("구독·좋아요 영상 저장됨 — 다음부터 자동으로 들어갑니다");
  };
  let url = null;
  const draw = () => {
    const has = !!state.sub;
    $("#sub-name").textContent = has ? state.sub.file.name : "없음";
    $("#sub-state").textContent = has ? "✓ 저장됨" : ""; $("#sub-state").className = "state" + (has ? " ok" : "");
    $("#sub-opts").hidden = !has; $("#sub-del").hidden = !has;
    const pv = $("#sub-preview");
    if (url) URL.revokeObjectURL(url); url = null;
    if (has) { url = URL.createObjectURL(state.sub.file); pv.src = url; pv.hidden = false; $("#sub-mode").value = state.sub.mode; $("#sub-sound").checked = state.sub.sound; $("#sub-hide").checked = state.sub.hideSubs; }
    else { pv.removeAttribute("src"); pv.hidden = true; }
  };
  $("#sub-input").onchange = (e) => { set(e.target.files[0]); e.target.value = ""; };
  const drop = $("#sub-drop");
  drop.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); set(e.dataTransfer.files[0]); };
  $("#sub-mode").onchange = (e) => { state.sub.mode = e.target.value; save(); };
  $("#sub-sound").onchange = (e) => { state.sub.sound = e.target.checked; save(); };
  $("#sub-hide").onchange = (e) => { state.sub.hideSubs = e.target.checked; save(); };
  $("#sub-del").onclick = async () => { state.sub = null; try { await idb.tx("readwrite", (s) => s.delete("subVideo")); } catch { /* 무시 */ } draw(); };
  draw();
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
  const useSub = $("#opt-sub").checked, useZoom = curMotion(), subSize = +$("#opt-subsize").value;
  CFG.lineMax = lineMaxFor(subSize);
  try { await loadSubFont(); } catch { /* 기본 글꼴 */ }

  // 확인
  const vrew = state.mode === "vrew";
  if (vrew) {
    if (!state.vrew.pcm) return toast("브루 음성 파일을 먼저 넣으세요");
    if (!state.vrew.srt) return toast("브루 자막 파일(.srt)을 먼저 넣으세요");
  }
  if (!state.scenes.length) return toast("대본을 먼저 넣으세요");
  if (!mock && state.mode === "google") {
    if (!state.g?.key) return toast("1번 칸에 구글 API 키를 먼저 저장하세요");
    if (!state.g.voice) return toast("목소리를 먼저 고르세요");
    gSyncCast();
  } else if (!mock && !vrew) {
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
    let tl, cues, srt;
    if (vrew) {
      const end = previewOnly ? scenes[scenes.length - 1].end : state.vrew.dur;
      const pcm = state.vrew.pcm.subarray(0, Math.min(state.vrew.pcm.length, Math.round(end * VREW_RATE)));
      tl = { total: pcm.length / VREW_RATE, totalSamples: pcm.length * 2, reader: vrewReader(pcm) };
      const all = state.vrew.srt.filter((c) => c.start < tl.total).map((c) => ({ start: c.start, end: Math.min(c.end, tl.total), lines: wrapLines(c.text, CFG.lineMax), dialog: false }));
      cues = useSub ? all : []; srt = buildSrt(all);
    } else {
      // 1) 음성
      const jobs = await prepareJobs(scenes, mock);
      await makeVoices(jobs, mock);
      checkCancel();
      // 2) 시간 계산
      tl = buildTimeline(scenes);
      cues = useSub ? buildCues(scenes) : [];
      srt = buildSrt(buildCues(scenes));
    }
    // 3) 렌더링
    const out = await render({ scenes, tl, cues, useZoom, subSize, writable, mock, t0 });
    // 4) 결과물
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

// ───────── 사진 움직임 (확대·축소·이동) ─────────
const MOTIONS = {
  none: "움직임 없음",
  alt: "천천히 확대·축소 (번갈아)",
  in: "천천히 확대만",
  out: "천천히 축소만",
  pan: "천천히 좌우 이동",
  kb: "확대하며 옆으로 이동",
};
const curMotion = () => ({ kind: $("#opt-motion")?.value || "alt", str: +($("#opt-motion-str")?.value || CFG.zoom) });
function motionAt(m, p, si) {
  const S = m.str, ease = p * p * (3 - 2 * p) * 0.35 + p * 0.65; // 부드럽게
  const dir = si % 2 === 0 ? 1 : -1;
  switch (m.kind) {
    case "none": return { z: 1, fx: 0 };
    case "in": return { z: 1 + (S - 1) * ease, fx: 0 };
    case "out": return { z: S - (S - 1) * ease, fx: 0 };
    case "pan": return { z: S, fx: dir * (-1 + 2 * ease) };
    case "kb": return { z: 1 + (S - 1) * ease, fx: dir * ease };
    default: return si % 2 === 0 ? { z: 1 + (S - 1) * ease, fx: 0 } : { z: S - (S - 1) * ease, fx: 0 };
  }
}
function drawMoving(ctx, bmp, m, p, si) {
  const { W, H } = CFG;
  const { z, fx } = motionAt(m, p, si);
  const s = Math.max(W / bmp.width, H / bmp.height) * z;
  const dw = bmp.width * s, dh = bmp.height * s;
  ctx.drawImage(bmp, (W - dw) / 2 + fx * (dw - W) / 2, (H - dh) / 2, dw, dh);
}

// ───────── 화면 미리보기 (자막 크기·움직임 확인용 애니메이션) ─────────
let pvImg = null, pvImgSrc = null;
async function pvSample() {
  const f = state.images.get(state.scenes[0]?.num) || [...state.images.values()][0] || state.imageOrder[0] || null;
  if (f === pvImgSrc && pvImg) return pvImg;
  pvImgSrc = f;
  if (f) { try { pvImg = await createImageBitmap(f); return pvImg; } catch { /* 아래 */ } }
  // 사진이 없으면 그림 예시
  const c = new OffscreenCanvas(1920, 1080), g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, 1080); sky.addColorStop(0, "#f2c58a"); sky.addColorStop(0.55, "#d98b5f"); sky.addColorStop(1, "#5a3b2e");
  g.fillStyle = sky; g.fillRect(0, 0, 1920, 1080);
  g.fillStyle = "#fbe7b5"; g.beginPath(); g.arc(1380, 420, 110, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#6b4a3a"; g.beginPath(); g.moveTo(0, 760); g.quadraticCurveTo(480, 560, 980, 720); g.quadraticCurveTo(1450, 860, 1920, 640); g.lineTo(1920, 1080); g.lineTo(0, 1080); g.fill();
  // 기와집
  g.fillStyle = "#2f2a2a"; g.beginPath(); g.moveTo(520, 640); g.quadraticCurveTo(760, 560, 1000, 640); g.lineTo(940, 600); g.quadraticCurveTo(760, 530, 580, 600); g.fill();
  g.fillStyle = "#e9dcc4"; g.fillRect(600, 640, 340, 160); g.fillStyle = "#7a5236"; g.fillRect(730, 690, 80, 110);
  g.fillStyle = "rgba(255,255,255,.85)"; g.font = "bold 44px sans-serif"; g.textAlign = "left"; g.fillText("사진 예시 (사진을 넣으면 첫 사진으로 바뀝니다)", 60, 90);
  pvImg = c.transferToImageBitmap(); return pvImg;
}
function pvText() {
  const l = state.scenes[0]?.lines?.find((x) => x.text && x.text.length > 12)?.text;
  const t = l || "올해 예순여덟 살의 최순자, 읍내에서 제일 큰 기와집의 안주인이었습니다. 마을 사람 누구도 그녀 앞에서는 고개를 들지 못했습니다.";
  return t;
}
function initPreview() {
  const cv = $("#look"); if (!cv) return;
  const ctx = cv.getContext("2d"); ctx.imageSmoothingQuality = "high";
  loadSubFont();
  const CYCLE = 5; let on = false, t0 = performance.now(), raf = 0;
  const frame = async (now) => {
    if (!on) return;
    const t = Math.max(0, (now - t0) / 1000), si = Math.floor(t / CYCLE) % 2, p = (t % CYCLE) / CYCLE;
    const img = await pvSample();
    ctx.fillStyle = "#101418"; ctx.fillRect(0, 0, CFG.W, CFG.H);
    drawMoving(ctx, img, curMotion(), p, si);
    if ($("#opt-sub").checked) {
      const size = +$("#opt-subsize").value;
      const parts = splitSubtitle(pvText(), lineMaxFor(size));
      const part = parts[Math.floor(t / 2.5) % parts.length] || parts[0];
      if (part) drawSubtitle(ctx, { lines: part.lines, dialog: false }, size);
    }
    $("#look-cap").textContent = `${MOTIONS[curMotion().kind]} · 자막 ${$("#opt-font").selectedOptions[0].text} ${$("#opt-subsize").value}pt`;
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!on) { on = true; t0 = performance.now(); raf = requestAnimationFrame(frame); } };
  const stop = () => { on = false; cancelAnimationFrame(raf); };
  new IntersectionObserver((es) => (es[0].isIntersecting ? start() : stop())).observe(cv);
  // 설정 저장
  const keep = (id, key) => { const e = $(id); e.addEventListener("input", () => { store.set(key, e.value); if (id === "#opt-motion") t0 = performance.now(); }); };
  keep("#opt-subsize", "subSize"); keep("#opt-motion", "motion"); keep("#opt-motion-str", "motionStr"); keep("#opt-font", "subFont");
  $("#opt-font").addEventListener("input", loadSubFont);
  const out = $("#opt-subsize-val"); const sync = () => (out.textContent = $("#opt-subsize").value + "pt");
  $("#opt-subsize").addEventListener("input", sync);
  $("#subsize-minus").onclick = () => { const e = $("#opt-subsize"); e.value = +e.value - 2; e.dispatchEvent(new Event("input")); };
  $("#subsize-plus").onclick = () => { const e = $("#opt-subsize"); e.value = +e.value + 2; e.dispatchEvent(new Event("input")); };
  (async () => {
    $("#opt-subsize").value = await store.get("subSize", 86); $("#opt-motion").value = await store.get("motion", "alt");
    $("#opt-motion-str").value = await store.get("motionStr", "1.08");
    const sf = await store.get("subFont", "Jua|400"); if ([...$("#opt-font").options].some((o) => o.value === sf)) $("#opt-font").value = sf;
    loadSubFont(); sync();
  })();
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

// 자막 글꼴 (값 = "글꼴이름|굵기")
const subFontPick = () => ($("#opt-font")?.value || "Jua|400").split("|");
const subFontCss = (px) => { const [fam, w] = subFontPick(); return `${w} ${px}px "${fam}", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`; };
const loadSubFont = () => { const [fam, w] = subFontPick(); return document.fonts?.load(`${w} 80px "${fam}"`, "가나다라 한글").catch(() => {}); };
// 자막 한 줄 글자 수 (글자 크기에 맞춰 화면 폭 안에 들어가게)
const lineMaxFor = (size) => Math.max(14, Math.min(26, Math.floor((CFG.W - 240) / (size * 0.95))));
function drawSubtitle(ctx, cue, size) {
  const { W, H } = CFG;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const maxW = W - 200;
  ctx.font = subFontCss(size);
  let fs = size;
  const wMax = Math.max(...cue.lines.map((l) => ctx.measureText(l).width));
  if (wMax > maxW) { fs = Math.floor(size * maxW / wMax); ctx.font = subFontCss(fs); }
  const lh = Math.round(fs * 1.2);
  // 화면 폭 가득한 반투명 회색 띠 (구독·좋아요 영상과 같은 모양)
  const bh = lh * cue.lines.length + fs * 0.55;
  const bx = 40, bw = W - 80, by = H - 32 - bh;
  ctx.fillStyle = "rgba(150,150,150,0.55)";
  ctx.fillRect(bx, by, bw, bh);
  ctx.lineJoin = "round"; ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(6, fs * 0.16); ctx.strokeStyle = "#000";
  ctx.fillStyle = cue.dialog ? CFG.diaColor : CFG.narColor;
  cue.lines.forEach((l, i) => {
    const y = by + fs * 0.3 + lh * (i + 0.5);
    ctx.strokeText(l, W / 2, y); ctx.fillText(l, W / 2, y);
  });
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
  const zoom = useZoom.kind === "none" ? 1 : useZoom.str;

  // 장면별 사진 (번호 → 없으면 앞 장면 사진)
  const files = []; let lastF = null;
  scenes.forEach((sc) => { const idx = state.scenes.indexOf(sc); const f = imageFor(sc.num, idx) || lastF; files.push(f); lastF = f; });
  const bmpCache = new Map(); // 장면 index → Promise<bitmap>
  const getBmp = (i) => { if (i >= scenes.length) return null; if (!bmpCache.has(i)) bmpCache.set(i, loadBitmap(files[i], zoom)); return bmpCache.get(i); };

  // 장면별 영상 클립 (있으면 장면 앞부분에 순서대로, 남는 시간엔 그 장면 사진 또는 마지막 화면 유지)
  const ownImage = scenes.map((sc) => state.images.has(sc.num) || !!imageFor(sc.num, state.scenes.indexOf(sc)));
  const vidCache = new Map(); // 장면 index → Promise<[{el, dur, url}]>
  const loadVids = (i) => {
    if (i >= scenes.length) return null;
    if (!vidCache.has(i)) {
      const list = state.videos.get(scenes[i].num) || [];
      vidCache.set(i, Promise.all(list.map(({ file }) => new Promise((res) => {
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.preload = "auto";
        const url = URL.createObjectURL(file);
        v.onloadeddata = () => res({ el: v, dur: v.duration || 0, url });
        v.onerror = () => { toast(`영상 ${file.name} 을 열 수 없습니다 (mp4 권장)`, 6000); res(null); };
        v.src = url;
      }))).then((a) => a.filter(Boolean)));
    }
    return vidCache.get(i);
  };
  const seekTo = (v, time) => new Promise((res) => {
    if (Math.abs(v.currentTime - time) < 0.002 && v.readyState >= 2) return res();
    let done = false; const fin = () => { if (!done) { done = true; v.removeEventListener("seeked", fin); res(); } };
    v.addEventListener("seeked", fin); v.currentTime = time; setTimeout(fin, 3000);
  });
  let vids = await loadVids(0); loadVids(1);

  const reader = tl.reader || new AudioReader(tl.segs, mock);

  // 구독·좋아요 영상: 대본에서 '구독'이 처음 나오는 자막 시점에 재생
  let sub = null;
  if (SUB_VIDEO_ON && state.sub?.file) {
    const cue = cues.find((c) => /구독/.test(c.lines.join(" ")));
    if (!cue) toast("대본에 '구독' 문장이 없어 구독·좋아요 영상은 넣지 않았습니다", 6000);
    else {
      const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto";
      const url = URL.createObjectURL(state.sub.file);
      const ok = await new Promise((res) => { v.onloadeddata = () => res(true); v.onerror = () => res(false); v.src = url; });
      if (!ok) toast("구독·좋아요 영상을 열 수 없습니다 (mp4 권장)", 6000);
      else {
        sub = { el: v, url, start: cue.start, dur: v.duration || 0, key: state.sub.mode === "key", pcm: null, hideSubs: state.sub.hideSubs !== false };
        if (state.sub.sound && !mock) { try { sub.pcm = await decodeAt(await state.sub.file.arrayBuffer(), sampleRate); } catch { /* 소리 없는 영상 */ } }
        if (sub.key) { sub.cv = document.createElement("canvas"); sub.cv.width = W; sub.cv.height = H; sub.cx = sub.cv.getContext("2d", { willReadFrequently: true }); }
      }
    }
  }
  const mixSub = (pcm, at) => {
    if (!sub?.pcm) return pcm;
    const s0 = Math.round(sub.start * sampleRate);
    for (let i = 0; i < pcm.length; i++) { const k = at + i - s0; if (k >= 0 && k < sub.pcm.length) pcm[i] = Math.max(-1, Math.min(1, pcm[i] + sub.pcm[k] * 0.8)); }
    return pcm;
  };
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
        const pcm = mixSub(await reader.read(n), audioWritten);
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
      const oldV = vidCache.get(si - 1); vidCache.delete(si - 1);
      oldV?.then((a) => a.forEach((x) => { x.el.removeAttribute("src"); x.el.load(); URL.revokeObjectURL(x.url); }));
      vids = await loadVids(si); loadVids(si + 1);
    }
    // 그림
    ctx.fillStyle = "#101418"; ctx.fillRect(0, 0, W, H);
    const scNow = scenes[si], ts = t - scNow.start;
    const vTotal = vids.reduce((a, x) => a + x.dur, 0);
    let drewVideo = false;
    if (vids.length && (ts < vTotal || !ownImage[si])) {
      // 영상 구간: 해당 클립의 해당 시점 화면 (영상이 끝났고 사진이 없으면 마지막 화면 유지)
      let k = 0, acc = 0;
      while (k < vids.length - 1 && ts >= acc + vids[k].dur) { acc += vids[k].dur; k++; }
      const v = vids[k].el, at = Math.min(Math.max(0, ts - acc), Math.max(0, vids[k].dur - 0.05));
      await seekTo(v, at);
      const s = Math.max(W / v.videoWidth, H / v.videoHeight);
      const dw = v.videoWidth * s, dh = v.videoHeight * s;
      ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      drewVideo = true;
    }
    if (bmp && !drewVideo) {
      const sc = scNow;
      const st = sc.start + (vids.length ? vTotal : 0);
      const p = Math.min(1, Math.max(0, (t - st) / Math.max(0.001, sc.end - st)));
      drawMoving(ctx, bmp, useZoom, p, si);
    }
    const subOn = sub && t >= sub.start && t < sub.start + sub.dur;
    if (subOn) {
      const v = sub.el; await seekTo(v, Math.min(t - sub.start, Math.max(0, sub.dur - 0.05)));
      const s = Math.max(W / v.videoWidth, H / v.videoHeight), dw = v.videoWidth * s, dh = v.videoHeight * s;
      if (!sub.key) ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      else {
        // 초록 배경 지우고 사진 위에 겹치기
        sub.cx.clearRect(0, 0, W, H); sub.cx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
        const im = sub.cx.getImageData(0, 0, W, H), d = im.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2], m = g - Math.max(r, b);
          if (m > 60) d[i + 3] = 0;
          else if (m > 25) { d[i + 3] = Math.round(255 * (60 - m) / 35); d[i + 1] = Math.max(r, b); }
        }
        sub.cx.putImageData(im, 0, 0); ctx.drawImage(sub.cv, 0, 0);
      }
    }
    while (ci < cues.length && cues[ci].end <= t) ci++;
    if (ci < cues.length && cues[ci].start <= t && !(subOn && sub.hideSubs)) drawSubtitle(ctx, cues[ci], subSize);

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
    const n = tl.totalSamples - audioWritten; const pcm = mixSub(await reader.read(n), audioWritten);
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
  state.mode = await store.get("mode", "google");
  if (state.mode !== "google") state.mode = "google"; // 브루·타입캐스트 방식은 화면에서 뺌 (구글 음성만)
  state.single = true;
  document.querySelectorAll("input[name=mode]").forEach((r) => (r.onchange = () => r.checked && setMode(r.value)));
  const vd = $("#vrew-drop");
  $("#vrew-input").onchange = (e) => { addVrewFiles([...e.target.files]); e.target.value = ""; };
  ["dragenter", "dragover"].forEach((ev) => vd.addEventListener(ev, (e) => { e.preventDefault(); vd.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => vd.addEventListener(ev, (e) => { e.preventDefault(); vd.classList.remove("over"); }));
  vd.addEventListener("drop", (e) => addVrewFiles([...e.dataTransfer.files]));
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
  ta.value = ""; store.set("script", ""); // 새로고침하면 대본은 비움 (다른 설정은 유지)
  let deb; ta.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(onScriptChange, 350); });
  // 파일 여러 개(챕터 1·2·3)를 한꺼번에 고르면 이름 순서대로 이어 붙임
  $("#script-file").onchange = async (e) => {
    const fs = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
    if (fs.length) {
      const texts = await Promise.all(fs.map(async (f) => (await f.text()).replace(/^\ufeff/, "").trim()));
      ta.value = texts.join("\n\n"); onScriptChange();
      if (fs.length > 1) toast("이 순서로 이어 붙였습니다: " + fs.map((f) => f.name).join(" → "), 6000);
    }
    e.target.value = "";
  };
  $("#script-clear").onclick = () => { ta.value = ""; onScriptChange(); };
  $("#format-help-btn").onclick = () => ($("#format-help").hidden = !$("#format-help").hidden);
  $("#voices-load").onclick = () => loadVoices(true);

  const drop = $("#drop");
  $("#img-input").onchange = (e) => { addImages(e.target.files); e.target.value = ""; };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addImages(e.dataTransfer.files));
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); if (e.target.closest?.("#drop, #vrew-drop")) return; if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files); });
  initSub(); initClips(); initPreview();
  $("#img-clear").onclick = () => { state.images.clear(); state.imageOrder = []; for (const u of thumbCache.values()) URL.revokeObjectURL(u); thumbCache.clear(); if (state.auto || state.mode === "vrew") onScriptChange(); else renderGrid(); };

  $("#build").onclick = build;
  $("#cancel").onclick = () => { state.cancel = true; setStage("중지하는 중…"); };
  $("#cache-clear").onclick = async () => { if (confirm("저장된 음성을 모두 지울까요? 다시 만들면 크레딧이 듭니다.")) { await idb.clear(); refreshCacheInfo(); toast("지웠습니다"); } };
  window.addEventListener("beforeunload", (e) => { if (state.building) { e.preventDefault(); e.returnValue = ""; } });

  setMode(state.mode);
  refreshCacheInfo();
  loadVoices(false);
}
init();

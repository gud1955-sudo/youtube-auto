/* 인생이야기 영상 제작기 — 구글 음성 (Google Cloud Text-to-Speech)
 * 대본만 넣으면 제작기 안에서 내레이션 음성을 만들고, 문장 단위 자막·장면 시간까지 자동으로 맞춘다.
 * 기존 음성 파이프라인(prepareJobs → makeVoices → buildTimeline → buildCues)을 그대로 쓰고,
 * 음성 요청 부분(ttsBody / ttsRequest / 목소리 목록)만 구글로 바꾼다.
 */
"use strict";

const GTTS = {
  host: PARAMS.get("tthost") || "https://texttospeech.googleapis.com",
  lang: "ko-KR",
  sampleRate: 24000,
  sample: "안녕하세요. 오늘도 귀한 이야기 한 편 들려드리겠습니다. 그날 밤, 방앗간의 불은 늦게까지 꺼지지 않았습니다.",
};
state.g = { key: "", voices: [], voice: "", speed: 1.0 };

const GENDER_G = { FEMALE: "여성", MALE: "남성", NEUTRAL: "중성" };
const tierOf = (name) => /Chirp3-HD|Chirp-HD/i.test(name) ? 0 : /Neural2/i.test(name) ? 1 : /Wavenet/i.test(name) ? 2 : /Standard/i.test(name) ? 4 : 3;
const TIER_LABEL = ["Chirp 3 HD (추천)", "Neural2", "WaveNet", "기타", "Standard"];

function gVoiceLabel(v) {
  const short = v.name.replace(/^ko-KR-/, "").replace(/-/g, " ");
  return `${short} · ${GENDER_G[v.ssmlGender] || ""}`;
}

async function gFetch(path, opts = {}, tries = 5) {
  const g = state.g;
  if (!g.key) throw new ApiError("1번 칸에 구글 API 키를 먼저 저장하세요.", true);
  const url = `${GTTS.host}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(g.key)}`;
  let last = "";
  for (let a = 0; a < tries; a++) {
    let r;
    try { r = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } }); }
    catch (e) { last = "인터넷 연결 문제"; await sleep(2000 * (a + 1)); continue; }
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* 무시 */ }
    if (r.ok) return j;
    const msg = j?.error?.message || txt.slice(0, 200);
    if (r.status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) throw new ApiError("구글 API 키가 잘못되었습니다. 1번 칸의 키를 확인하세요.", true);
    if (r.status === 403) {
      if (/billing/i.test(msg)) throw new ApiError("구글 클라우드 결제 계정이 연결되지 않았습니다. 사용 안내의 '결제 계정 연결'을 확인하세요.", true);
      if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) throw new ApiError("구글 클라우드에서 'Cloud Text-to-Speech API'가 켜져 있지 않습니다. 사용 안내의 'API 사용 설정'을 확인하세요.", true);
      throw new ApiError("구글 권한 오류: " + msg, true);
    }
    if (r.status === 400) { const e = new ApiError("구글 음성 요청 오류: " + msg, false); e.status = 400; e.detail = msg; throw e; }
    last = `HTTP ${r.status} ${msg.slice(0, 120)}`;
    await sleep((r.status === 429 ? 6000 : 2000) * (a + 1));
  }
  throw new ApiError("구글 음성 연결 실패 (" + last + "). 잠시 후 다시 시도하세요.", false);
}

// ── 기존 함수들을 모드에 따라 구글로 돌려쓰기 ──
const _ttsBody = ttsBody, _ttsRequest = ttsRequest;
ttsBody = function (text, v, emotion, intensity, prev, next) {
  if (state.mode !== "google") return _ttsBody(text, v, emotion, intensity, prev, next);
  return {
    engine: "google",
    input: { text },
    voice: { languageCode: GTTS.lang, name: v.voice_id },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: GTTS.sampleRate, speakingRate: +v.speed || 1 },
  };
};
ttsRequest = async function (body) {
  if (state.mode !== "google" && body.engine !== "google") return _ttsRequest(body);
  const { engine, ...req } = body;
  let j;
  try {
    j = await gFetch("/v1/text:synthesize", { method: "POST", body: JSON.stringify(req) });
  } catch (e) {
    // 일부 목소리는 속도 조절을 지원하지 않음 → 속도 없이 한 번 더
    if (e.status === 400 && /speaking|rate/i.test(e.detail || "") && req.audioConfig.speakingRate !== 1) {
      const r2 = { ...req, audioConfig: { ...req.audioConfig } }; delete r2.audioConfig.speakingRate;
      j = await gFetch("/v1/text:synthesize", { method: "POST", body: JSON.stringify(r2) });
    } else throw e;
  }
  if (!j?.audioContent) throw new ApiError("구글이 음성을 돌려주지 않았습니다.", false);
  const bin = Uint8Array.from(atob(j.audioContent), (c) => c.charCodeAt(0));
  return new Blob([bin], { type: "audio/wav" });
};

async function gLoadVoices(force) {
  const g = state.g, info = $("#g-voices-info");
  const cached = await store.get("gVoices", null);
  if (!force && cached?.list?.length && Date.now() - cached.at < 7 * 86400_000) { g.voices = cached.list; gRenderVoices(); return; }
  if (!g.key) { info.textContent = "API 키를 저장하면 목소리 목록을 불러옵니다"; return; }
  info.textContent = "목소리 목록 불러오는 중…";
  try {
    const j = await gFetch(`/v1/voices?languageCode=${GTTS.lang}`, {}, 3);
    g.voices = (j.voices || []).filter((v) => (v.languageCodes || []).includes(GTTS.lang))
      .map((v) => ({ name: v.name, ssmlGender: v.ssmlGender }))
      .sort((a, b) => tierOf(a.name) - tierOf(b.name) || a.name.localeCompare(b.name));
    await store.set("gVoices", { at: Date.now(), list: g.voices });
    gRenderVoices();
  } catch (e) { info.textContent = ""; toast(e.message, 8000); }
}

function gRenderVoices() {
  const g = state.g, sel = $("#g-voice"), info = $("#g-voices-info");
  sel.innerHTML = "";
  sel.append(el("option", { value: "" }, g.voices.length ? "— 목소리 선택 —" : "— API 키를 저장하면 목록이 나옵니다 —"));
  let tier = -1, grp = null;
  for (const v of g.voices) {
    const t = tierOf(v.name);
    if (t !== tier) { tier = t; grp = el("optgroup", { label: TIER_LABEL[t] }); sel.append(grp); }
    grp.append(el("option", { value: v.name }, gVoiceLabel(v)));
  }
  if (g.voice && !g.voices.some((v) => v.name === g.voice)) sel.append(el("option", { value: g.voice }, g.voice));
  sel.value = g.voice || "";
  info.textContent = g.voices.length ? `한국어 목소리 ${g.voices.length}개 · 무료 한도는 Chirp 3 HD 기준 매달 100만 자` : "";
  gSyncCast();
}

// 기존 파이프라인이 쓰는 "내레이션" 목소리 설정에 반영
function gSyncCast() {
  const g = state.g;
  state.cast[CFG.narrator] = { ...(state.cast[CFG.narrator] || {}), voice_id: g.voice, speed: g.speed, pitch: 0, emotion: "normal" };
  const st = $("#g-voice-state");
  st.textContent = g.voice ? "✓ 선택됨" : "목소리 선택 필요"; st.className = "state " + (g.voice ? "ok" : "warn");
}

async function gPreview(btn) {
  const g = state.g;
  if (!g.voice) return toast("먼저 목소리를 고르세요");
  btn.disabled = true; const old = btn.textContent; btn.textContent = "…";
  try {
    const body = ttsBody(GTTS.sample, { voice_id: g.voice, speed: g.speed }, "normal", 1, "", "");
    const key = "gpv:" + await sha1(JSON.stringify(body));
    let rec = await idb.get(key);
    if (!rec) { rec = { blob: await ttsRequest(body) }; await idb.put(key, rec); }
    const p = $("#player"); p.src = URL.createObjectURL(rec.blob); await p.play();
  } catch (e) { toast("미리 듣기 실패: " + (e.message || e), 8000); }
  finally { btn.disabled = false; btn.textContent = old; }
}

async function initGoogle() {
  const g = state.g;
  g.key = await store.get("gKey", "");
  g.voice = await store.get("gVoice", "");
  g.speed = +(await store.get("gSpeed", 1.0));
  if (g.key) { $("#g-key").value = g.key; $("#g-key-state").textContent = "✓ 저장됨"; $("#g-key-state").className = "state ok"; }
  $("#g-key-save").onclick = async () => {
    g.key = $("#g-key").value.trim(); await store.set("gKey", g.key);
    $("#g-key-state").textContent = g.key ? "✓ 저장됨" : ""; $("#g-key-state").className = "state ok";
    toast(g.key ? "구글 API 키를 저장했습니다" : "키를 지웠습니다");
    if (g.key) gLoadVoices(true);
  };
  $("#g-voice").onchange = (e) => { g.voice = e.target.value; store.set("gVoice", g.voice); gSyncCast(); };
  const sp = $("#g-speed");
  sp.value = String(g.speed); if (!sp.value) { sp.value = "1"; g.speed = 1; }
  sp.onchange = () => { g.speed = +sp.value; store.set("gSpeed", g.speed); gSyncCast(); };
  $("#g-play").onclick = (e) => gPreview(e.currentTarget);
  $("#g-voices-load").onclick = () => gLoadVoices(true);
  gRenderVoices();
  gLoadVoices(false);
}
initGoogle();

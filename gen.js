/* 인생이야기 영상 제작기 — 사진 자동 생성 (Google Gemini 이미지 API)
 * 코워크가 만든 "이미지 프롬프트" 텍스트를 읽어
 *   - 인물 참고 사진(얼굴 고정용)
 *   - 썸네일 A/B
 *   - 장면 사진 002~NNN
 * 을 만들고, 장면 사진은 바로 영상 제작기의 장면에 넣는다.
 */
"use strict";

const GEM = {
  host: PARAMS.get("ghost") || "https://generativelanguage.googleapis.com",
  models: {
    nb2: { id: "gemini-3.1-flash-image-preview", label: "Nano Banana 2 (고품질)", price: 0.067 },
    nb: { id: "gemini-2.5-flash-image", label: "Nano Banana (저렴)", price: 0.039 },
  },
  concurrency: 3,
  krw: 1400,
};
const STYLE_SUFFIX =
  " Photorealistic Korean drama still, natural skin texture, realistic lighting, shot on a full-frame camera — not an illustration, not a painting, not a cartoon, not anime." +
  " A single continuous photograph, one unbroken frame, no borders, no panels, no collage." +
  " No text, no letters, no watermark, no logo, no caption, no subtitle anywhere in the image." +
  " No letterbox, no black bars at the top or bottom; the image fills the entire frame edge to edge.";
const PORTRAIT_SUFFIX =
  " A clear, front-facing head-and-shoulders portrait, face fully visible and sharply in focus, plain softly blurred neutral background, even soft lighting." +
  " Photorealistic photograph, natural skin texture — not an illustration, not a painting, not a cartoon. No text, no watermark.";

state.gen = {
  key: "", model: "nb2",
  chars: [], thumbs: [], scenes: [], errors: [],
  refs: new Map(),     // 이름 → Blob (참고 사진)
  results: new Map(),  // "S002" / "TA" → {blob, url}
  failed: new Map(),   // "S037" → 이유
  running: false, stop: false,
};

// ───────── 프롬프트 파일 읽기 ─────────
// [인물] 이름 | 외형 고정 문구
// [인물사진] 이름 | 인물 사진용 프롬프트
// [썸네일 A] 프롬프트
// [장면 002] 프롬프트   ({이름} 을 쓰면 그 인물의 외형 고정 문구로 바뀌고 참고 사진이 함께 들어감)
function parsePromptFile(text) {
  const out = { chars: new Map(), thumbs: [], scenes: [], errors: [] };
  const RE = /^\[\s*(인물사진|인물|썸네일|장면|사진|이미지)\s*([^\]]*)\]\s*(.*)$/;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join(" ").replace(/\s+/g, " ").trim();
    const [k, p] = [cur.kind, cur.param.trim()];
    if (k === "인물" || k === "인물사진") {
      let name = p, rest = body;
      if (!name) { const m = body.match(/^([^|:]+)[|:]\s*(.*)$/); if (m) { name = m[1].trim(); rest = m[2].trim(); } }
      else if (/^[|:]/.test(rest)) rest = rest.replace(/^[|:]\s*/, "");
      if (!name || !rest) out.errors.push(`[${k}] 이름 또는 내용이 비어 있습니다`);
      else {
        const c = out.chars.get(name) || { name, desc: "", portrait: "" };
        if (k === "인물") c.desc = rest; else c.portrait = rest;
        out.chars.set(name, c);
      }
    } else if (k === "썸네일") {
      if (body) out.thumbs.push({ id: (p || String.fromCharCode(65 + out.thumbs.length)).toUpperCase(), prompt: body });
    } else {
      const n = parseInt(p, 10);
      if (!n) out.errors.push(`[${k} ${p}] 번호를 읽지 못했습니다`);
      else if (body) out.scenes.push({ num: n, prompt: body });
    }
    cur = null;
  };
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) continue;
    const m = line.match(RE);
    if (m) {
      flush();
      // [인물] 이름 | 문구 형태: 이름이 대괄호 밖에 있는 경우
      let param = m[2], rest = m[3];
      if ((m[1] === "인물" || m[1] === "인물사진") && !param.trim()) {
        const mm = rest.match(/^([^|:]+)[|:]\s*(.*)$/); if (mm) { param = mm[1]; rest = mm[2]; }
      }
      cur = { kind: m[1], param, body: rest ? [rest] : [] };
    } else if (cur && line) cur.body.push(line);
  }
  flush();
  const seen = new Set();
  for (const s of out.scenes) { if (seen.has(s.num)) out.errors.push(`장면 ${pad3(s.num)} 프롬프트가 두 번 나옵니다 (뒤의 것을 씀)`); seen.add(s.num); }
  out.scenes = [...new Map(out.scenes.map((s) => [s.num, s])).values()].sort((a, b) => a.num - b.num);
  out.chars = [...out.chars.values()];
  for (const c of out.chars) if (!c.desc) out.errors.push(`인물 '${c.name}' 의 외형 고정 문구([인물] 줄)가 없습니다`);
  return out;
}

// {이름} → 외형 고정 문구, 등장 인물 목록
function expandPrompt(prompt) {
  const used = [];
  let text = prompt.replace(/\{([^{}]+)\}/g, (m, name) => {
    const c = state.gen.chars.find((x) => x.name === name.trim());
    if (!c) return m;
    if (!used.includes(c)) used.push(c);
    return c.desc;
  });
  for (const c of state.gen.chars) if (c.desc && text.includes(c.desc) && !used.includes(c)) used.push(c);
  return { text, used };
}

// ───────── API ─────────
async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer()); let s = "";
  for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
  return btoa(s);
}
async function shrinkRef(blob) {
  // 참고 사진은 1024px 이하 JPEG 로 줄여서 보냄 (요청 크기·거부 줄이기)
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    return await c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  } catch { return blob; }
}

class GenError extends Error { constructor(msg, fatal) { super(msg); this.fatal = fatal; } }

async function gemGenerate(prompt, refChars, aspect) {
  const g = state.gen;
  if (!g.key) throw new GenError("Gemini API 키를 먼저 저장하세요.", true);
  const parts = [];
  const withRef = refChars.filter((c) => g.refs.has(c.name));
  if (withRef.length) {
    parts.push({ text: `Reference photos are attached, one per character, in this order: ${withRef.map((c) => c.desc.split(",")[0]).join("; ")}. Use each reference photo only for that character's face, hairstyle and identity, and keep them identical in the new image. Do not copy the reference photo's background, pose or framing.` });
    for (const c of withRef) {
      const b = await shrinkRef(g.refs.get(c.name));
      parts.push({ inlineData: { mimeType: b.type || "image/jpeg", data: await blobToB64(b) } });
    }
  }
  parts.push({ text: prompt });
  const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: aspect } } };
  const url = `${GEM.host}/v1beta/models/${GEM.models[g.model].id}:generateContent`;
  let last = "";
  for (let a = 0; a < 5; a++) {
    let r;
    try { r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": g.key }, body: JSON.stringify(body) }); }
    catch (e) { last = "인터넷 연결 문제"; await sleep(3000 * (a + 1)); continue; }
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* 무시 */ }
    if (r.ok) {
      const cand = j?.candidates?.[0];
      const img = cand?.content?.parts?.find((p) => p.inlineData || p.inline_data);
      if (img) {
        const d = img.inlineData || img.inline_data;
        const bin = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
        return new Blob([bin], { type: d.mimeType || d.mime_type || "image/png" });
      }
      const why = j?.promptFeedback?.blockReason || cand?.finishReason || "이미지 없음";
      const note = cand?.content?.parts?.find((p) => p.text)?.text;
      if (/SAFETY|PROHIBITED|BLOCK|OTHER|IMAGE_SAFETY/i.test(why)) throw new GenError(`안전 필터에 걸림 (${why}) — 프롬프트를 순화해 다시 만드세요`, false);
      last = why + (note ? `: ${note.slice(0, 80)}` : "");
      continue; // 가끔 글만 돌려줌 → 재시도
    }
    const msg = j?.error?.message || txt.slice(0, 200);
    if (r.status === 400 && /API key/i.test(msg)) throw new GenError("Gemini API 키가 잘못되었습니다.", true);
    if (r.status === 403) throw new GenError("권한 오류: " + msg + " (AI Studio 에서 이 키의 프로젝트에 결제가 설정됐는지 확인)", true);
    if (r.status === 400) throw new GenError("요청 오류: " + msg, false);
    if (r.status === 429 && /billing|free tier|limit: 0/i.test(msg)) throw new GenError("이미지 생성은 무료로 쓸 수 없습니다. AI Studio 에서 결제(Billing)를 설정하세요.", true);
    last = `HTTP ${r.status} ${msg.slice(0, 120)}`;
    await sleep((r.status === 429 ? 8000 : 3000) * (a + 1));
  }
  throw new GenError("생성 실패: " + last, false);
}

async function cachedGenerate(kind, prompt, refChars, aspect, fresh) {
  const refSig = refChars.filter((c) => state.gen.refs.has(c.name)).map((c) => c.name + ":" + state.gen.refs.get(c.name).size).join(",");
  const key = "img:" + await sha1([state.gen.model, aspect, prompt, refSig].join("|"));
  if (!fresh) { const rec = await idb.get(key); if (rec?.blob) return rec.blob; }
  const blob = await gemGenerate(prompt, refChars, aspect);
  await idb.put(key, { blob });
  return blob;
}

// ───────── 화면 ─────────
function setResult(id, blob) {
  const g = state.gen; const old = g.results.get(id);
  if (old) URL.revokeObjectURL(old.url);
  g.results.set(id, { blob, url: URL.createObjectURL(blob) });
  g.failed.delete(id);
  if (id.startsWith("S")) {
    const num = +id.slice(1);
    const ext = blob.type.includes("jpeg") ? "jpg" : "png";
    state.images.set(num, new File([blob], `${pad3(num)}.${ext}`, { type: blob.type }));
  }
}

function genSummary() {
  const g = state.gen, box = $("#gen-summary"); box.innerHTML = "";
  if (!g.scenes.length && !g.chars.length && !g.thumbs.length) { box.append(el("div", { class: "msgs" }, "코워크가 준 이미지 프롬프트를 붙여넣으면 인물·썸네일·장면 사진 목록이 나옵니다.")); return; }
  const n = g.scenes.length + g.thumbs.length + g.chars.filter((c) => c.portrait).length * 2;
  const won = Math.round(n * GEM.models[g.model].price * GEM.krw / 100) * 100;
  const k = (big, small) => el("div", { class: "k" }, el("b", {}, big), el("span", {}, small));
  box.append(
    k(`${g.chars.length}명`, "인물"),
    k(`${g.thumbs.length}장`, "썸네일"),
    k(`${g.scenes.length}장`, `장면 사진${g.scenes.length ? ` (${pad3(g.scenes[0].num)}~${pad3(g.scenes[g.scenes.length - 1].num)})` : ""}`),
    k(`약 ${won.toLocaleString()}원`, `전부 만들 때 (${GEM.models[g.model].label})`),
  );
  const done = g.scenes.filter((s) => g.results.has("S" + s.num)).length;
  if (g.scenes.length) box.append(el("div", { class: "msgs" }, `장면 사진 ${done}/${g.scenes.length}장 완료` + (g.failed.size ? ` · 실패 ${g.failed.size}장` : "")));
  if (g.errors.length) box.append(el("div", { class: "msgs" }, ...g.errors.slice(0, 6).map((e) => el("div", { class: "msg-warn" }, "· " + e))));
  if (state.scenes.length && g.scenes.length) {
    const want = state.scenes.length, have = g.scenes.length + 1;
    if (want !== have) box.append(el("div", { class: "msgs msg-warn" }, `· 대본 장면은 ${want}개인데 프롬프트는 장면 ${have}개분(001 썸네일 포함)입니다. 번호가 맞는지 확인하세요.`));
  }
}

function renderChars() {
  const g = state.gen, box = $("#gen-chars"); box.innerHTML = "";
  if (!g.chars.length) return;
  for (const c of g.chars) {
    const ref = g.refs.get(c.name);
    const img = el("div", { class: "ref" + (ref ? "" : " none") }, ref ? "" : "참고 사진 없음");
    if (ref) img.style.backgroundImage = `url("${URL.createObjectURL(ref)}")`;
    const cands = el("div", { class: "cands" });
    const upload = el("input", { type: "file", accept: "image/*", hidden: true });
    upload.onchange = async () => { const f = upload.files[0]; if (f) { await setRef(c.name, f); } };
    const make = el("button", { class: "btn ghost", onclick: () => makePortraits(c, cands, make) }, c.portrait ? "후보 2장 만들기" : "인물사진 프롬프트 없음");
    if (!c.portrait) make.disabled = true;
    box.append(el("div", { class: "char-row" },
      img,
      el("div", { class: "char-info" }, el("b", {}, c.name), el("span", { class: "hint" }, c.desc.slice(0, 120) + (c.desc.length > 120 ? "…" : "")),
        el("div", { class: "row" }, make, el("label", { class: "btn ghost" }, "내 사진 올리기", upload), ref ? el("button", { class: "btn ghost", onclick: () => setRef(c.name, null) }, "빼기") : null),
        cands)));
  }
}

async function setRef(name, blob) {
  if (blob) { state.gen.refs.set(name, blob); await idb.put("ref:" + name, { blob }); }
  else { state.gen.refs.delete(name); await idb.put("ref:" + name, { blob: null }); }
  renderChars(); toast(blob ? `${name} 참고 사진을 정했습니다` : `${name} 참고 사진을 뺐습니다`);
}

async function makePortraits(c, box, btn) {
  btn.disabled = true; btn.textContent = "만드는 중…"; box.innerHTML = "";
  try {
    const prompt = c.portrait + PORTRAIT_SUFFIX;
    c.take = (c.take ?? -2) + 2;
    const blobs = await Promise.all([0, 1].map((i) => cachedGenerate("portrait", prompt + ((c.take + i) ? ` (take ${c.take + i + 1})` : ""), [], "1:1", false)));
    for (const b of blobs) {
      const u = URL.createObjectURL(b);
      box.append(el("button", { class: "cand", title: "이 사진으로 정하기", onclick: () => setRef(c.name, b) }, el("img", { src: u, alt: "" })));
    }
    box.prepend(el("div", { class: "hint" }, "마음에 드는 사진을 누르면 참고 사진으로 정해집니다. 둘 다 별로면 한 번 더 누르세요."));
  } catch (e) { toast(e.message, 7000); }
  finally { btn.disabled = false; btn.textContent = "후보 2장 다시 만들기"; }
}

function renderThumbs() {
  const g = state.gen, box = $("#gen-thumbs"); box.innerHTML = "";
  for (const t of g.thumbs) {
    const r = g.results.get("T" + t.id);
    const ph = el("div", { class: "ph" }, r ? "" : g.failed.get("T" + t.id) || "아직 없음");
    if (r) ph.style.backgroundImage = `url("${r.url}")`;
    box.append(el("div", { class: "tile thumb" }, ph, el("div", { class: "cap" }, el("b", {}, "썸네일 " + t.id),
      el("div", { class: "row" },
        el("button", { class: "btn ghost", onclick: () => genOne("T" + t.id, true) }, r ? "다시" : "만들기"),
        r ? el("button", { class: "btn ghost", onclick: () => download(`썸네일_${t.id}.png`, r.blob) }, "저장") : null,
        r ? el("button", { class: "btn ghost", title: "이 썸네일을 장면 001 사진으로 씀", onclick: () => { state.images.set(1, new File([r.blob], "001.png", { type: r.blob.type })); state.gen.thumb001 = t.id; toast(`썸네일 ${t.id} 를 장면 001 사진으로 넣었습니다`); renderGrid(); } }, "001로 쓰기") : null))));
  }
}

function jobFor(id) {
  const g = state.gen;
  if (id.startsWith("T")) { const t = g.thumbs.find((x) => "T" + x.id === id); if (!t) return null; const e = expandPrompt(t.prompt); return { id, text: e.text + STYLE_SUFFIX, used: e.used, aspect: "16:9" }; }
  const s = g.scenes.find((x) => "S" + x.num === id); if (!s) return null;
  const e = expandPrompt(s.prompt); return { id, text: e.text + STYLE_SUFFIX, used: e.used, aspect: "16:9" };
}

async function genOne(id, fresh) {
  const j = jobFor(id); if (!j) return;
  try {
    setResult(id, await cachedGenerate(id, j.text, j.used, j.aspect, fresh));
    if (id === "TA" && !state.images.has(1)) { state.images.set(1, new File([state.gen.results.get(id).blob], "001.png", { type: "image/png" })); state.gen.thumb001 = "A"; }
  } catch (e) {
    state.gen.failed.set(id, e.message);
    if (e.fatal) throw e;
  } finally {
    if (id.startsWith("T")) renderThumbs(); else renderGrid();
    genSummary(); renderFailed(); $("#gen-retry").hidden = !state.gen.failed.size;
  }
}

async function genAll(onlyFailed) {
  const g = state.gen;
  if (g.running) return;
  if (!g.key) return toast("Gemini API 키를 먼저 저장하세요");
  const ids = [...g.thumbs.map((t) => "T" + t.id), ...g.scenes.map((s) => "S" + s.num)]
    .filter((id) => onlyFailed ? g.failed.has(id) : !g.results.has(id));
  if (!ids.length) return toast(onlyFailed ? "실패한 사진이 없습니다" : "이미 다 만들었습니다");
  const noRef = g.chars.filter((c) => !g.refs.has(c.name)).map((c) => c.name);
  if (noRef.length && !confirm(`참고 사진이 없는 인물: ${noRef.join(", ")}\n참고 사진 없이 만들면 장면마다 얼굴이 달라질 수 있습니다. 그래도 진행할까요?`)) return;
  g.running = true; g.stop = false;
  $("#gen-all").disabled = true; $("#gen-stop").hidden = false;
  const st = $("#gen-state"); let done = 0; const t0 = performance.now();
  const upd = () => {
    const el2 = (performance.now() - t0) / 1000, left = done ? el2 / done * (ids.length - done) : 0;
    st.textContent = `만드는 중 ${done}/${ids.length}` + (done > 2 ? ` · 남은 시간 약 ${clock(left)}` : ""); st.className = "state warn";
  };
  upd();
  let idx = 0, fatal = null;
  const worker = async () => {
    while (idx < ids.length && !g.stop && !fatal) {
      const id = ids[idx++];
      try { await genOne(id, onlyFailed); } catch (e) { fatal = e; }
      done++; upd();
    }
  };
  await Promise.all(Array.from({ length: GEM.concurrency }, worker));
  g.running = false; $("#gen-all").disabled = false; $("#gen-stop").hidden = true;
  if (fatal) { st.textContent = "중단됨"; st.className = "state err"; toast(fatal.message, 8000); }
  else if (g.stop) { st.textContent = "중지함"; st.className = "state warn"; }
  else if (g.failed.size) { st.textContent = `완료 · 실패 ${g.failed.size}장 (아래 [실패한 것만 다시])`; st.className = "state warn"; }
  else { st.textContent = "✓ 사진 완성"; st.className = "state ok"; }
  $("#gen-retry").hidden = !g.failed.size;
  renderFailed();
  if (state.mode === "vrew") onScriptChange(); else renderGrid();
}

function renderFailed() {
  const box = $("#gen-failed"); box.innerHTML = "";
  for (const [id, why] of state.gen.failed) box.append(el("div", { class: "msg-warn" }, `· ${id.startsWith("T") ? "썸네일 " + id.slice(1) : "장면 " + pad3(+id.slice(1))}: ${why}`));
}

async function onGenPromptsChange() {
  const text = $("#gen-prompts").value;
  store.set("genPrompts", text);
  const p = parsePromptFile(text);
  const g = state.gen;
  g.chars = p.chars; g.thumbs = p.thumbs; g.scenes = p.scenes; g.errors = p.errors;
  for (const c of g.chars) if (!g.refs.has(c.name)) { const r = await idb.get("ref:" + c.name); if (r?.blob) g.refs.set(c.name, r.blob); }
  // 이미 만든 사진(같은 프롬프트) 은 저장된 것 불러오기
  for (const id of [...g.thumbs.map((t) => "T" + t.id), ...g.scenes.map((s) => "S" + s.num)]) {
    if (g.results.has(id)) continue;
    const j = jobFor(id);
    const refSig = j.used.filter((c) => g.refs.has(c.name)).map((c) => c.name + ":" + g.refs.get(c.name).size).join(",");
    const rec = await idb.get("img:" + await sha1([g.model, j.aspect, j.text, refSig].join("|")));
    if (rec?.blob) { setResult(id, rec.blob); if (id === "TA" && !state.images.has(1)) state.images.set(1, new File([rec.blob], "001.png", { type: rec.blob.type })); }
  }
  genSummary(); renderChars(); renderThumbs();
  if (state.mode === "vrew") onScriptChange(); else renderGrid();
}

// 장면 칸의 [다시] 버튼에서 호출
async function regenScene(num) {
  if (!state.gen.key) return toast("Gemini API 키를 먼저 저장하세요");
  if (!state.gen.scenes.some((s) => s.num === num)) return toast("이 장면의 프롬프트가 없습니다");
  try { await genOne("S" + num, true); toast(`장면 ${pad3(num)} 을 다시 만들었습니다`); } catch (e) { toast(e.message, 7000); }
}

async function initGen() {
  const g = state.gen;
  g.key = await store.get("gemKey", "");
  g.model = await store.get("gemModel", "nb2");
  if (g.key) { $("#gem-key").value = g.key; $("#gem-key-state").textContent = "✓ 저장됨"; $("#gem-key-state").className = "state ok"; }
  const ms = $("#gem-model"); ms.innerHTML = "";
  for (const [k, v] of Object.entries(GEM.models)) ms.append(el("option", { value: k }, `${v.label} · 장당 약 ${Math.round(v.price * GEM.krw)}원`));
  ms.value = g.model; ms.onchange = () => { g.model = ms.value; store.set("gemModel", g.model); g.results.clear(); onGenPromptsChange(); };
  $("#gem-key-save").onclick = async () => {
    g.key = $("#gem-key").value.trim(); await store.set("gemKey", g.key);
    $("#gem-key-state").textContent = g.key ? "✓ 저장됨" : ""; $("#gem-key-state").className = "state ok";
    toast(g.key ? "Gemini API 키를 저장했습니다" : "키를 지웠습니다");
  };
  const ta = $("#gen-prompts");
  ta.value = await store.get("genPrompts", "");
  let deb; ta.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(onGenPromptsChange, 400); });
  $("#gen-file").onchange = async (e) => { const f = e.target.files[0]; if (f) { ta.value = await f.text(); onGenPromptsChange(); } e.target.value = ""; };
  $("#gen-all").onclick = () => genAll(false);
  $("#gen-retry").onclick = () => genAll(true);
  $("#gen-stop").onclick = () => { g.stop = true; $("#gen-state").textContent = "중지하는 중… (만들고 있는 사진까지만)"; };
  $("#gen-zip").onclick = saveAllImages;
  await onGenPromptsChange();
}

// 만든 사진 전부 폴더에 저장 (번호 이름으로)
async function saveAllImages() {
  const g = state.gen;
  const items = [...g.results.entries()];
  if (!items.length) return toast("아직 만든 사진이 없습니다");
  if (window.showDirectoryPicker) {
    try {
      const dir = await showDirectoryPicker({ mode: "readwrite" });
      for (const [id, r] of items) {
        const name = id.startsWith("T") ? `썸네일_${id.slice(1)}.png` : `${pad3(+id.slice(1))}.png`;
        const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(r.blob); await w.close();
      }
      if (state.images.has(1) && !g.results.has("S1")) { const fh = await dir.getFileHandle("001.png", { create: true }); const w = await fh.createWritable(); await w.write(state.images.get(1)); await w.close(); }
      toast(`사진 ${items.length}장을 저장했습니다`);
      return;
    } catch (e) { if (e.name === "AbortError") return; }
  }
  for (const [id, r] of items) download(id.startsWith("T") ? `썸네일_${id.slice(1)}.png` : `${pad3(+id.slice(1))}.png`, r.blob);
}

initGen();

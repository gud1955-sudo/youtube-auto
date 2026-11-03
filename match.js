/* 사진을 '프롬프트 내용'으로 장면에 맞추기
 * - Flow에 넣었던 장면 프롬프트(영어, "2. A wide shot ..." 형식)를 붙여넣으면
 * - 브라우저 안에서 CLIP(사진-글 짝 맞추기 AI)으로 사진마다 가장 비슷한 장면을 찾아
 * - 한 장면에 한 장씩 겹치지 않게(헝가리안 알고리즘) 배치한다. 무료, 사진은 밖으로 나가지 않음.
 */
const MATCH = {
  lib: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js",
  model: "Xenova/clip-vit-base-patch32",
  T: null, tok: null, txt: null, proc: null, vis: null,
};

// 프롬프트 목록 읽기: "2. ..." / "002. ..." / "[장면 002] ..." 줄로 시작하는 문단
function parsePromptList(raw) {
  const out = new Map(); let cur = null;
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const m = line.match(/^\s*(?:\[\s*장면\s*)?(\d{1,3})\s*(?:\]|[.)]|:)\s*(.*)$/);
    if (m && +m[1] > 0) { cur = +m[1]; out.set(cur, m[2].trim()); continue; }
    if (cur != null && line.trim()) out.set(cur, (out.get(cur) + " " + line.trim()).trim());
    if (!line.trim()) cur = cur; // 빈 줄은 그냥 넘김
  }
  return out;
}
// 모든 프롬프트에 똑같이 들어가는 문장(인물 외형 고정 문구·스타일 문장)을 빼서 '장면마다 다른 내용'만 남김
function distinctive(prompts) {
  const split = (t) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const freq = new Map();
  const all = [...prompts.values()].map(split);
  for (const ss of all) for (const s of new Set(ss.map((x) => x.toLowerCase()))) freq.set(s, (freq.get(s) || 0) + 1);
  const lim = Math.max(3, prompts.size * 0.25);
  const res = new Map();
  for (const [n, t] of prompts) {
    const keep = split(t).filter((s) => (freq.get(s.toLowerCase()) || 0) < lim)
      .map((s) => s.replace(/\b(photorealistic|cinematic|korean drama still|natural skin texture|realistic lighting|full-frame camera|16:9|no text|no watermark|no caption|no subtitle|no letterbox|no black bars)\b[^,.]*[,.]?/gi, "").trim())
      .filter((s) => s.length > 3);
    res.set(n, (keep.join(" ") || t).slice(0, 400));
  }
  return res;
}
// 헝가리안 알고리즘 (비용 최소화, 직사각형 허용) → 행마다 배정된 열 (-1 = 없음)
function hungarian(cost) {
  const n = cost.length, m = cost[0]?.length || 0, N = Math.max(n, m);
  const big = 1e6, a = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i < n && j < m ? cost[i][j] : big / 10)));
  const u = new Float64Array(N + 1), v = new Float64Array(N + 1), p = new Int32Array(N + 1), way = new Int32Array(N + 1);
  for (let i = 1; i <= N; i++) {
    p[0] = i; let j0 = 0; const minv = new Float64Array(N + 1).fill(Infinity), used = new Uint8Array(N + 1);
    do {
      used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= N; j++) if (!used[j]) {
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= N; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const ans = new Array(n).fill(-1);
  for (let j = 1; j <= N; j++) if (p[j] && p[j] <= n && j <= m) ans[p[j] - 1] = j - 1;
  return ans;
}
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function matchLoad(onStage) {
  if (MATCH.vis) return;
  onStage("AI 불러오는 중… (처음 한 번만 약 100MB 내려받음, 이후엔 바로)");
  MATCH.T = MATCH.T || await import(MATCH.lib);
  const { AutoTokenizer, CLIPTextModelWithProjection, AutoProcessor, CLIPVisionModelWithProjection, env } = MATCH.T;
  env.allowLocalModels = false;
  const opt = { dtype: "q8" };
  [MATCH.tok, MATCH.txt, MATCH.proc, MATCH.vis] = await Promise.all([
    AutoTokenizer.from_pretrained(MATCH.model), CLIPTextModelWithProjection.from_pretrained(MATCH.model, opt),
    AutoProcessor.from_pretrained(MATCH.model), CLIPVisionModelWithProjection.from_pretrained(MATCH.model, opt),
  ]);
}
async function embedTexts(texts) {
  const inputs = MATCH.tok(texts, { padding: true, truncation: true });
  const { text_embeds } = await MATCH.txt(inputs);
  const d = text_embeds.dims[1], data = text_embeds.data;
  return texts.map((_, i) => norm(data.slice(i * d, (i + 1) * d)));
}
const imgEmbCache = new WeakMap();
async function embedImage(file) {
  if (imgEmbCache.has(file)) return imgEmbCache.get(file);
  const url = URL.createObjectURL(file);
  try {
    const img = await MATCH.T.RawImage.read(url);
    const { image_embeds } = await MATCH.vis(await MATCH.proc(img));
    const e = norm(image_embeds.data); imgEmbCache.set(file, e); return e;
  } finally { URL.revokeObjectURL(url); }
}

// 실제 배치. embed 함수를 바꿔 끼울 수 있게(시험용) 분리
async function matchAssign({ files, prompts, embedT, embedI, onProgress }) {
  const nums = [...prompts.keys()].sort((a, b) => a - b);
  const texts = distinctive(prompts);
  const tE = await embedT(nums.map((n) => texts.get(n)));
  const iE = [];
  for (let i = 0; i < files.length; i++) { iE.push(await embedI(files[i])); onProgress?.(i + 1, files.length); }
  const sim = iE.map((e) => tE.map((t) => dot(e, t)));
  const asg = hungarian(sim.map((row) => row.map((s) => 1 - s)));
  return files.map((f, i) => {
    const j = asg[i]; if (j < 0) return { file: f, num: null };
    const row = sim[i], s = row[j];
    const second = Math.max(...row.filter((_, k) => k !== j));
    const best = row.indexOf(Math.max(...row));
    return { file: f, num: nums[j], score: s, sure: best === j && s - second > 0.012 };
  });
}

async function runPromptMatch() {
  const raw = $("#pm-text").value.trim();
  const st = $("#pm-state");
  const prompts = parsePromptList(raw);
  if (prompts.size < 2) { st.textContent = "프롬프트를 찾지 못했습니다. Flow에 넣었던 '2. ...', '3. ...' 형식 그대로 붙여넣어 주세요."; st.className = "hint msg-err"; return; }
  // 대상 사진: 썸네일(001) 칸에 넣은 사진은 빼고, 지금 들어 있는 장면 사진 전부
  const fixed = state.thumbFixed;
  const pool = [...new Set([...state.images.values(), ...state.imageOrder].filter((f) => f && f !== fixed))];
  if (!pool.length) { st.textContent = "먼저 아래 '장면 사진' 칸에 사진을 넣어 주세요."; st.className = "hint msg-err"; return; }
  const btn = $("#pm-run"); btn.disabled = true;
  try {
    await matchLoad((m) => { st.textContent = m; st.className = "hint"; });
    const res = await matchAssign({ files: pool, prompts, embedT: embedTexts, embedI: embedImage,
      onProgress: (i, n) => { st.textContent = `사진 살펴보는 중… ${i} / ${n}`; } });
    // 다시 배치 (001 썸네일은 그대로)
    for (const k of [...state.images.keys()]) if (!(fixed && k === clipScene())) state.images.delete(k);
    state.imageOrder = [];
    state.matchUnsure = new Set();
    let placed = 0;
    for (const r of res) if (r.num != null) { state.images.set(r.num, r.file); placed++; if (!r.sure) state.matchUnsure.add(r.num); }
    const left = res.filter((r) => r.num == null).length;
    st.textContent = `✓ 사진 ${placed}장을 내용에 맞는 장면에 넣었습니다` + (state.matchUnsure.size ? ` · 헷갈린 ${state.matchUnsure.size}장은 '확인'으로 표시했으니 한 번 봐 주세요` : "") + (left ? ` · 남은 ${left}장은 맞는 장면이 없어 뺐습니다` : "");
    st.className = "hint state ok";
    if (state.auto) onScriptChange(); else renderGrid();
  } catch (e) {
    console.error(e);
    st.textContent = "AI를 불러오지 못했습니다: " + (e.message || e) + " — 인터넷 연결을 확인하고 다시 눌러 주세요.";
    st.className = "hint msg-err";
  } finally { btn.disabled = false; }
}
function initPromptMatch() {
  const b = $("#pm-run"); if (!b) return;
  b.onclick = runPromptMatch;
  $("#pm-file").onchange = async (e) => { const f = e.target.files[0]; if (f) $("#pm-text").value = await f.text(); e.target.value = ""; };
}
if (typeof window !== "undefined") window.addEventListener("load", () => setTimeout(initPromptMatch, 0));
if (typeof module !== "undefined") module.exports = { parsePromptList, distinctive, hungarian, matchAssign, norm };

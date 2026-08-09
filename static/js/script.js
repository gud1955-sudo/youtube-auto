let jobData = null;

// ── 글자수 카운터 ──────────────────────────────────────────────
document.getElementById('reference_script').addEventListener('input', function () {
  const len = this.value.length;
  document.getElementById('charCountInput').textContent = len > 0 ? `${len.toLocaleString()}자` : '';
});

// ── 생성 시작 ─────────────────────────────────────────────────
async function startGeneration() {
  const title  = document.getElementById('story_title').value.trim();
  const script = document.getElementById('reference_script').value.trim();

  if (!title) { alert('영상 제목을 입력해주세요.'); return; }

  document.getElementById('genBtn').disabled = true;
  document.getElementById('progressSection').classList.remove('hidden');
  document.getElementById('resultSection').classList.remove('hidden');
  resetResults();
  setProgress(0, 14, '서버에 요청 중...');

  const fd = new FormData();
  fd.append('story_title',      title);
  fd.append('reference_script', script);

  try {
    const res  = await fetch('/generate', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { showError(data.error); return; }
    pollStatus(data.job_id);
  } catch (err) {
    showError('서버 연결 실패: ' + err.message);
  }
}

// ── 폴링 ─────────────────────────────────────────────────────
function pollStatus(jobId) {
  const interval = setInterval(async () => {
    try {
      const res  = await fetch(`/status/${jobId}`);
      const data = await res.json();
      jobData = data;

      setProgress(data.progress || 0, data.total || 14, data.current_task || '처리 중...');
      renderPartial(data);

      if (data.status === 'error') {
        clearInterval(interval);
        showError(data.error);
        document.getElementById('genBtn').disabled = false;
      }

      if (data.status === 'done') {
        clearInterval(interval);
        renderFinal(data);
        document.getElementById('genBtn').disabled = false;
        document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth' });
      }
    } catch (_) {}
  }, 1500);
}

// ── 부분 렌더 (실시간) ────────────────────────────────────────
function renderPartial(data) {
  if (data.setup) {
    showBlock('blockTitles');
    showBlock('blockMeta');
    showBlock('blockChars');
    showBlock('blockBase');
    showBlock('blockIntroPrompt');
    document.getElementById('outTitles').value      = data.setup.titles || '';
    document.getElementById('outMeta').value        = data.setup.youtube_meta || '';
    document.getElementById('outChars').value       = data.setup.character_table || '';
    document.getElementById('outThumbPrompt').value = data.setup.thumbnail_prompt || '';
    document.getElementById('outBase').value        = data.setup.character_base_prompts || '';
    document.getElementById('outIntroPrompt').value = data.setup.intro_video_prompts || '';
  }

  if (data.thumbnail_url) {
    document.getElementById('thumbBox').innerHTML =
      `<img src="${data.thumbnail_url}?t=${Date.now()}" alt="썸네일" style="width:100%;border-radius:var(--radius);" />`;
    const dl = document.getElementById('thumbDl');
    dl.href = data.thumbnail_url;
    dl.classList.remove('hidden');
  }

  if (data.chapters && data.chapters.length > 0) {
    showBlock('blockImgPrompts');
    showBlock('blockChapterTabs');
    renderChapters(data.chapters);
  }
}

// ── 최종 렌더 ─────────────────────────────────────────────────
function renderFinal(data) {
  renderPartial(data);
  showBlock('blockDownload');
}

// ── 챕터 렌더 ─────────────────────────────────────────────────
function renderChapters(chapters) {
  const imgList  = document.getElementById('imgPromptList');
  const tabBar   = document.getElementById('tabBar');
  const tabPanels = document.getElementById('tabPanels');

  imgList.innerHTML  = '';
  tabBar.innerHTML   = '';
  tabPanels.innerHTML = '';

  chapters.forEach((ch, idx) => {
    const scenes = ch.scenes || [];

    // 장면별 이미지 프롬프트 목록
    const item = document.createElement('div');
    item.className = 'img-prompt-item';
    const scenesHtml = scenes.map((s, si) => {
      const imgHtml = s.image_url
        ? `<img src="${s.image_url}?t=${Date.now()}" class="scene-img" alt="장면${si+1}" />
           <a class="btn-img-dl" href="${s.image_url}" download="ch${ch.chapter_num}_scene${si+1}.png">&#128229; 다운로드</a>`
        : `<div class="no-image" style="aspect-ratio:16/9;">이미지 생성 실패</div>`;
      return `
        <div class="scene-row">
          <span class="scene-badge">장면 ${si + 1}</span>
          <div class="scene-content">
            <div class="scene-img-wrap">${imgHtml}</div>
            <textarea class="result-textarea img-prompt-ta" rows="4" readonly>${esc(s.prompt)}</textarea>
            <button class="btn-copy scene-copy" onclick="copyField(this.previousElementSibling, this)">복사</button>
          </div>
        </div>`;
    }).join('');
    item.innerHTML = `<div class="img-prompt-label">챕터 ${ch.chapter_num} (${scenes.length}장면)</div>${scenesHtml}`;
    imgList.appendChild(item);

    // 탭 버튼
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (idx === 0 ? ' active' : '');
    btn.textContent = `챕터 ${ch.chapter_num}`;
    btn.onclick = () => switchTab(idx);
    tabBar.appendChild(btn);

    // 탭 패널 - 대본만
    const panel = document.createElement('div');
    panel.className = 'tab-panel' + (idx === 0 ? ' active' : '');
    panel.innerHTML = `
      <p class="result-label">&#128221; 대본</p>
      <textarea class="result-textarea" rows="22" readonly>${esc(ch.script)}</textarea>
      <p class="char-count">글자 수: ${ch.script ? ch.script.length.toLocaleString() : 0}자</p>`;
    tabPanels.appendChild(panel);
  });
}

function switchTab(idx) {
  document.querySelectorAll('.tab-btn').forEach((b, i)   => b.classList.toggle('active', i === idx));
  document.querySelectorAll('.tab-panel').forEach((p, i) => p.classList.toggle('active', i === idx));
}

// ── 전체 대본 다운로드 ────────────────────────────────────────
document.getElementById('downloadBtn').addEventListener('click', () => {
  if (!jobData) return;
  const title = document.getElementById('story_title').value.trim();
  let text = `■ ${title}\n\n`;

  if (jobData.intro) text += jobData.intro + '\n\n';
  (jobData.chapters || []).forEach(ch => {
    text += (ch.script || '') + '\n\n';
  });
  if (jobData.outro) text += jobData.outro + '\n';

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  const now = new Date();
  a.download = `대본_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── 전체 이미지 프롬프트 복사 ─────────────────────────────────
function copyAllImgPrompts(btn) {
  if (!jobData || !jobData.chapters) return;
  const text = jobData.chapters.map(ch => {
    const scenes = (ch.scenes || []).map((s, i) => `[장면${i+1}]\n${s.prompt || ''}`).join('\n\n');
    return `=== 챕터 ${ch.chapter_num} ===\n\n${scenes}`;
  }).join('\n\n');
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '복사됨!';
    setTimeout(() => { btn.textContent = '전체 복사'; }, 1800);
  });
}

// ── 유틸 ─────────────────────────────────────────────────────
function setProgress(done, total, taskText) {
  document.getElementById('taskText').textContent    = taskText;
  document.getElementById('progressLabel').textContent = `${done} / ${total}`;
  document.getElementById('progressBar').style.width  = `${total > 0 ? (done / total) * 100 : 0}%`;
}

function showError(msg) {
  document.getElementById('taskText').textContent  = '오류: ' + msg;
  document.getElementById('progressBar').style.background = 'var(--red)';
}

function showBlock(id) {
  document.getElementById(id).classList.remove('hidden');
}

function resetResults() {
  ['blockTitles','blockMeta','blockChars','blockBase','blockIntroPrompt',
   'blockImgPrompts','blockDownload','blockChapterTabs'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById('imgPromptList').innerHTML = '';
  document.getElementById('tabBar').innerHTML = '';
  document.getElementById('tabPanels').innerHTML = '';
  document.getElementById('thumbBox').innerHTML = '<span>생성 중...</span>';
  document.getElementById('thumbDl').classList.add('hidden');
}

function copyField(elOrId, btn) {
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  navigator.clipboard.writeText(el.value).then(() => {
    btn.textContent = '복사됨!';
    setTimeout(() => { btn.textContent = '복사'; }, 1800);
  });
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function pad(n) { return String(n).padStart(2, '0'); }

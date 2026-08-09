let jobData = null;
let startTime = null;
let timerInterval = null;

// ── 글자수 카운터 ──────────────────────────────────────────────
document.getElementById('prompts').addEventListener('input', function () {
  const lines = this.value.split('\n').filter(l => l.trim()).length;
  document.getElementById('charCountInput').textContent = lines > 0 ? `${lines}개 프롬프트` : '';
});

// ── 생성 시작 ─────────────────────────────────────────────────
async function startGeneration() {
  const prompts = document.getElementById('prompts').value.trim();
  if (!prompts) { alert('프롬프트를 입력해주세요.'); return; }

  document.getElementById('genBtn').disabled = true;
  document.getElementById('progressSection').classList.remove('hidden');
  document.getElementById('resultSection').classList.remove('hidden');
  document.getElementById('imageList').innerHTML = '';
  document.getElementById('progressBar').style.background = '';
  startTime = Date.now();
  startTimer();
  setProgress(0, 0, '서버에 요청 중...');

  const fd = new FormData();
  fd.append('prompts', prompts);

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

      setProgress(data.progress || 0, data.total || 0, data.current_task || '처리 중...');
      renderImages(data.images || []);

      if (data.status === 'error') {
        clearInterval(interval);
        stopTimer();
        showError(data.error);
        document.getElementById('genBtn').disabled = false;
      }

      if (data.status === 'done') {
        clearInterval(interval);
        stopTimer();
        document.getElementById('genBtn').disabled = false;
        document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth' });
      }
    } catch (_) {}
  }, 1500);
}

// ── 이미지 렌더 ───────────────────────────────────────────────
function renderImages(images) {
  const list = document.getElementById('imageList');
  list.innerHTML = '';
  images.forEach(img => {
    const div = document.createElement('div');
    div.className = 'scene-row';
    const imgHtml = img.image_url
      ? `<img src="${img.image_url}?t=${Date.now()}" class="scene-img" alt="사진${img.photo_num}" />
         <a class="btn-img-dl" href="${img.image_url}" download="사진${img.photo_num}.png">&#128229; 다운로드</a>`
      : `<div class="no-image" style="aspect-ratio:16/9;">생성 실패</div>`;
    const summaryHtml = img.summary
      ? `<p class="result-label" style="margin:0.5rem 0 0.2rem;">&#128204; ${esc(img.summary)}</p>` : '';
    div.innerHTML = `
      <span class="scene-badge">사진 ${img.photo_num}</span>
      <div class="scene-content">
        <div class="scene-img-wrap">${imgHtml}</div>
        ${summaryHtml}
        <textarea class="result-textarea img-prompt-ta" rows="3" readonly>${esc(img.prompt)}</textarea>
        <button class="btn-copy scene-copy" onclick="copyField(this.previousElementSibling, this)">복사</button>
      </div>`;
    list.appendChild(div);
  });
}

// ── 유틸 ─────────────────────────────────────────────────────
function setProgress(done, total, taskText) {
  document.getElementById('taskText').textContent = taskText;
  document.getElementById('progressLabel').textContent = total > 0 ? `${done} / ${total} 장` : '';
  document.getElementById('progressBar').style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
  updateTimeInfo(done, total);
}

function updateTimeInfo(done, total) {
  if (!startTime) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  let text = `경과 ${fmtTime(elapsed)}`;
  if (done > 0 && done < total) {
    const remaining = Math.max(0, Math.floor(elapsed / done * (total - done)));
    text += `  |  남은 시간 약 ${fmtTime(remaining)}`;
  } else if (done > 0 && done >= total) {
    text += `  |  완료`;
  }
  document.getElementById('timeInfo').textContent = text;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const el = document.getElementById('progressLabel');
    const match = el.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) updateTimeInfo(parseInt(match[1]), parseInt(match[2]));
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function fmtTime(sec) {
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s > 0 ? `${m}분 ${s}초` : `${m}분`;
}

function showError(msg) {
  document.getElementById('taskText').textContent = '오류: ' + msg;
  document.getElementById('progressBar').style.background = 'var(--red)';
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

let jobResults = null;

/* ══════════════════════════════════════════════
   1단계: 콘티 + 썸네일 생성
══════════════════════════════════════════════ */
async function startContiGen() {
  const title = document.getElementById('s1_title').value.trim();

  if (!title) { alert('영상 제목을 입력해주세요.'); return; }

  document.getElementById('s1Btn').disabled = true;
  document.getElementById('s1Progress').classList.remove('hidden');
  document.getElementById('contiResultWrap').classList.add('hidden');
  animateBar('s1Bar', 0);
  setTask('s1Task', '서버에 요청 중...');

  const fd = new FormData();
  fd.append('story_title', title);

  try {
    const res  = await fetch('/generate-conti', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { showStageError('s1Task', 's1Bar', data.error); return; }
    pollConti(data.job_id);
  } catch (err) {
    showStageError('s1Task', 's1Bar', '서버 연결 실패: ' + err.message);
  }
}

function pollConti(jobId) {
  // 진행 애니메이션: 3단계 (콘티→썸네일프롬프트→썸네일이미지)
  const steps = [30, 60, 90];
  let stepIdx = 0;

  const interval = setInterval(async () => {
    try {
      const res  = await fetch(`/status/${jobId}`);
      const data = await res.json();

      setTask('s1Task', data.current_task || '처리 중...');
      if (stepIdx < steps.length) animateBar('s1Bar', steps[stepIdx++]);

      if (data.status === 'error') {
        clearInterval(interval);
        showStageError('s1Task', 's1Bar', data.error);
        document.getElementById('s1Btn').disabled = false;
        return;
      }

      // 콘티 완성되면 바로 표시 (썸네일 기다리지 않음)
      if (data.conti_text && document.getElementById('contiResultWrap').classList.contains('hidden')) {
        document.getElementById('contiOutput').value = data.conti_text;
        document.getElementById('contiResultWrap').classList.remove('hidden');
        document.getElementById('thumbStatus').textContent = '썸네일 생성 중...';
      }

      if (data.status === 'done') {
        clearInterval(interval);
        animateBar('s1Bar', 100);
        setTask('s1Task', '완료!');
        document.getElementById('s1Btn').disabled = false;

        // 썸네일 표시
        if (data.thumbnail_url) {
          document.getElementById('thumbResult').innerHTML =
            `<img src="${data.thumbnail_url}?t=${Date.now()}" alt="썸네일" />`;
          const dlLink = document.getElementById('thumbDownload');
          dlLink.href = data.thumbnail_url;
          dlLink.classList.remove('hidden');
          document.getElementById('thumbStatus').textContent = '썸네일 완료';
        } else {
          document.getElementById('thumbStatus').textContent = '썸네일 생성 실패';
        }
      }
    } catch (_) {}
  }, 1500);
}

function copyContiToStage2() {
  const conti = document.getElementById('contiOutput').value;
  const title = document.getElementById('s1_title').value;
  document.getElementById('contiInput').value = conti;
  if (title) document.getElementById('s2_title').value = title;
  document.getElementById('stage2Card').scrollIntoView({ behavior: 'smooth' });
}

/* ══════════════════════════════════════════════
   2단계: 대본 + 챕터 이미지 생성
══════════════════════════════════════════════ */
async function startScriptGen() {
  const title    = document.getElementById('s1_title').value.trim();
  const conti    = document.getElementById('contiInput').value.trim();
  const chapters = document.getElementById('s2_chapters').value;

  if (!title) { alert('STEP 1에서 영상 제목을 먼저 입력해주세요.'); return; }
  if (!conti) { alert('콘티를 입력해주세요.'); return; }

  document.getElementById('s2Btn').disabled = true;
  document.getElementById('s2Progress').classList.remove('hidden');
  document.getElementById('resultSection').classList.add('hidden');
  setProgress(0, parseInt(chapters), '서버에 요청 중...');

  const fd = new FormData();
  fd.append('story_title',   title);
  fd.append('conti_text',    conti);
  fd.append('chapter_count', chapters);

  try {
    const res  = await fetch('/generate', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { showStageError('s2Task', 's2Bar', data.error); return; }
    pollScripts(data.job_id, parseInt(chapters));
  } catch (err) {
    showStageError('s2Task', 's2Bar', '서버 연결 실패: ' + err.message);
  }
}

function pollScripts(jobId, total) {
  const interval = setInterval(async () => {
    try {
      const res  = await fetch(`/status/${jobId}`);
      const data = await res.json();

      setProgress(data.progress || 0, data.total || total, data.current_task || '처리 중...');

      if (data.status === 'error') {
        clearInterval(interval);
        showStageError('s2Task', 's2Bar', data.error);
        document.getElementById('s2Btn').disabled = false;
        return;
      }

      if (data.status === 'done') {
        clearInterval(interval);
        jobResults = data;
        renderResults(data);
        document.getElementById('s2Btn').disabled = false;
      }
    } catch (_) {}
  }, 1500);
}

/* ══════════════════════════════════════════════
   결과 렌더링
══════════════════════════════════════════════ */
function renderResults(data) {
  document.getElementById('metaOutput').value = data.meta || '';

  const tabBar    = document.getElementById('tabBar');
  const tabPanels = document.getElementById('tabPanels');
  tabBar.innerHTML    = '';
  tabPanels.innerHTML = '';

  (data.results || []).forEach((ch, idx) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (idx === 0 ? ' active' : '');
    btn.textContent = `챕터 ${ch.chapter_num}`;
    btn.onclick = () => switchTab(idx);
    tabBar.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'tab-panel' + (idx === 0 ? ' active' : '');

    const imgHtml = ch.image_url
      ? `<img class="chapter-image" src="${ch.image_url}?t=${Date.now()}" alt="챕터 ${ch.chapter_num}" />
         <a class="btn-img-dl" href="${ch.image_url}" download="chapter_${String(ch.chapter_num).padStart(2,'0')}.png">&#128229; 이미지 다운로드</a>`
      : `<div class="no-image">이미지 생성 실패</div>`;

    panel.innerHTML = `
      <p class="chapter-title-result">챕터 ${ch.chapter_num}</p>
      <div class="chapter-result-grid">
        <div>
          <p class="result-label">&#128221; 대본</p>
          <textarea class="result-textarea" rows="16" readonly>${escHtml(ch.script)}</textarea>
          <p class="char-count">글자 수: ${ch.script ? ch.script.length : 0}자</p>
        </div>
        <div>
          <p class="result-label">&#128247; 생성 이미지</p>
          ${imgHtml}
          <p class="result-label" style="margin-top:0.8rem;">&#128288; 이미지 프롬프트</p>
          <textarea class="result-textarea" rows="5" readonly>${escHtml(ch.image_prompt)}</textarea>
        </div>
      </div>`;
    tabPanels.appendChild(panel);
  });

  document.getElementById('resultSection').classList.remove('hidden');
  document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth' });
}

function switchTab(idx) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
  document.querySelectorAll('.tab-panel').forEach((p, i) => p.classList.toggle('active', i === idx));
}

document.getElementById('downloadBtn').addEventListener('click', () => {
  if (!jobResults) return;
  const title = document.getElementById('s1_title').value.trim();
  let text = `제목: ${title}\n\n`;
  (jobResults.results || []).forEach(ch => {
    text += `=== 챕터 ${ch.chapter_num} ===\n\n${ch.script || ''}\n\n`;
  });
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  const now = new Date();
  a.download = `대본_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ══════════════════════════════════════════════
   유틸
══════════════════════════════════════════════ */
function setTask(id, text) {
  document.getElementById(id).textContent = text;
}

function animateBar(id, pct) {
  document.getElementById(id).style.width = pct + '%';
}

function setProgress(done, total, taskText) {
  setTask('s2Task', taskText);
  document.getElementById('s2Label').textContent = `${done} / ${total}`;
  animateBar('s2Bar', total > 0 ? (done / total) * 100 : 0);
}

function showStageError(taskId, barId, msg) {
  setTask(taskId, '오류: ' + msg);
  document.getElementById(barId).style.background = 'var(--red)';
}

function pad(n) { return String(n).padStart(2, '0'); }

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function copyMeta() {
  document.getElementById('metaOutput').select();
  document.execCommand('copy');
  event.target.textContent = '복사됨!';
  setTimeout(() => { event.target.textContent = '복사'; }, 1500);
}

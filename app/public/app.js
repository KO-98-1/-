// SW 표준 산출물 자동 작성 앱 — 화면 로직(빌드 없이 동작하는 순수 JS)
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STAGE_NAMES = { analysis: '분석', design: '설계', implementation: '구현', test: '시험' };
const STATUS_NAMES = { idle: '대기', running: '진행 중', paused: '검토 대기', done: '완료', failed: '실패', stopped: '중지됨', 'done-with-errors': '완료(오류 남음)', writing: '작성 중', written: '작성 완료' };

let settings = null;
let providers = [];
let stages = [];
let current = null; // 선택한 프로젝트 id
let events = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function toast(msg) { alert(msg); }

// ── 설정 ────────────────────────────────────────────────
async function loadSettings() {
  const r = await api('/api/settings');
  settings = r.settings; providers = r.providers; stages = r.stages;
  $('#run-model').textContent = modelLabel();
  $('#stage-checks').innerHTML = stages.map((s) => `<label class="check"><input type="checkbox" value="${s}" checked> ${STAGE_NAMES[s]}</label>`).join('');
  $('#run-review').checked = !!settings.review;
}

function modelLabel() {
  const p = providers.find((x) => x.id === settings.provider);
  return `모델: ${p ? p.name : settings.provider}${settings.model ? ` · ${settings.model}` : ''}`;
}

function openSettings() {
  let sel = settings.provider;
  const draw = () => {
    $('#provider-cards').innerHTML = providers.map((p) => `
      <div class="pcard ${p.id === sel ? 'on' : ''}" data-id="${p.id}">
        <div class="name">${esc(p.name)}</div>
        <div class="st ${p.available ? '' : 'no'}">${p.available ? (p.needsKey ? 'API 키 필요' : '설치됨 · 로그인된 계정 사용') : '설치되지 않음'}${p.agent ? ' · 파일 직접 편집 가능' : ''}</div>
      </div>`).join('');
    const p = providers.find((x) => x.id === sel);
    $('#s-model').placeholder = p?.modelHint || '';
    $('#lbl-key').hidden = !p?.needsKey;
    $('#lbl-base').hidden = sel !== 'openai';
    $('#s-key-state').textContent = settings.keys?.[sel] || '저장된 키 없음 (환경 변수도 사용 가능)';
    document.querySelectorAll('.pcard').forEach((el) => el.onclick = () => { sel = el.dataset.id; draw(); });
  };
  draw();
  $('#s-model').value = settings.model || '';
  $('#s-key').value = '';
  $('#s-base').value = settings.baseURL || '';
  $('#s-effort').value = settings.effort || '';
  $('#s-mode').value = settings.mode || 'auto';
  $('#s-conc').value = settings.concurrency || 4;
  $('#s-dir').value = settings.projectsDir || '';
  $('#s-test-result').textContent = '';
  const collect = () => {
    const body = { provider: sel, model: $('#s-model').value.trim(), baseURL: $('#s-base').value.trim(), effort: $('#s-effort').value, mode: $('#s-mode').value, concurrency: Number($('#s-conc').value), projectsDir: $('#s-dir').value.trim() };
    if ($('#s-key').value.trim()) body.keys = { [sel]: $('#s-key').value.trim() };
    return body;
  };
  $('#btn-save').onclick = async () => {
    try { const r = await api('/api/settings', { method: 'POST', body: collect() }); settings = r.settings; $('#run-model').textContent = modelLabel(); $('#dlg-settings').close(); refreshProjects(); }
    catch (e) { toast(e.message); }
  };
  $('#btn-test').onclick = async () => {
    $('#s-test-result').textContent = '확인 중…';
    try {
      settings = (await api('/api/settings', { method: 'POST', body: collect() })).settings;
      const r = await api('/api/settings/test', { method: 'POST' });
      $('#s-test-result').textContent = `✔ ${r.label} 응답: "${r.reply}" (${(r.ms / 1000).toFixed(1)}초)`;
    } catch (e) { $('#s-test-result').textContent = `✘ ${e.message}`; }
  };
  $('#dlg-settings').showModal();
}

// ── 프로젝트 ─────────────────────────────────────────────
async function refreshProjects() {
  const r = await api('/api/projects');
  $('#projects-dir').textContent = `폴더: ${r.dir}`;
  $('#project-list').innerHTML = r.projects.map((p) => `<li data-id="${esc(p.id)}" class="${p.id === current ? 'on' : ''}"><span>${esc(p.id)}</span><span class="hint">${STATUS_NAMES[p.status] || ''}</span></li>`).join('') || '<li class="hint">프로젝트가 없습니다</li>';
  document.querySelectorAll('#project-list li[data-id]').forEach((li) => li.onclick = () => selectProject(li.dataset.id));
}

async function selectProject(id) {
  current = id;
  refreshProjects();
  $('#empty').hidden = true;
  $('#project').hidden = false;
  await renderProject();
  const log = await api(`/api/projects/${encodeURIComponent(id)}/log`);
  $('#log').innerHTML = '';
  for (const ev of log.log) appendLog(ev);
  events?.close();
  events = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
  events.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'log') appendLog(ev);
    if (ev.type === 'state') renderJob(ev.state);
  };
}

async function renderProject() {
  const info = await api(`/api/projects/${encodeURIComponent(current)}`);
  $('#p-title').textContent = info.id;
  const c = info.config;
  $('#p-config').textContent = c.system_name
    ? `${c.system_name} · 서브시스템 ${c.subsystems.map((s) => `${s.id}(${s.name})`).join(', ')}`
    : '시스템명·서브시스템은 첫 실행 때 자료를 읽고 자동으로 제안됩니다';
  // 자료
  const byKind = {};
  for (const x of info.inputs) (byKind[x.kind] ||= []).push(x);
  $('#input-list').innerHTML = info.inputs.length
    ? `<table class="grid inlist"><tbody>${info.inputs.map((x) => `<tr><td>${esc(x.kind)}</td><td>${esc(x.name)}</td><td class="hint">${(x.size / 1024).toFixed(1)} KB</td><td><button class="ghost danger" data-del="${esc(x.kind)}/${esc(x.name)}">삭제</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">아직 넣은 자료가 없습니다.</p>';
  document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const [kind, ...rest] = b.dataset.del.split('/');
    if (!confirm(`${rest.join('/')} 을(를) 삭제할까요?`)) return;
    await api(`/api/projects/${encodeURIComponent(current)}/inputs/${encodeURIComponent(kind)}/${encodeURIComponent(rest.join('/'))}`, { method: 'DELETE' });
    renderProject();
  });
  // 결과
  const groups = {};
  for (const f of info.outputs) { const g = f.path.includes('/') ? f.path.split('/')[0] : '(기타)'; (groups[g] ||= []).push(f); }
  $('#output-list').innerHTML = info.outputs.length
    ? `<div class="files">${Object.entries(groups).map(([g, fs]) => `<h4>${esc(g)}</h4><ul>${fs.map((f) => `<li><a href="/api/projects/${encodeURIComponent(current)}/file?path=${encodeURIComponent(f.path)}${f.path.endsWith('.md') ? '&inline=1' : ''}" ${f.path.endsWith('.md') ? 'target="_blank"' : ''}>${esc(f.path.split('/').slice(1).join('/') || f.path)}</a> <span class="hint">${(f.size / 1024).toFixed(0)} KB</span></li>`).join('')}</ul>`).join('')}</div>`
    : '<p class="hint">아직 만든 산출물이 없습니다.</p>';
  $('#btn-zip').href = `/api/projects/${encodeURIComponent(current)}/zip`;
  $('#skip-list').innerHTML = info.skipped.length
    ? `<table class="grid"><thead><tr><th>서브시스템</th><th>산출물</th><th>사유</th><th>필요한 자료</th></tr></thead><tbody>${info.skipped.map((k) => `<tr><td>${esc(k.sub)}</td><td>${esc(k.code)} ${esc(k.name)}</td><td>${esc(k.reason)}</td><td>${esc(k.needs)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">없음</p>';
  renderJob(info.job);
}

function renderJob(state) {
  const st = state?.status || 'idle';
  $('#p-status').className = `badge ${st}`;
  $('#p-status').textContent = STATUS_NAMES[st] || st;
  $('#btn-run').hidden = st === 'running' || st === 'paused';
  $('#btn-repair').hidden = st === 'running' || st === 'paused';
  $('#btn-stop').hidden = !(st === 'running' || st === 'paused');
  $('#btn-resume').hidden = st !== 'paused';
  $('#stage-status').innerHTML = stages.map((s) => {
    const v = state?.stageStatus?.[s] || 'idle';
    return `<span class="chip ${v}">${STAGE_NAMES[s]} · ${STATUS_NAMES[v] || v}</span>`;
  }).join('');
  const subs = Object.entries(state?.subs || {});
  $('#sub-status tbody').innerHTML = subs.map(([sub, x]) => `<tr><td>${esc(sub)}</td><td>${STAGE_NAMES[x.stage] || ''}</td><td>${STATUS_NAMES[x.status] || esc(x.status)}${x.error ? ` — ${esc(x.error)}` : ''}</td><td>${esc((x.docs || []).join(', '))}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">실행 기록이 없습니다</td></tr>';
  if (state?.error && st === 'failed') $('#p-status').title = state.error;
  if (['done', 'failed', 'stopped', 'paused'].includes(st) && current) { clearTimeout(renderJob.t); renderJob.t = setTimeout(() => api(`/api/projects/${encodeURIComponent(current)}`).then(() => renderProjectLists()), 300); }
}

async function renderProjectLists() {
  // 상태가 바뀌면 결과·생략 목록을 다시 읽는다(로그는 유지)
  const keep = $('#log').innerHTML;
  await renderProject();
  $('#log').innerHTML = keep;
  refreshProjects();
}

function appendLog(ev) {
  const el = $('#log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  const line = document.createElement('div');
  line.className = ev.level || '';
  line.textContent = `${new Date(ev.time).toLocaleTimeString('ko-KR')}  ${ev.msg}`;
  el.appendChild(line);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ── 수정사항 반영 ─────────────────────────────────────────
async function renderChanges() {
  if (!current) return;
  const box = $('#change-list');
  let r;
  try { r = await api(`/api/projects/${encodeURIComponent(current)}/changes`); } catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
  if (!r.changes.length) { box.innerHTML = '<p class="hint">수정사항 자료가 없습니다.</p>'; return; }
  box.innerHTML = r.changes.map((c) => {
    const rows = (c.review?.changes || []).map((x) => `<tr class="${x.conflict ? 'conflict' : ''}">
      <td><input type="checkbox" data-cr="${esc(c.id)}" value="${x.no}" ${x.conflict ? '' : 'checked'} ${c.applied ? 'disabled' : ''}></td>
      <td>${x.no}</td><td>${esc(x.summary)}<div class="hint">${esc(x.proposal || '')}</div></td>
      <td>${x.conflict ? `<b class="bad">충돌</b><div class="hint">${esc(x.conflict_reason || '')}</div>` : '-'}</td>
      <td class="hint">${(x.affected || []).map((a) => `${esc(a.sub)}: ${esc((a.docs || []).join(', '))}`).join('<br>')}</td></tr>`).join('');
    return `<div class="crbox">
      <div class="row between"><div><b>${esc(c.id)}</b> ${esc(c.title)} ${c.applied ? `<span class="badge done">반영됨 ${esc(String(c.applied.applied_at || '').slice(0, 10))}</span>` : c.review ? '<span class="badge">분석됨</span>' : ''}</div>
      <button data-analyze="${esc(c.id)}">${c.review ? '다시 분석' : '영향 분석'}</button></div>
      ${rows ? `<table class="grid"><thead><tr><th></th><th>번호</th><th>변경</th><th>충돌</th><th>영향 산출물</th></tr></thead><tbody>${rows}</tbody></table>
      ${c.applied ? '' : `<textarea rows="2" data-memo="${esc(c.id)}" placeholder="반영 시 참고할 메모(선택)"></textarea><button class="primary" data-apply="${esc(c.id)}">체크한 변경 반영</button>`}` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-analyze]').forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = '분석 중… (1~3분)';
    try { await api(`/api/projects/${encodeURIComponent(current)}/changes/${encodeURIComponent(b.dataset.analyze)}/analyze`, { method: 'POST' }); }
    catch (e) { toast(e.message); }
    renderChanges();
  });
  box.querySelectorAll('[data-apply]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.apply;
    const approved = [...box.querySelectorAll(`input[data-cr="${id}"]:checked`)].map((x) => Number(x.value));
    if (!approved.length) return toast('반영할 변경을 체크하세요');
    const memo = box.querySelector(`textarea[data-memo="${id}"]`)?.value || '';
    try { await api(`/api/projects/${encodeURIComponent(current)}/changes/${encodeURIComponent(id)}/apply`, { method: 'POST', body: { approved, memo } }); }
    catch (e) { toast(e.message); }
  });
}

// ── 자료 넣기 ────────────────────────────────────────────
async function uploadFiles(files, kind) {
  for (const f of files) {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try { await api(`/api/projects/${encodeURIComponent(current)}/inputs`, { method: 'POST', body: { kind, name: f.name, base64: btoa(bin) } }); }
    catch (e) { toast(`${f.name}: ${e.message}`); }
  }
  renderProject();
}

// ── 이벤트 연결 ───────────────────────────────────────────
$('#btn-settings').onclick = openSettings;
$('#form-new').onsubmit = async (e) => {
  e.preventDefault();
  try { const r = await api('/api/projects', { method: 'POST', body: { name: $('#new-name').value } }); $('#new-name').value = ''; await refreshProjects(); selectProject(r.id); }
  catch (err) { toast(err.message); }
};
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.hidden = t.id !== `tab-${b.dataset.tab}`);
  if (b.dataset.tab === 'results' && current) renderProjectLists();
  if (b.dataset.tab === 'run' && current) renderChanges();
});
$('#up-files').onchange = (e) => { uploadFiles([...e.target.files], $('#up-kind').value); e.target.value = ''; };
const drop = $('#drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files], $('#up-kind').value); };
$('#btn-paste').onclick = async () => {
  const text = $('#paste-text').value.trim();
  if (!text) return toast('붙여넣을 내용을 입력하세요');
  const title = $('#paste-name').value.trim() || `메모_${new Date().toISOString().slice(0, 10)}`;
  try {
    await api(`/api/projects/${encodeURIComponent(current)}/inputs`, { method: 'POST', body: { kind: $('#paste-kind').value, name: `${title.replace(/[\\/:*?"<>|]/g, '')}.md`, text: `# ${title}\n\n${text}\n` } });
    $('#paste-text').value = ''; $('#paste-name').value = '';
    renderProject();
  } catch (e) { toast(e.message); }
};
$('#btn-run').onclick = async () => {
  const chosen = [...document.querySelectorAll('#stage-checks input:checked')].map((x) => x.value);
  if (!chosen.length) return toast('실행할 단계를 고르세요');
  try { await api(`/api/projects/${encodeURIComponent(current)}/run`, { method: 'POST', body: { stages: chosen, review: $('#run-review').checked } }); }
  catch (e) { toast(e.message); }
};
$('#btn-changes-refresh').onclick = () => renderChanges();
$('#btn-repair').onclick = async () => {
  const chosen = [...document.querySelectorAll('#stage-checks input:checked')].map((x) => x.value);
  if (!chosen.length) return toast('실행할 단계를 고르세요');
  try { await api(`/api/projects/${encodeURIComponent(current)}/run`, { method: 'POST', body: { stages: chosen, repair: true } }); }
  catch (e) { toast(e.message); }
};
$('#btn-stop').onclick = () => api(`/api/projects/${encodeURIComponent(current)}/stop`, { method: 'POST' }).catch((e) => toast(e.message));
$('#btn-resume').onclick = () => api(`/api/projects/${encodeURIComponent(current)}/resume`, { method: 'POST' }).catch((e) => toast(e.message));

loadSettings().then(refreshProjects).catch((e) => toast(e.message));

#!/usr/bin/env node
// SW 표준 산출물 자동 작성 앱 — 로컬 웹 서버(127.0.0.1)
// 사용법: node server.mjs [--port 4817] [--open]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_DIR, swd, context, loadModel, lib } from './lib/engine.mjs';
import { loadSettings, saveSettings, publicSettings, providerSettings } from './lib/settings.mjs';
import { availability, createProvider } from './lib/providers/index.mjs';
import { Job, STAGES } from './lib/pipeline.mjs';
import { analyzeChange } from './lib/master.mjs';
import { readYamlFile } from './lib/engine.mjs';
import { KIT_SKILL } from './lib/engine.mjs';

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || Number(process.env.PORT) || 4817;
const PUBLIC = path.join(APP_DIR, 'public');
const INPUT_KINDS = ['회의록', '아이디어', '수정사항', '참고문서'];
const jobs = new Map(); // projectId → Job
const clients = new Map(); // projectId → Set<res>

const projectsDir = () => loadSettings().projectsDir;
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60);
// base 폴더 안쪽 경로인지(같은 접두어의 옆 폴더는 제외)
const inside = (base, p) => { const b = path.resolve(base); const r = path.resolve(p); return r === b || r.startsWith(b + path.sep); };
function projectRoot(id) {
  const name = safeName(id);
  const dir = path.join(projectsDir(), name);
  if (!name || name === '.' || name === '..' || !inside(projectsDir(), dir) || path.resolve(dir) === path.resolve(projectsDir())) throw httpError(400, '잘못된 프로젝트 이름');
  return dir;
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, '파일이 너무 큽니다'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function broadcast(id, ev) {
  for (const res of clients.get(id) || []) res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

function listProjects() {
  const base = projectsDir();
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, 'sw-config.yaml')))
    .map((d) => {
      const job = jobs.get(d.name);
      const jobFile = path.join(base, d.name, '.work', 'app', 'job.json');
      let last = null;
      try { last = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch { /* 없음 */ }
      return { id: d.name, status: job?.state.status || last?.status || 'idle', updated: fs.statSync(path.join(base, d.name)).mtime };
    })
    .sort((a, b) => b.updated - a.updated);
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push({ path: path.relative(base, full).replace(/\\/g, '/'), size: fs.statSync(full).size });
  }
  return out;
}

async function projectInfo(id) {
  const root = projectRoot(id);
  if (!fs.existsSync(path.join(root, 'sw-config.yaml'))) throw httpError(404, '프로젝트가 없습니다');
  const ctx = await context(root);
  const inputs = [];
  for (const kind of INPUT_KINDS) {
    const d = path.join(root, 'input', kind);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) inputs.push({ kind, name: f, size: fs.statSync(path.join(d, f)).size });
  }
  const outputs = listFiles(path.join(root, 'output')).filter((f) => /\.(docx|sql|md)$/.test(f.path));
  const model = await loadModel(ctx);
  const skipped = [];
  for (const [sub, map] of Object.entries(model.skipped || {})) for (const [code, x] of Object.entries(map || {})) skipped.push({ sub, code, name: ctx.schemas.byCode[code]?.name || code, reason: x?.reason || '', needs: x?.needs || '' });
  const job = jobs.get(id);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(root, '.work', 'app', 'job.json'), 'utf8')); } catch { /* 없음 */ }
  return {
    id, root,
    config: { system_name: ctx.cfg.project?.system_name || '', project: ctx.cfg.project?.name || '', subsystems: ctx.cfg.subsystems || [], author: ctx.cfg.document?.author || '', approver: ctx.cfg.document?.approver || '' },
    inputs, outputs, skipped,
    job: job ? job.state : last,
  };
}

function zipOutputs(root) {
  return (async () => {
    const { depDefault } = await lib('deps.mjs');
    const JSZip = await depDefault('jszip');
    const zip = new JSZip();
    for (const f of listFiles(path.join(root, 'output'))) zip.file(f.path, fs.readFileSync(path.join(root, 'output', f.path)));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  })();
}

const routes = [
  ['GET', /^\/api\/settings$/, async () => ({ settings: publicSettings(), providers: availability(), stages: STAGES })],
  ['POST', /^\/api\/settings$/, async (req) => {
    const b = await readBody(req);
    const patch = {};
    for (const k of ['provider', 'model', 'effort', 'baseURL', 'mode', 'projectsDir']) if (b[k] !== undefined) patch[k] = String(b[k]);
    if (b.concurrency !== undefined) patch.concurrency = Math.max(1, Math.min(8, Number(b.concurrency) || 4));
    if (b.review !== undefined) patch.review = !!b.review;
    if (b.keys) patch.keys = Object.fromEntries(Object.entries(b.keys).filter(([, v]) => v).map(([k, v]) => [k, String(v).trim()]));
    return { settings: publicSettings(saveSettings(patch)) };
  }],
  ['POST', /^\/api\/settings\/test$/, async () => {
    const p = createProvider(providerSettings(), { kitDir: KIT_SKILL });
    const t0 = Date.now();
    const { text } = await p.complete({ prompt: '연결 확인입니다. "확인"이라고만 답하세요.', maxTokens: 2000 });
    return { ok: true, label: p.label, reply: String(text).trim().slice(0, 200), ms: Date.now() - t0 };
  }],
  ['GET', /^\/api\/projects$/, async () => ({ projects: listProjects(), dir: projectsDir() })],
  ['POST', /^\/api\/projects$/, async (req) => {
    const b = await readBody(req);
    const id = safeName(b.name);
    if (!id) throw httpError(400, '프로젝트 이름을 입력하세요');
    const root = projectRoot(id);
    if (fs.existsSync(path.join(root, 'sw-config.yaml'))) throw httpError(409, '같은 이름의 프로젝트가 있습니다');
    fs.mkdirSync(root, { recursive: true });
    const r = await swd(['init', root]);
    if (r.code !== 0) throw httpError(500, r.out);
    return projectInfo(id);
  }],
  ['GET', /^\/api\/projects\/([^/]+)$/, async (req, m) => projectInfo(decodeURIComponent(m[1]))],
  ['POST', /^\/api\/projects\/([^/]+)\/inputs$/, async (req, m) => {
    const id = decodeURIComponent(m[1]);
    const root = projectRoot(id);
    const b = await readBody(req);
    const kind = INPUT_KINDS.includes(b.kind) ? b.kind : '회의록';
    const name = safeName(b.name || `메모_${Date.now()}.md`);
    if (!/\.(txt|md|docx|hwp|hwpx|pdf)$/i.test(name)) throw httpError(400, '지원 형식: txt, md, docx, hwp, hwpx, pdf');
    const dir = path.join(root, 'input', kind);
    fs.mkdirSync(dir, { recursive: true });
    const data = b.base64 ? Buffer.from(b.base64, 'base64') : Buffer.from(String(b.text || ''), 'utf8');
    fs.writeFileSync(path.join(dir, name), data);
    return projectInfo(id);
  }],
  ['DELETE', /^\/api\/projects\/([^/]+)\/inputs\/([^/]+)\/([^/]+)$/, async (req, m) => {
    const id = decodeURIComponent(m[1]);
    const kind = decodeURIComponent(m[2]);
    if (!INPUT_KINDS.includes(kind)) throw httpError(400, '잘못된 종류');
    const f = path.join(projectRoot(id), 'input', kind, safeName(decodeURIComponent(m[3])));
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return projectInfo(id);
  }],
  ['POST', /^\/api\/projects\/([^/]+)\/run$/, async (req, m) => {
    const id = decodeURIComponent(m[1]);
    const root = projectRoot(id);
    if (jobs.get(id)?.state.status === 'running' || jobs.get(id)?.state.status === 'paused') throw httpError(409, '이미 실행 중입니다');
    const b = await readBody(req);
    const s = loadSettings();
    const stages = Array.isArray(b.stages) && b.stages.length ? STAGES.filter((x) => b.stages.includes(x)) : STAGES;
    const job = new Job({ root, providerSettings: providerSettings(s), stages, review: b.review ?? s.review, concurrency: s.concurrency, mode: s.mode, repair: !!b.repair });
    jobs.set(id, job);
    job.on('event', (ev) => broadcast(id, ev));
    job.run();
    return { started: true, stages };
  }],
  ['POST', /^\/api\/projects\/([^/]+)\/(stop|resume)$/, async (req, m) => {
    const job = jobs.get(decodeURIComponent(m[1]));
    if (!job) throw httpError(404, '실행 중인 작업이 없습니다');
    if (m[2] === 'stop') job.stop(); else job.resume();
    return { ok: true };
  }],
  // 수정사항: 목록 → 영향 분석(확인 요청) → 승인한 변경만 반영
  ['GET', /^\/api\/projects\/([^/]+)\/changes$/, async (req, m) => {
    const root = projectRoot(decodeURIComponent(m[1]));
    await swd(['ingest'], { root });
    const idx = (await readYamlFile(path.join(root, '.work', 'inputs', 'index.yaml'), { inputs: [] })) || { inputs: [] };
    const dir = path.join(root, '.work', 'changes');
    const out = [];
    for (const x of idx.inputs || []) {
      if (x.kind !== '수정사항' || x.status !== 'ok') continue;
      const review = await readYamlFile(path.join(dir, `${x.id}-review.yaml`), null);
      const applied = await readYamlFile(path.join(dir, `${x.id}-applied.yaml`), null);
      out.push({ id: x.id, title: x.title, original: x.original, review, applied });
    }
    return { changes: out };
  }],
  ['POST', /^\/api\/projects\/([^/]+)\/changes\/([^/]+)\/analyze$/, async (req, m) => {
    const root = projectRoot(decodeURIComponent(m[1]));
    const inputId = decodeURIComponent(m[2]);
    if (jobs.get(decodeURIComponent(m[1]))?.state.status === 'running') throw httpError(409, '작업이 실행 중입니다');
    const ctx = await context(root);
    const provider = createProvider(providerSettings(), { kitDir: KIT_SKILL });
    fs.mkdirSync(path.join(root, '.work', 'app'), { recursive: true });
    const review = await analyzeChange(ctx, provider, inputId, { cwd: root, logFile: path.join(root, '.work', 'app', `master_change_${inputId}.log`) });
    return { review };
  }],
  ['POST', /^\/api\/projects\/([^/]+)\/changes\/([^/]+)\/apply$/, async (req, m) => {
    const id = decodeURIComponent(m[1]);
    const root = projectRoot(id);
    if (['running', 'paused'].includes(jobs.get(id)?.state.status)) throw httpError(409, '이미 실행 중입니다');
    const b = await readBody(req);
    const s = loadSettings();
    const job = new Job({ root, providerSettings: providerSettings(s), stages: [], concurrency: s.concurrency, mode: s.mode });
    jobs.set(id, job);
    job.on('event', (ev) => broadcast(id, ev));
    job.runChange({ inputId: decodeURIComponent(m[2]), approvedNos: (b.approved || []).map(Number), memo: String(b.memo || '') });
    return { started: true };
  }],
  ['GET', /^\/api\/projects\/([^/]+)\/log$/, async (req, m) => {
    const f = path.join(projectRoot(decodeURIComponent(m[1])), '.work', 'app', 'log.jsonl');
    if (!fs.existsSync(f)) return { log: [] };
    return { log: fs.readFileSync(f, 'utf8').trim().split('\n').slice(-500).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
  }],
];

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    // 실시간 진행 상황(SSE)
    let m = /^\/api\/projects\/([^/]+)\/events$/.exec(p);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      if (!clients.has(id)) clients.set(id, new Set());
      clients.get(id).add(res);
      const job = jobs.get(id);
      if (job) res.write(`data: ${JSON.stringify({ type: 'state', state: job.state })}\n\n`);
      req.on('close', () => clients.get(id)?.delete(res));
      return;
    }
    // 결과 파일 내려받기
    m = /^\/api\/projects\/([^/]+)\/file$/.exec(p);
    if (m && req.method === 'GET') {
      const root = path.join(projectRoot(decodeURIComponent(m[1])), 'output');
      const file = path.resolve(root, url.searchParams.get('path') || '');
      if (!inside(root, file) || file === path.resolve(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, '파일이 없습니다');
      const type = file.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : file.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `${url.searchParams.get('inline') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
      fs.createReadStream(file).pipe(res);
      return;
    }
    m = /^\/api\/projects\/([^/]+)\/zip$/.exec(p);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const buf = await zipOutputs(projectRoot(id));
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${id}_산출물.zip`)}` });
      res.end(buf);
      return;
    }
    for (const [method, re, fn] of routes) {
      const mm = req.method === method && re.exec(p);
      if (mm) return send(res, 200, await fn(req, mm));
    }
    if (p.startsWith('/api/')) throw httpError(404, '없는 API');
    // 정적 파일
    const file = path.resolve(PUBLIC, `.${p === '/' ? '/index.html' : p}`);
    if (!inside(PUBLIC, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    return send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, e.status || 500, { error: e.message || String(e) });
  }
}

const server = http.createServer(handle);
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`SW 표준 산출물 자동 작성 앱: ${url}`);
  console.log(`프로젝트 폴더: ${projectsDir()}`);
  if (args.includes('--open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});

#!/usr/bin/env node
// 명령줄 실행: 화면 없이 입력 폴더 → 산출물
//   node cli.mjs run --project <폴더> [--input <자료 폴더>] [--provider codex-cli|claude-cli|openai|anthropic]
//                    [--model 이름] [--effort high] [--mode auto|agent|chat] [--stages analysis,design,implementation,test]
//                    [--concurrency 4] [--base-url URL] [--repair  (새로 쓰지 않고 검증·오류 수정·문서 재생성만)]
//   node cli.mjs providers        사용 가능한 모델 제공자
//   node cli.mjs test [...같은 모델 옵션]   연결 확인
import fs from 'node:fs';
import path from 'node:path';
import { swd, KIT_SKILL } from './lib/engine.mjs';
import { loadSettings, providerSettings } from './lib/settings.mjs';
import { availability, createProvider } from './lib/providers/index.mjs';
import { Job, STAGES } from './lib/pipeline.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const KINDS = ['회의록', '아이디어', '수정사항', '참고문서'];

function modelSettings() {
  const s = loadSettings();
  const ps = providerSettings(s);
  const provider = opt('provider', ps.provider);
  const env = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  return {
    provider,
    model: opt('model', provider === s.provider ? ps.model : ''),
    effort: opt('effort', ps.effort),
    baseURL: opt('base-url', ps.baseURL),
    apiKey: s.keys[provider] || env[provider] || '',
  };
}

// 자료 폴더 복사: 하위 폴더 이름이 회의록/아이디어/수정사항/참고문서면 그 종류로, 아니면 회의록으로
function copyInputs(src, root) {
  let n = 0;
  const walk = (dir, kind) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, KINDS.includes(e.name) ? e.name : kind); continue; }
      if (!/\.(txt|md|docx|hwp|hwpx|pdf)$/i.test(e.name)) continue;
      const dst = path.join(root, 'input', kind, e.name);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(full, dst);
      n += 1;
    }
  };
  walk(path.resolve(src), '회의록');
  return n;
}

async function main() {
  if (cmd === 'providers') {
    for (const p of availability()) console.log(`${p.available ? '✔' : '✘'} ${p.id.padEnd(11)} ${p.name}${p.agent ? ' (에이전트 가능)' : ''} — ${p.modelHint}`);
    return;
  }
  if (cmd === 'test') {
    const p = createProvider(modelSettings(), { kitDir: KIT_SKILL });
    const t0 = Date.now();
    const { text } = await p.complete({ prompt: '연결 확인입니다. "확인"이라고만 답하세요.', maxTokens: 2000 });
    console.log(`✔ ${p.label}: ${String(text).trim().slice(0, 100)} (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    return;
  }
  if (cmd === 'run') {
    const project = opt('project');
    if (!project) throw new Error('--project <폴더> 가 필요합니다');
    const root = path.resolve(project);
    if (!fs.existsSync(path.join(root, 'sw-config.yaml'))) {
      fs.mkdirSync(root, { recursive: true });
      const r = await swd(['init', root]);
      if (r.code !== 0) throw new Error(r.out);
      console.log(`✔ 새 프로젝트: ${root}`);
    }
    if (opt('input')) console.log(`✔ 자료 ${copyInputs(opt('input'), root)}건 복사`);
    const s = loadSettings();
    const stages = opt('stages') ? STAGES.filter((x) => opt('stages').split(',').includes(x)) : STAGES;
    const job = new Job({ root, providerSettings: modelSettings(), stages, review: false, concurrency: Number(opt('concurrency', s.concurrency)), mode: opt('mode', s.mode), repair: flag('repair') });
    job.on('event', (ev) => { if (ev.type === 'log') console.log(`${new Date(ev.time).toLocaleTimeString('ko-KR', { hour12: false })} ${ev.level === 'error' ? '✘ ' : ev.level === 'warn' ? '⚠ ' : ''}${ev.msg}`); });
    process.on('SIGINT', () => { console.log('중지 요청'); job.stop(); });
    const st = await job.run();
    console.log(`\n결과: ${st.status}${st.error ? ` — ${st.error}` : ''}`);
    console.log(`산출물: ${path.join(root, 'output')}`);
    for (const [stage, f] of Object.entries(st.reports || {})) console.log(`검토 리포트(${stage}): ${path.join(root, f)}`);
    process.exitCode = st.status === 'done' ? 0 : 1;
    return;
  }
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

main().catch((e) => { console.error(`✘ ${e.message}`); process.exitCode = 1; });

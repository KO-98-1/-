#!/usr/bin/env node
// swd — CBD SW 표준 산출물 자동 작성 도구
// 사용법: node swd.mjs <명령> [옵션]   (명령 목록: node swd.mjs help)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SCRIPTS_DIR, runtimeDir, resolveDep, findBrowser } from './lib/deps.mjs';
import { openProject, findRoot, readYaml } from './lib/project.mjs';
import { loadSchemas, parseDocs, deliverablesForPhase, PHASES, PHASE_NAMES } from './lib/schema.mjs';
import { loadModel, unrenderedReason } from './lib/model.mjs';
import { nextIds } from './lib/ids.mjs';

const HELP = `swd — CBD SW 표준 산출물 자동 작성 도구

준비
  setup                         런타임 의존성 설치(최초 1회, 사용자 공유 폴더)·브라우저 확인
  doctor                        환경 점검
  init [폴더] [--system 시스템명] [--project PRJ]
                                산출물 작업 폴더 생성(기본: ./deliverables)
작성 흐름
  ingest [--force]              input/ 자료를 .work/inputs/*.txt 로 정규화(줄 번호 인용·개인정보 마스킹)
  prompt --stage <단계> (--sub <ID> | --all) [--docs R1,R2]
                                서브에이전트 작성 지시서 생성 → .work/prompts/<단계>_<SUB>.md
  next-id --type <유형> --sub <ID> [--cat SFR] [--count N]
  validate [--sub ID,..] [--docs 코드|단계] [--json]
  preskip --stage <단계> [--sub ID]
                                선행 산출물이 없거나 생략된 산출물을 생략으로 기록(가이드 작성 방법 기준)
  link                          병합 후 서브시스템 간 엔티티 관계를 테이블 FK(fk_ref)로 보완
  ddl-check                     생성한 DDL을 내장 PostgreSQL(PGlite)에서 실제로 실행해 확인
  derive --stage implementation|test [--sub ID]
                                결과서 뼈대 현행화(D11→I2, D10→T1, D7→T2, T6→T7)
  scan-code --src <소스폴더> --sub <ID>
                                소스 파일 목록 → I1 프로그램 목록 초안
  diagrams [--sub ID] [--force] 다이어그램 PNG 생성
  render [--sub ID] [--docs 코드|단계] [--no-diagrams]
                                DOCX 산출물 생성 → output/
  build --stage <단계> [--sub ID]
                                validate → diagrams → render → report (단계 확인 게이트용)
  report --stage <단계> [--sub ID]
                                검토 리포트(요약·AI 제안·미정·질문지) → output/_검토/
  confirm [--sub ID] [--docs 코드|단계] [--ids A,B] [--except A,B]
                                AI 제안 확인 처리(음영 해제)
  history add (--docs SA:R1,SA:R2 | --stage <단계>) --content "내용" [--date YYYY-MM-DD]
  status                        산출물 현황
  preview --file <docx> [--out 폴더]
                                DOCX → PDF → PNG (Word 또는 LibreOffice 필요, 검수용)
공통 옵션: --root <산출물 폴더>
단계: analysis(분석) · design(설계) · implementation(구현) · test(시험)`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[k] = true;
      else { args[k] = next; i += 1; }
    } else args._.push(a);
  }
  return args;
}

const STAGE_ALIAS = { 분석: 'analysis', 설계: 'design', 구현: 'implementation', 시험: 'test' };
const stageOf = (s) => (s ? STAGE_ALIAS[s] || s : null);
const list = (v) => (v && v !== true ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : null);

async function context(args) {
  const { root, cfg, p } = await openProject({ root: args.root });
  const schemas = await loadSchemas();
  return { root, cfg, p, schemas };
}

function printIssues(res, max = 60) {
  const show = (arr, icon) => arr.slice(0, max).forEach((e) => console.log(`  ${icon} ${[e.sub, e.code, e.id, e.field].filter(Boolean).join(' · ')} — ${e.message}`));
  show(res.errors, '❌');
  show(res.warnings, '⚠️');
  if (res.errors.length > max || res.warnings.length > max) console.log(`  … (전체: 오류 ${res.errors.length}, 경고 ${res.warnings.length})`);
}

async function cmdSetup() {
  const need = ['docx', 'js-yaml', '@mermaid-js/mermaid-cli', 'mammoth', 'cfb', 'puppeteer'];
  const missing = need.filter((n) => !resolveDep(n));
  if (!missing.length) console.log('✔ 의존성: 설치되어 있음');
  else {
    const dir = runtimeDir();
    console.log(`의존성 설치: ${missing.join(', ')} → ${dir} (약 460MB, 최초 1회)`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(SCRIPTS_DIR, 'package.json'), path.join(dir, 'package.json'));
    const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' };
    const r = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install --no-audit --no-fund --omit=dev'], { cwd: dir, stdio: 'inherit', env })
      : spawnSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], { cwd: dir, stdio: 'inherit', env });
    if (r.status !== 0) { console.error('npm install 실패'); process.exit(1); }
    console.log('✔ 의존성 설치 완료');
  }
  const b = findBrowser();
  console.log(b ? `✔ 브라우저(다이어그램 렌더링): ${b}` : '⚠️ Chrome/Edge를 찾지 못했습니다. 다이어그램을 그리려면 설치하거나 SWD_BROWSER 환경변수를 지정하세요.');
}

async function cmdDoctor(args) {
  console.log(`Node ${process.version} · 스크립트 ${SCRIPTS_DIR}`);
  for (const n of ['docx', 'js-yaml', '@mermaid-js/mermaid-cli', 'puppeteer', 'mammoth', 'cfb', 'jszip']) console.log(`  ${resolveDep(n) ? '✔' : '✘'} ${n}`);
  console.log(`  브라우저: ${findBrowser() || '없음'}`);
  const { findPdftotext } = await import('./lib/ingest.mjs');
  const pdftotext = findPdftotext();
  console.log(`  pdftotext(PDF 입력): ${pdftotext ? pdftotext : '없음 — PDF는 AI가 직접 읽음'}`);
  const root = findRoot(process.cwd(), args.root);
  console.log(`  산출물 폴더: ${root || '없음(swd init 필요)'}`);
}

async function renderSelection(ctx, model, args) {
  const subsFilter = list(args.sub);
  const codes = args.stage ? deliverablesForPhase(ctx.schemas, ctx.cfg, stageOf(args.stage)).map((s) => s.code) : parseDocs(ctx.schemas, ctx.cfg, args.docs);
  const jobs = [];
  const skipNote = (sub, code) => {
    const why = unrenderedReason(ctx, model, sub, code);
    if (why) console.log(`  · ${sub} ${code} ${ctx.schemas.byCode[code].name}: ${why}`);
    return !!why;
  };
  for (const code of codes) {
    const s = ctx.schemas.byCode[code];
    if (s.scope === 'system') {
      if (subsFilter && !subsFilter.includes('SYSTEM')) continue;
      if (skipNote('SYSTEM', code)) continue;
      if (code === 'R3' ? model.subsOf('R1').length : model.has('SYSTEM', code)) jobs.push({ code, sub: 'SYSTEM' });
      continue;
    }
    for (const sub of ctx.cfg.subsystems.map((x) => x.id)) {
      if (subsFilter && !subsFilter.includes(sub)) continue;
      if (skipNote(sub, code)) continue;
      const has = code === 'I3' ? (model.get(sub, 'D9').tables || []).length > 0 : model.has(sub, code);
      // 모든 목록이 빈 목록([])으로 명시된 산출물 = 이 서브시스템에 해당 업무 없음 → 생성 생략(가이드 Ⅰ.3)
      const data = model.get(sub, code);
      const allNone = has && code !== 'I3' && Object.keys(data).length > 0 && Object.values(data).every((v) => Array.isArray(v) && v.length === 0);
      if (allNone) { console.log(`  · ${sub} ${code} ${s.name}: 해당 업무 없음(빈 목록) → 생략`); continue; }
      if (has) jobs.push({ code, sub });
    }
  }
  return jobs;
}

async function doRender(ctx, model, args) {
  const { renderDoc } = await import('./lib/render.mjs');
  const { ddlScripts, ddlText } = await import('./lib/computed.mjs');
  const { outputDir } = await import('./lib/render.mjs');
  const jobs = await renderSelection(ctx, model, args);
  const out = [];
  for (const j of jobs) {
    const r = await renderDoc(ctx, model, j.code, j.sub);
    if (j.code === 'I3') {
      const dir = path.join(outputDir(ctx, j.sub), 'DDL');
      fs.mkdirSync(dir, { recursive: true });
      for (const s of ddlScripts(ctx, model, j.sub)) fs.writeFileSync(path.join(dir, s.name), ddlText(ctx, s), 'utf8');
    }
    out.push({ ...j, ...r });
    const st = r.stats;
    console.log(`  📄 ${path.relative(ctx.p.root, r.file)}  (정보 부족 ${st.missing || 0} · 미정 ${st.tbd || 0} · AI 제안 ${st.ai || 0})`);
  }
  if (!jobs.length) console.log('  렌더링할 산출물이 없습니다(모델 파일 없음).');
  return out;
}

async function doDiagrams(ctx, model, args) {
  const { renderDiagrams } = await import('./lib/diagrams.mjs');
  const r = await renderDiagrams(ctx, model, { subs: list(args.sub), force: !!args.force });
  console.log(`  🖼  다이어그램 ${r.total}개 (새로 그림 ${r.rendered}, 캐시 ${r.cached}, 오류 ${r.errors.length})`);
  for (const e of r.errors) console.log(`  ❌ 그림 ${e.sub}/${e.kind}/${e.key}: ${e.message}${e.source ? ` [원본 ${e.source}]` : ''}`);
  return r;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.help) { console.log(HELP); return; }
  if (cmd === 'setup') return cmdSetup();
  if (cmd === 'doctor') return cmdDoctor(args);
  if (cmd === 'init') {
    const { init } = await import('./lib/ops.mjs');
    const target = args._[1] || args.root || 'deliverables';
    const r = await init(target, { systemName: args.system !== true ? args.system : undefined, projectId: args.project !== true ? args.project : undefined });
    console.log(`${r.created ? '✔ 생성' : '✔ 이미 있음'}: ${r.root}`);
    console.log('  다음: input/ 하위 폴더에 회의록·아이디어·수정사항·참고문서를 넣고 sw-config.yaml(시스템명·작성자·서브시스템)을 확인하세요.');
    return;
  }

  const ctx = await context(args);
  if (cmd === 'ingest') {
    const { ingest } = await import('./lib/ingest.mjs');
    const { results } = await ingest(ctx, { force: !!args.force });
    if (!results.length) console.log('  input/ 에 자료가 없습니다.');
    for (const r of results) {
      const icon = { new: '🆕', updated: '♻️', unchanged: '·', needs_manual: '⚠️', error: '❌', skipped: '⏭' }[r.status] || '?';
      console.log(`  ${icon} ${r.id || ''} ${r.original} ${r.title ? `— ${r.title}` : ''}${r.lines ? ` (${r.lines}줄)` : ''}${r.message ? ` — ${r.message}` : ''}`);
    }
    return;
  }

  const model = await loadModel(ctx);

  switch (cmd) {
    case 'next-id': {
      const out = nextIds(ctx.cfg, ctx.schemas, model.index, args.type, { sub: args.sub, cat: args.cat !== true ? args.cat : undefined, parent: args.parent, count: Number(args.count || 1) });
      console.log(out.join('\n'));
      return;
    }
    case 'prompt': {
      const { writePrompt, planDocs } = await import('./lib/prompt.mjs');
      if (args.change) {
        // 수정사항 반영 지시서: --change CR-001 --sub MT --docs R1,R2,D2 --note-file <승인된 변경 목록.md>
        const docs = list(args.docs);
        const subs = list(args.sub);
        if (!docs || !subs) throw new Error('--change 에는 --sub 와 --docs 가 필요합니다');
        const notes = args['note-file'] ? fs.readFileSync(path.resolve(args['note-file']), 'utf8') : String(args.note || '');
        if (!notes.trim()) throw new Error('--note-file 또는 --note 로 승인된 변경 목록을 주세요');
        for (const sub of subs) {
          const r = await writePrompt(ctx, model, { stage: stageOf(args.stage) || 'design', sub, docs, change: { inputId: args.change, notes } });
          console.log(`  📝 ${sub}: ${path.relative(ctx.p.root, r.file)} (${docs.join(',')}, ${r.chars.toLocaleString()}자)`);
        }
        return;
      }
      const stage = stageOf(args.stage);
      if (!PHASES.includes(stage)) throw new Error('--stage 를 지정하세요 (analysis|design|implementation|test)');
      const targets = args.all ? [...ctx.cfg.subsystems.map((s) => s.id), 'SYSTEM'] : list(args.sub);
      if (!targets) throw new Error('--sub <ID> 또는 --all 을 지정하세요');
      for (const sub of targets) {
        const docs = list(args.docs) || planDocs(ctx, stage, sub, model);
        if (!docs.length) { console.log(`  · ${sub}: 이 단계에 작성할 산출물 없음`); continue; }
        const r = await writePrompt(ctx, model, { stage, sub, docs });
        console.log(`  📝 ${sub}: ${path.relative(ctx.p.root, r.file)} (${docs.join(',')}, ${r.chars.toLocaleString()}자)`);
      }
      return;
    }
    case 'validate': {
      const { validate } = await import('./lib/validate.mjs');
      const codes = args.docs ? parseDocs(ctx.schemas, ctx.cfg, args.docs) : null;
      const res = await validate(ctx, model, { subs: list(args.sub), codes });
      if (args.json) { console.log(JSON.stringify({ ok: res.ok, errors: res.errors, warnings: res.warnings }, null, 1)); }
      else {
        console.log(res.ok ? `✔ 검증 통과 (경고 ${res.warnings.length})` : `✘ 오류 ${res.errors.length} · 경고 ${res.warnings.length}`);
        printIssues(res, Number(args.max || 60));
      }
      process.exitCode = res.ok ? 0 : 1;
      return;
    }
    case 'derive': {
      const { derive } = await import('./lib/ops.mjs');
      const done = await derive(ctx, model, { stage: stageOf(args.stage), subs: list(args.sub) });
      console.log(done.length ? `✔ 현행화: ${done.join(', ')}` : '  파생할 원본 산출물이 없습니다.');
      return;
    }
    case 'preskip': {
      const { preskip } = await import('./lib/ops.mjs');
      const stage = stageOf(args.stage);
      if (!PHASES.includes(stage)) throw new Error('--stage 를 지정하세요 (analysis|design|implementation|test)');
      const done = await preskip(ctx, model, { stage, subs: list(args.sub) });
      console.log(done.length ? `✔ 선행 산출물 기준 생략 기록: ${done.join(', ')}` : '  선행 산출물 기준으로 생략할 산출물 없음');
      return;
    }
    case 'ddl-check': {
      // 생성한 DDL을 내장 PostgreSQL(PGlite, WASM)에서 실제로 실행해 본다: 모든 서브시스템 테이블 생성 → FK 추가
      const { ddlScripts, ddlText } = await import('./lib/computed.mjs');
      let PGlite;
      try { ({ PGlite } = await import(pathToFileURL(resolveDep('@electric-sql/pglite') || '').href)); }
      catch { throw new Error("DDL 실행 확인에는 '@electric-sql/pglite'가 필요합니다: 스크립트 폴더에서 npm install @electric-sql/pglite"); }
      if ((ctx.cfg.database?.dbms || 'postgresql') !== 'postgresql') { console.log('  PostgreSQL 방언일 때만 실행 확인을 지원합니다'); return; }
      const db = new PGlite();
      const tables = [];
      const fks = [];
      for (const sub of ctx.cfg.subsystems.map((x) => x.id)) {
        if (!(model.get(sub, 'D9').tables || []).length) continue;
        for (const sc of ddlScripts(ctx, model, sub)) {
          const text = ddlText(ctx, sc);
          const lines = text.split('\n');
          fks.push(...lines.filter((l) => /FOREIGN KEY/i.test(l)).map((l) => ({ sub, sql: l })));
          tables.push({ sub, name: sc.name, sql: lines.filter((l) => !/FOREIGN KEY/i.test(l)).join('\n') });
        }
      }
      let bad = 0;
      for (const t of tables) {
        try { await db.exec(t.sql); console.log(`  ✔ ${t.name}`); } catch (e) { bad += 1; console.log(`  ❌ ${t.name}: ${e.message}`); }
      }
      for (const f of fks) {
        try { await db.exec(f.sql); } catch (e) { bad += 1; console.log(`  ❌ ${f.sub} FK: ${f.sql.trim()} — ${e.message}`); }
      }
      const n = (await db.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n;
      console.log(bad ? `✘ DDL 실행 오류 ${bad}건` : `✔ DDL 실행 확인: 테이블 ${n}개 · FK ${fks.length}개 생성(PostgreSQL)`);
      process.exitCode = bad ? 1 : 0;
      return;
    }
    case 'link': {
      const { linkCrossSub } = await import('./lib/ops.mjs');
      const added = await linkCrossSub(ctx, model);
      console.log(added.length ? `✔ 서브시스템 간 엔티티 관계 ${added.length}건 추가: ${added.join(', ')}` : '  추가할 서브시스템 간 관계 없음');
      return;
    }
    case 'scan-code': {
      const { scanCode } = await import('./lib/ops.mjs');
      if (!args.src || !args.sub) throw new Error('--src <소스폴더> --sub <ID> 가 필요합니다');
      const r = await scanCode(ctx, model, { root: args.src, sub: args.sub });
      console.log(`✔ 소스 ${r.scanned}개 검사, I1 프로그램 목록에 ${r.added}개 추가 (component_ids 연결은 AI/사람이 보완)`);
      return;
    }
    case 'diagrams':
      await doDiagrams(ctx, model, args);
      return;
    case 'render': {
      if (!args['no-diagrams']) await doDiagrams(ctx, model, args);
      await doRender(ctx, model, args);
      return;
    }
    case 'build': {
      const stage = stageOf(args.stage);
      const { validate } = await import('./lib/validate.mjs');
      const { buildReport, writeReport } = await import('./lib/report.mjs');
      const codes = stage ? deliverablesForPhase(ctx.schemas, ctx.cfg, stage).map((s) => s.code) : null;
      const res = await validate(ctx, model, { subs: list(args.sub), codes });
      console.log(res.ok ? `✔ 검증 통과 (경고 ${res.warnings.length})` : `✘ 검증 오류 ${res.errors.length} · 경고 ${res.warnings.length} — 오류가 있어도 문서는 생성합니다`);
      printIssues({ errors: res.errors, warnings: [] }, 30);
      await doDiagrams(ctx, model, args);
      await doRender(ctx, model, { ...args, stage: undefined, docs: stage || args.docs });
      const rep = buildReport(ctx, model, res, { codes, subs: list(args.sub), stage });
      const file = writeReport(ctx, rep);
      console.log(`  🧾 검토 리포트: ${path.relative(ctx.p.root, file)}`);
      return;
    }
    case 'report': {
      const stage = stageOf(args.stage);
      const { validate } = await import('./lib/validate.mjs');
      const { buildReport, writeReport } = await import('./lib/report.mjs');
      const codes = stage ? deliverablesForPhase(ctx.schemas, ctx.cfg, stage).map((s) => s.code) : null;
      const res = await validate(ctx, model, { subs: list(args.sub), codes });
      const rep = buildReport(ctx, model, res, { codes, subs: list(args.sub), stage });
      const file = writeReport(ctx, rep);
      console.log(`🧾 ${file}`);
      return;
    }
    case 'confirm': {
      const { confirm } = await import('./lib/ops.mjs');
      const codes = args.stage ? deliverablesForPhase(ctx.schemas, ctx.cfg, stageOf(args.stage)).map((s) => s.code) : (args.docs ? parseDocs(ctx.schemas, ctx.cfg, args.docs) : null);
      const n = await confirm(ctx, model, { subs: list(args.sub), codes, ids: list(args.ids), except: list(args.except) || [] });
      console.log(`✔ AI 제안 ${n}건 확인 처리(다음 렌더링부터 음영 해제)`);
      return;
    }
    case 'history': {
      const { addHistory } = await import('./lib/ops.mjs');
      if (args._[1] !== 'add') throw new Error('사용법: history add --docs SA:R1,SA:R2 --content "내용"');
      let docs = list(args.docs);
      if (!docs && args.stage) {
        const codes = deliverablesForPhase(ctx.schemas, ctx.cfg, stageOf(args.stage)).map((s) => s.code);
        docs = Object.values(model.docs)
          .filter((d) => codes.includes(d.code) && (!list(args.sub) || list(args.sub).includes(d.sub)) && !unrenderedReason(ctx, model, d.sub, d.code))
          .map((d) => `${d.sub}:${d.code}`);
        if (codes.includes('R3') && model.subsOf('R1').length) docs.push('SYSTEM:R3');
        if (codes.includes('I3')) for (const sub of model.subsOf('D9')) if (sub !== 'SYSTEM') docs.push(`${sub}:I3`);
      }
      if (!docs?.length || !args.content || args.content === true) throw new Error('--docs(또는 --stage)와 --content 가 필요합니다');
      const e = await addHistory(ctx, { docs, content: args.content, date: args.date !== true ? args.date : undefined });
      console.log(`✔ 제·개정 이력 추가: ${e.date} · ${docs.length}개 산출물 · ${e.content}`);
      return;
    }
    case 'status': {
      const { validate } = await import('./lib/validate.mjs');
      const { statusRows } = await import('./lib/ops.mjs');
      const res = await validate(ctx, model, {});
      const rows = statusRows(ctx, model, res);
      console.log(`시스템: ${ctx.cfg.project?.system_name || '(미설정)'} · 서브시스템: ${ctx.cfg.subsystems.map((s) => `${s.id}(${s.name})`).join(', ')}`);
      for (const ph of PHASES) {
        const codes = deliverablesForPhase(ctx.schemas, ctx.cfg, ph).map((s) => s.code);
        const rs = rows.filter((r) => codes.includes(r.code));
        console.log(`\n[${PHASE_NAMES[ph]}] ${rs.length ? '' : '(작성 전)'}`);
        for (const r of rs) console.log(`  ${r.sub.padEnd(6)} ${r.code.padEnd(4)} ${r.name.padEnd(18)} 항목 ${String(r.items).padStart(3)} · 오류 ${r.errors} · 경고 ${r.warnings}`);
        for (const [sub, map] of Object.entries(model.skipped)) {
          for (const [code, info] of Object.entries(map || {})) {
            if (codes.includes(code)) console.log(`  ${sub.padEnd(6)} ${code.padEnd(4)} ${(ctx.schemas.byCode[code]?.name || '').padEnd(18)} 생략(단서 부족) — ${info?.reason || ''}`);
          }
        }
      }
      const inputs = await readYaml(ctx.p.inputIndex, { inputs: [] });
      console.log(`\n입력 자료 ${inputs?.inputs?.length || 0}건 · 검증 오류 ${res.errors.length} · 경고 ${res.warnings.length}`);
      return;
    }
    case 'preview': {
      const { preview } = await import('./lib/preview.mjs');
      const r = await preview(args.file, args.out);
      console.log(r.join('\n'));
      return;
    }
    default:
      console.log(`알 수 없는 명령: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`✘ ${e.message}`);
  if (process.env.SWD_DEBUG) console.error(e.stack);
  process.exitCode = 1;
});

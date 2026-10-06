// 작성 파이프라인: 입력 정규화 → (설정 제안) → 단계별[준비 → 병렬 작성 → 병합 검증·수정 → 문서 생성] → 검토 리포트
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { context, loadModel, validate, swd, lib, KIT_SKILL, readYamlFile, writeYamlFile } from './engine.mjs';
import { createProvider } from './providers/index.mjs';
import { proposeConfig, allocateAnalysis, prepareDesign, linkComponents } from './master.mjs';
import { writeSubChat, writeSubAgent, fixSubAgent, fmtIssues } from './writer.mjs';

export const STAGES = ['analysis', 'design', 'implementation', 'test'];
export const STAGE_NAMES = { analysis: '분석', design: '설계', implementation: '구현', test: '시험' };

async function pool(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export class Job extends EventEmitter {
  constructor({ root, providerSettings, stages = STAGES, review = false, concurrency = 4, mode = 'auto', repair = false }) {
    super();
    this.repair = repair; // true: 새로 쓰지 않고 검증 → 오류 수정 → 문서 재생성만
    this.root = root;
    this.providerSettings = providerSettings;
    this.stages = stages;
    this.review = review;
    this.concurrency = concurrency;
    this.mode = mode;
    this.abort = new AbortController();
    this.state = { status: 'running', stage: null, stageStatus: {}, subs: {}, reports: {}, error: null, startedAt: new Date().toISOString(), finishedAt: null };
    this.logDir = path.join(root, '.work', 'app');
    fs.mkdirSync(this.logDir, { recursive: true });
    this.logFile = path.join(this.logDir, 'log.jsonl');
    this._resume = null;
  }

  log(msg, level = 'info') {
    const ev = { type: 'log', time: new Date().toISOString(), level, msg };
    fs.appendFileSync(this.logFile, `${JSON.stringify(ev)}\n`);
    this.emit('event', ev);
  }

  set(patch) {
    Object.assign(this.state, patch);
    fs.writeFileSync(path.join(this.logDir, 'job.json'), JSON.stringify(this.state, null, 1));
    this.emit('event', { type: 'state', state: this.state });
  }

  sub(sub, patch) {
    this.state.subs[sub] = { ...(this.state.subs[sub] || {}), ...patch };
    this.set({});
  }

  stop() { this.abort.abort(); this._resume?.(); }
  resume() { this._resume?.(); }

  async run() {
    const signal = this.abort.signal;
    try {
      this.provider = createProvider(this.providerSettings, { kitDir: KIT_SKILL });
      this.agentMode = this.mode === 'agent' || (this.mode === 'auto' && this.provider.canAgent);
      if (this.agentMode && !this.provider.canAgent) throw new Error('이 제공자는 에이전트 방식을 지원하지 않습니다. 작성 방식을 "텍스트"로 바꾸세요');
      this.log(`모델: ${this.provider.label} · 작성 방식: ${this.agentMode ? '에이전트(파일 직접 편집)' : '텍스트(앱이 저장·검증)'}`);

      this.log('입력 자료 정규화');
      const ing = await swd(['ingest'], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
      if (ing.code !== 0) throw new Error('입력 정규화 실패');
      let ctx = await context(this.root);
      const { loadInputIndex } = await lib('ingest.mjs');
      const inputs = [...(await loadInputIndex(ctx.p)).values()].filter((x) => x.status === 'ok');
      if (!inputs.length) throw new Error('input/ 폴더에 자료가 없습니다. 회의록·아이디어·수정사항·참고문서를 먼저 넣으세요');

      if (!ctx.cfg.project?.system_name) {
        this.log('시스템명·서브시스템 구분 제안(마스터)');
        const patch = await proposeConfig(ctx, this.provider, this.masterOpts('config'));
        this.log(`설정: ${patch.project?.system_name || ''} · 서브시스템 ${(patch.subsystems || []).map((x) => `${x.id}(${x.name})`).join(', ')}`);
        ctx = await context(this.root);
      }

      for (const [i, stage] of this.stages.entries()) {
        if (signal.aborted) throw new Error('중지됨');
        await this.runStage(stage);
        if (this.review && i < this.stages.length - 1) {
          this.set({ status: 'paused' });
          this.log(`${STAGE_NAMES[stage]}단계 완료 — 검토 리포트를 확인하고 [계속]을 누르세요`);
          await new Promise((r) => { this._resume = r; });
          this._resume = null;
          if (signal.aborted) throw new Error('중지됨');
          this.set({ status: 'running' });
        }
      }
      this.set({ status: 'done', finishedAt: new Date().toISOString() });
      this.log('모든 단계 완료');
    } catch (e) {
      this.set({ status: signal.aborted ? 'stopped' : 'failed', error: e.message, finishedAt: new Date().toISOString() });
      this.log(`${signal.aborted ? '중지됨' : `실패: ${e.message}`}`, 'error');
    }
    return this.state;
  }

  masterOpts(name) {
    return { cwd: this.root, signal: this.abort.signal, logFile: path.join(this.logDir, `master_${name}.log`) };
  }

  async runStage(stage) {
    const signal = this.abort.signal;
    const name = STAGE_NAMES[stage];
    this.set({ stage, stageStatus: { ...this.state.stageStatus, [stage]: 'running' } });
    this.log(`── ${name}단계 시작`);
    let ctx = await context(this.root);
    const { planDocs, writePrompt } = await lib('prompt.mjs');

    // 1) 준비
    if (this.repair) this.log('검증·수정 모드: 새로 쓰지 않고 오류만 고칩니다');
    else if (stage === 'analysis') {
      const alloc = await readYamlFile(path.join(ctx.p.work, 'allocation.yaml'), null);
      if (!alloc?.shared?.analysis_notes) {
        this.log('서브시스템 배분표 작성(마스터)');
        await allocateAnalysis(ctx, this.provider, this.masterOpts('allocation'));
      }
    } else if (stage === 'design') {
      const model = await loadModel(ctx);
      if (!(model.get('SYSTEM', 'D9').databases || []).length) {
        this.log('공용 데이터베이스·데이터 소유권 표 작성(마스터)');
        await prepareDesign(ctx, this.provider, this.masterOpts('design'));
      }
    } else {
      this.log(`결과서 뼈대 현행화(${stage === 'implementation' ? 'D11→I2' : 'D10→T1, D7→T2, T6→T7'})`);
      await swd(['derive', '--stage', stage], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
      if (stage === 'implementation') await this.preSkipI1(ctx);
    }

    // 선행 산출물이 없거나 생략된 산출물은 가이드 작성 방법 기준으로 미리 생략 기록
    await swd(['preskip', '--stage', stage], { root: this.root, onLine: (l) => this.log(l.trim()), signal });

    // 2) 병렬 작성 — 설계단계의 시스템 공통(아키텍처·총괄시험 계획)은 서브시스템 설계(컴포넌트)가 나온 뒤에 쓴다
    ctx = await context(this.root);
    let model = await loadModel(ctx);
    const all = [...ctx.cfg.subsystems.map((x) => x.id), 'SYSTEM']
      .map((sub) => ({ sub, docs: planDocs(ctx, stage, sub, model) }))
      .filter((t) => t.docs.length);
    if (!all.length) this.log(`${name}단계에 작성할 산출물이 없습니다(생략 기록·설정 확인)`);
    const waves = stage === 'design' ? [all.filter((t) => t.sub !== 'SYSTEM'), all.filter((t) => t.sub === 'SYSTEM')] : [all];
    const prompts = {};
    for (const [wi, targets] of (this.repair ? [] : waves).entries()) {
      // 설계단계: 시스템 공통(아키텍처) 작성 전에 서브시스템 간 연결(엔티티 관계·컴포넌트 의존)을 보완해 둔다
      if (stage === 'design' && wi === 1) await this.linkCrossSub();
      await pool(targets, this.concurrency, async ({ sub }) => {
      const lctx = await context(this.root);
      const lmodel = await loadModel(lctx);
      const docs = planDocs(lctx, stage, sub, lmodel);
      if (!docs.length) return;
      this.sub(sub, { stage, status: 'writing', docs });
      const logFile = path.join(this.logDir, `${stage}_${sub}.log`);
      try {
        if (this.agentMode) {
          const { file } = await writePrompt(lctx, lmodel, { stage, sub, docs });
          prompts[sub] = file;
          const r = await writeSubAgent(lctx, this.provider, { stage, sub, promptFile: file, log: (m) => this.log(m), signal, logFile });
          fs.writeFileSync(path.join(this.logDir, `${stage}_${sub}.report.md`), r.report || '');
        } else {
          const r = await writeSubChat(lctx, this.provider, { stage, sub, docs, log: (m) => this.log(m), signal, logFile });
          if (r.errors.length) this.log(`${sub}: ${r.errors.join('; ')}`, 'warn');
        }
        this.sub(sub, { status: 'written' });
      } catch (e) {
        this.sub(sub, { status: 'failed', error: e.message });
        this.log(`${sub} 작성 실패: ${e.message}`, 'error');
        if (signal.aborted) throw e;
      }
      });
    }

    // 2-1) 누락 확인: 계획한 산출물이 작성도 생략 기록도 없으면(작성자가 중간에 끊긴 경우 등) 한 번 더 맡긴다
    if (!this.repair) {
      ctx = await context(this.root);
      model = await loadModel(ctx);
      const missing = all.map(({ sub }) => ({ sub, docs: planDocs(ctx, stage, sub, model).filter((c) => !model.has(sub, c)) })).filter((t) => t.docs.length);
      for (const { sub, docs } of missing) {
        this.log(`${sub}: 작성되지 않은 산출물 ${docs.join(', ')} → 다시 요청`, 'warn');
        const logFile = path.join(this.logDir, `${stage}_${sub}_retry.log`);
        try {
          const lctx = await context(this.root);
          const lmodel = await loadModel(lctx);
          if (this.agentMode) {
            const { file } = await writePrompt(lctx, lmodel, { stage, sub, docs });
            prompts[sub] = prompts[sub] || file;
            await writeSubAgent(lctx, this.provider, { stage, sub, promptFile: file, log: (m) => this.log(m), signal, logFile });
          } else await writeSubChat(lctx, this.provider, { stage, sub, docs, log: (m) => this.log(m), signal, logFile });
        } catch (e) { this.log(`${sub} 재요청 실패: ${e.message}`, 'error'); }
      }
      ctx = await context(this.root);
      model = await loadModel(ctx);
      for (const { sub } of all) {
        const still = planDocs(ctx, stage, sub, model).filter((c) => !model.has(sub, c));
        if (still.length) this.log(`${sub}: ${still.join(', ')} 은(는) 작성도 생략 기록도 없습니다(작성자 로그 확인 필요)`, 'warn');
      }
    }

    // 3) 병합 검증 → 남은 오류 수정(1회)
    ctx = await context(this.root);
    model = await loadModel(ctx);
    const { deliverablesForPhase } = await lib('schema.mjs');
    const codes = deliverablesForPhase(ctx.schemas, ctx.cfg, stage).map((s) => s.code);
    let res = await validate(ctx, model, { codes });
    if (res.errors.length) {
      this.log(`병합 검증: 오류 ${res.errors.length}건 → 해당 서브시스템에 수정 요청`, 'warn');
      const bySub = new Map();
      for (const e of res.errors) if (e.sub) bySub.set(e.sub, [...(bySub.get(e.sub) || []), e]);
      await pool([...bySub.entries()], this.concurrency, async ([sub, errs]) => {
        const logFile = path.join(this.logDir, `${stage}_${sub}_fix.log`);
        try {
          if (this.agentMode) {
            if (!prompts[sub]) {
              const lctx = await context(this.root);
              const lmodel = await loadModel(lctx);
              const docs = planDocs(lctx, stage, sub, lmodel).filter((c) => lmodel.has(sub, c));
              if (docs.length) prompts[sub] = (await writePrompt(lctx, lmodel, { stage, sub, docs })).file;
            }
            if (prompts[sub]) await fixSubAgent(ctx, this.provider, { sub, promptFile: prompts[sub], errors: errs, signal, logFile, log: (m) => this.log(m) });
          }
          else if (!this.agentMode) {
            const docs = [...new Set(errs.map((e) => e.code).filter(Boolean))];
            const initialFeedback = Object.fromEntries(docs.map((c) => [c, fmtIssues(errs.filter((e) => e.code === c))]));
            await writeSubChat(ctx, this.provider, { stage, sub, docs, log: (m) => this.log(m), signal, logFile, initialFeedback });
          }
        } catch (e) { this.log(`${sub} 수정 실패: ${e.message}`, 'error'); }
      });
      res = await validate(await context(this.root), await loadModel(await context(this.root)), { codes });
    }
    this.log(`검증: 오류 ${res.errors.length} · 경고 ${res.warnings.length}`);
    // 설계단계: 병렬 작성 중 비워 둔 서브시스템 간 엔티티 관계를 테이블 FK 근거로 보완하고, 테이블 설계가 실제 DDL로 실행되는지 확인
    if (stage === 'design') {
      await swd(['link'], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
      await swd(['ddl-check'], { root: this.root, onLine: (l) => this.log(l.trim(), /❌|✘/.test(l) ? 'warn' : 'info'), signal });
    }
    // 시험단계: 이번에 쓴 인수시험 시나리오(T6)로 인수시험 결과서(T7) 뼈대를 다시 현행화
    if (stage === 'test') await swd(['derive', '--stage', 'test'], { root: this.root, onLine: (l) => this.log(l.trim()), signal });

    // 4) 제·개정 이력(이 단계 첫 작성이면) → 문서 생성 + 검토 리포트
    const hist = (await readYamlFile(ctx.p.history, { entries: [] })) || { entries: [] };
    const content = `${name}단계 산출물 작성(AI 작성·검토 전)`;
    if (!(hist.entries || []).some((e) => e.content === content)) await swd(['history', 'add', '--stage', stage, '--content', content], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
    this.log(`${name}단계 문서 생성(다이어그램·DOCX·검토 리포트)`);
    const b = await swd(['build', '--stage', stage], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
    const m = /검토 리포트: (.+\.md)/.exec(b.out);
    if (m) this.state.reports[stage] = m[1].trim();
    // 구현단계: 생성한 DDL을 내장 PostgreSQL에서 실제로 실행해 확인(선택 의존성이 없으면 건너뜀)
    if (stage === 'implementation') await swd(['ddl-check'], { root: this.root, onLine: (l) => this.log(l.trim(), /❌|✘/.test(l) ? 'warn' : 'info'), signal });
    this.set({ stageStatus: { ...this.state.stageStatus, [stage]: res.errors.length ? 'done-with-errors' : 'done' } });
    this.log(`── ${name}단계 완료`);
  }

  async linkCrossSub() {
    const signal = this.abort.signal;
    await swd(['link'], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
    try {
      const added = await linkComponents(await context(this.root), this.provider, this.masterOpts('links'));
      this.log(added.length ? `서브시스템 간 컴포넌트 의존 ${added.length}건 보완: ${added.join(', ')}` : '보완할 서브시스템 간 컴포넌트 의존 없음');
    } catch (e) { this.log(`컴포넌트 의존 보완 건너뜀: ${e.message}`, 'warn'); }
  }

  // ── 수정사항 반영: 사용자가 승인한 변경만 영향 산출물에 반영 → 검증 → 이력 → 문서 재생성 ──
  async runChange({ inputId, approvedNos = [], memo = '' }) {
    const signal = this.abort.signal;
    try {
      this.provider = createProvider(this.providerSettings, { kitDir: KIT_SKILL });
      this.agentMode = this.mode === 'agent' || (this.mode === 'auto' && this.provider.canAgent);
      this.log(`수정사항 ${inputId} 반영 — 모델: ${this.provider.label}`);
      await swd(['ingest'], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
      let ctx = await context(this.root);
      const dir = path.join(ctx.p.work, 'changes');
      const review = await readYamlFile(path.join(dir, `${inputId}-review.yaml`), null);
      if (!review?.changes?.length) throw new Error('먼저 영향 분석을 실행하세요');
      const approved = review.changes.filter((c) => approvedNos.includes(c.no));
      const excluded = review.changes.filter((c) => !approvedNos.includes(c.no));
      if (!approved.length) throw new Error('승인한 변경이 없습니다');
      const notes = [
        `# ${inputId} 승인된 반영 범위`, '', '아래 내용만 모델에 반영한다. 수정 요청 원문에 있어도 "반영하지 않음"에 있는 변경은 하지 않는다.', '',
        '## 반영', ...approved.map((c) => `- (${c.no}) ${c.summary}${c.proposal ? ` — ${c.proposal}` : ''}${c.source ? ` [${c.source}]` : ''}`), '',
        '## 반영하지 않음', ...(excluded.length ? excluded.map((c) => `- (${c.no}) ${c.summary} — 사용자가 이번 반영에서 제외했다. 기존 모델을 그대로 둔다.`) : ['- 없음']), '',
        ...(memo ? ['## 사용자 메모', memo, ''] : []),
        '## 작업 규칙', '- 기존 ID를 바꾸지 않는다. 새 항목이 필요하면 기존 ID 규칙의 다음 번호를 쓴다.', `- 변경한 항목의 _meta.sources에 ${inputId}:줄을 추가하고, 근거를 넘어 새로 설계한 필드는 ai_fields에 표시한다.`,
      ].join('\n');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${inputId}-approved.md`), notes, 'utf8');

      const model = await loadModel(ctx);
      const { ORDER } = await lib('schema.mjs');
      const targets = new Map();
      for (const c of approved) for (const a of c.affected || []) {
        for (const code of a.docs || []) {
          if (!model.has(a.sub, code)) { this.log(`${a.sub} ${code}: 작성된 산출물이 없어 건너뜀(생략됐거나 아직 작성 전)`, 'warn'); continue; }
          if (!targets.has(a.sub)) targets.set(a.sub, new Set());
          targets.get(a.sub).add(code);
        }
      }
      const byOrder = (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b);
      const { writePrompt } = await lib('prompt.mjs');
      const change = { inputId, notes };
      await pool([...targets.entries()], this.concurrency, async ([sub, set]) => {
        const docs = [...set].sort(byOrder);
        this.sub(sub, { stage: 'change', status: 'writing', docs });
        const logFile = path.join(this.logDir, `change_${inputId}_${sub}.log`);
        try {
          const lctx = await context(this.root);
          if (this.agentMode) {
            const phase = lctx.schemas.byCode[docs[docs.length - 1]].phase;
            const { file } = await writePrompt(lctx, await loadModel(lctx), { stage: phase, sub, docs, change });
            await writeSubAgent(lctx, this.provider, { stage: phase, sub, promptFile: file, log: (m) => this.log(m), signal, logFile });
          } else {
            for (const code of docs) await writeSubChat(lctx, this.provider, { stage: lctx.schemas.byCode[code].phase, sub, docs: [code], change, log: (m) => this.log(m), signal, logFile });
          }
          this.sub(sub, { status: 'written' });
        } catch (e) { this.sub(sub, { status: 'failed', error: e.message }); this.log(`${sub} 반영 실패: ${e.message}`, 'error'); }
      });

      ctx = await context(this.root);
      const res = await validate(ctx, await loadModel(ctx), {});
      this.log(`검증: 오류 ${res.errors.length} · 경고 ${res.warnings.length}`, res.errors.length ? 'warn' : 'info');
      const docList = [...targets.entries()].flatMap(([sub, set]) => [...set].map((c) => `${sub}:${c}`));
      if (docList.length) await swd(['history', 'add', '--docs', docList.join(','), '--content', `${inputId} 반영: ${approved.map((c) => c.summary).join(' / ')}`], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
      const phases = [...new Set(docList.map((d) => ctx.schemas.byCode[d.split(':')[1]].phase))].sort((a, b) => STAGES.indexOf(a) - STAGES.indexOf(b));
      for (const ph of phases) {
        if (ph !== 'analysis') await swd(['derive', '--stage', ph], { root: this.root, onLine: (l) => this.log(l.trim()), signal }).catch(() => {});
        const b = await swd(['build', '--stage', ph], { root: this.root, onLine: (l) => this.log(l.trim()), signal });
        const m = /검토 리포트: (.+\.md)/.exec(b.out);
        if (m) this.state.reports[ph] = m[1].trim();
      }
      await writeYamlFile(path.join(dir, `${inputId}-applied.yaml`), { input: inputId, applied_at: new Date().toISOString(), approved: approved.map((c) => c.no), excluded: excluded.map((c) => c.no), docs: docList });
      this.set({ status: 'done', finishedAt: new Date().toISOString() });
      this.log(`수정사항 ${inputId} 반영 완료 (${docList.length}개 산출물)`);
    } catch (e) {
      this.set({ status: signal.aborted ? 'stopped' : 'failed', error: e.message, finishedAt: new Date().toISOString() });
      this.log(`${signal.aborted ? '중지됨' : `실패: ${e.message}`}`, 'error');
    }
    return this.state;
  }

  // 가이드 Ⅲ.3.1: 프로그램 코드는 실제 코드의 물리적 형상 — 소스가 없으면 만들지 않는다
  async preSkipI1(ctx) {
    const model = await loadModel(ctx);
    const { skipFile } = await lib('model.mjs');
    for (const s of ctx.cfg.subsystems) {
      if (model.has(s.id, 'I1') || model.isSkipped(s.id, 'I1')) continue;
      const f = skipFile(ctx.p, s.id);
      const cur = (await readYamlFile(f, {})) || {};
      cur.I1 = {
        reason: "가이드 Ⅲ.3.1 프로그램 코드는 '설계 명세서에서 기술한 프로그램 코드에 대한 물리적인 형상'을 기술하는데, 실제 소스 코드나 프로그램 목록 자료가 없다",
        needs: '프로그램 소스 폴더(swd scan-code --src <폴더> --sub <ID>) 또는 프로그램 목록 자료',
        sources: [],
      };
      await writeYamlFile(f, cur);
    }
    this.log('소스 코드가 없어 I1(프로그램 코드)은 서브시스템마다 생략으로 기록');
  }
}

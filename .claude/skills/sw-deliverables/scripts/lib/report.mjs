// 검토 리포트: 단계 확인 게이트에서 사람에게 보여줄 요약·AI 제안·미정·질문지
import fs from 'node:fs';
import path from 'node:path';
import { isEmpty, unrenderedReason } from './model.mjs';
import { isAiUnconfirmed, tbdOf, collectSilentFields } from './values.mjs';
import { isoToday, subsystemById } from './project.mjs';
import { PHASE_NAMES } from './schema.mjs';

const brief = (v, n = 60) => {
  const s = Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.name || x.message || JSON.stringify(x) : x)).join(' / ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function fillAsk(tpl, item) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (item[k] !== undefined ? brief(item[k], 40) : `{${k}}`));
}

export function analyzeDoc(ctx, d) {
  const schema = ctx.schemas.byCode[d.code];
  const silent = collectSilentFields(schema);
  const out = { entities: 0, missing: 0, tbd: 0, ai: 0, gaps: [], tbds: [], ais: [] };
  for (const [coll, espec] of Object.entries(schema.entities || {})) {
    const val = d.data?.[coll];
    if (espec.type === 'sections') {
      for (const node of schema.outline || []) {
        if (!node.key) continue;
        const sec = val?.[node.key];
        const meta = sec?._meta;
        const empty = !sec || (isEmpty(sec.text) && !sec.table && !sec.mermaid);
        if (empty) {
          if (tbdOf(meta, 'text') !== null) { out.tbd += 1; out.tbds.push({ id: node.num, field: node.title, reason: tbdOf(meta, 'text') }); }
          else { out.missing += 1; out.gaps.push({ id: node.num, label: node.title, question: `${schema.name} '${node.num} ${node.title}'에 들어갈 내용(관련 자료)이 있나요?` }); }
        } else if (isAiUnconfirmed(meta, 'text')) { out.ai += 1; out.ais.push({ id: node.num, field: node.title, value: brief(sec.text || sec.table?.rows || sec.mermaid) }); }
      }
      continue;
    }
    if (espec.type === 'object') {
      if (!val) continue;
      out.entities += 1;
      if (isAiUnconfirmed(val._meta, null) || isAiUnconfirmed(val._meta, 'text') || isAiUnconfirmed(val._meta, 'description')) {
        out.ai += 1;
        out.ais.push({ id: coll, field: espec.desc || coll, value: brief(val.description || val.text || val.mermaid) });
      }
      continue;
    }
    if (!Array.isArray(val)) continue;
    for (const item of val) {
      out.entities += 1;
      const meta = item?._meta || {};
      const idLabel = item.id || item.term || item.name || item.requirement_id || coll;
      if (meta.origin === 'ai' && !meta.confirmed) {
        out.ai += 1;
        out.ais.push({ id: idLabel, field: '(항목 전체)', value: brief(item.name || item.description || item.test_type) });
      }
      for (const [fname, f] of Object.entries(espec.fields || {})) {
        if (!f || typeof f !== 'object' || fname === '_meta' || silent.has(fname) || f.type === 'mermaid') continue;
        if (f.result && !schema.results) continue;
        const v = item[fname];
        const tbd = tbdOf(meta, fname);
        if (Array.isArray(v) && v.length === 0) continue; // 빈 목록 명시 = 해당 없음
        if (isEmpty(v)) {
          if (tbd !== null) { out.tbd += 1; out.tbds.push({ id: idLabel, field: f.label || fname, reason: tbd }); }
          else {
            out.missing += 1;
            out.gaps.push({ id: idLabel, label: f.label || fname, question: f.ask ? fillAsk(f.ask, item) : null });
          }
        } else if (meta.origin !== 'ai' && isAiUnconfirmed(meta, fname)) {
          out.ai += 1;
          out.ais.push({ id: idLabel, field: f.label || fname, value: brief(v) });
        }
      }
    }
  }
  return out;
}

export function buildReport(ctx, model, validation, { codes, subs, stage }) {
  const rows = [];
  const docs = Object.values(model.docs)
    .filter((d) => (!codes || codes.includes(d.code)) && (!subs || subs.includes(d.sub)))
    .sort((a, b) => a.sub.localeCompare(b.sub) || ctx.schemas.list.findIndex((s) => s.code === a.code) - ctx.schemas.list.findIndex((s) => s.code === b.code));
  const skipped = [];
  for (const d of docs) {
    // 결과 없는 결과서는 문서를 만들지 않으므로 요약 대신 '만들지 않은 산출물'에 둔다
    const why = unrenderedReason(ctx, model, d.sub, d.code);
    if (why) { skipped.push({ sub: d.sub, code: d.code, name: ctx.schemas.byCode[d.code].name, reason: why, needs: '실제 시험 수행 결과(수행자·수행일·결과·결함)' }); continue; }
    const a = analyzeDoc(ctx, d);
    const err = validation.errors.filter((e) => e.sub === d.sub && e.code === d.code).length;
    const warn = validation.warnings.filter((e) => e.sub === d.sub && e.code === d.code).length;
    rows.push({ sub: d.sub, code: d.code, name: ctx.schemas.byCode[d.code].name, ...a, errors: err, warnings: warn });
  }
  for (const [sub, map] of Object.entries(model.skipped || {})) {
    if (subs && !subs.includes(sub)) continue;
    for (const [code, info] of Object.entries(map || {})) {
      if (codes && !codes.includes(code)) continue;
      skipped.push({ sub, code, name: ctx.schemas.byCode[code]?.name || code, reason: info?.reason || '', needs: info?.needs || '', sources: info?.sources || [] });
    }
  }
  // 설정에서 제외한 산출물(가이드 Ⅰ.3: 관련 업무가 없으면 생략 가능)
  for (const code of ctx.cfg.deliverables?.skip || []) {
    if (stage && ctx.schemas.byCode[code]?.phase !== stage) continue;
    skipped.push({ sub: '전체', code, name: ctx.schemas.byCode[code]?.name || code, reason: 'sw-config.yaml deliverables.skip — 관련 업무 없음(가이드 Ⅰ.3)', needs: '' });
  }
  return { stage, date: isoToday(), rows, skipped, validation };
}

export function reportMarkdown(ctx, rep) {
  const L = [];
  const stageName = PHASE_NAMES[rep.stage] || rep.stage || '전체';
  const miss = ctx.cfg.markers?.missing || '(정보 부족)';
  const tbdM = ctx.cfg.markers?.tbd || '(미정)';
  L.push(`# 검토 리포트 — ${stageName}단계 (${rep.date})`, '');
  L.push(`> 시스템: ${ctx.cfg.project?.system_name || '(미설정)'} · 표기: ${miss} 입력 자료에 정보 없음 · ${tbdM} 논의됐으나 미결정 · AI 제안 = 노란 음영(검토 전)`, '');
  L.push('## 1. 요약', '');
  L.push('| 서브시스템 | 산출물 | 항목 수 | 정보 부족 | 미정 | AI 제안(미확인) | 오류 | 경고 |', '|---|---|---:|---:|---:|---:|---:|---:|');
  const tot = { entities: 0, missing: 0, tbd: 0, ai: 0, errors: 0, warnings: 0 };
  for (const r of rep.rows) {
    const sub = subsystemById(ctx.cfg, r.sub);
    L.push(`| ${r.sub} ${sub?.name || ''} | ${r.code} ${r.name} | ${r.entities} | ${r.missing} | ${r.tbd} | ${r.ai} | ${r.errors} | ${r.warnings} |`);
    for (const k of Object.keys(tot)) tot[k] += r[k] || 0;
  }
  L.push(`| **합계** | | **${tot.entities}** | **${tot.missing}** | **${tot.tbd}** | **${tot.ai}** | **${tot.errors}** | **${tot.warnings}** |`, '');

  L.push('## 2. 만들지 않은 산출물 (근거 부족·관련 업무 없음)', '');
  L.push('> 가이드 작성 목적의 핵심 내용을 입력 자료·선행 산출물로 쓸 수 없는 산출물은 부정확하게 만들지 않고 여기에 남긴다. 필요한 자료를 넣고 다시 실행하면 작성된다.', '');
  if (!rep.skipped?.length) L.push('- 없음', '');
  else {
    L.push('| 서브시스템 | 산출물 | 사유 | 필요한 자료 |', '|---|---|---|---|');
    for (const k of rep.skipped) L.push(`| ${k.sub} | ${k.code} ${k.name} | ${String(k.reason).replace(/\|/g, '/')} | ${String(k.needs || '').replace(/\|/g, '/')} |`);
    L.push('');
  }

  L.push('## 3. 확인이 필요한 AI 제안', '');
  const withAi = rep.rows.filter((r) => r.ais.length);
  if (!withAi.length) L.push('- 없음', '');
  for (const r of withAi) {
    // 항목(ID)별로 묶어 한 줄: `ID` 필드1·필드2 — 대표 값
    const byId = new Map();
    for (const a of r.ais) {
      if (!byId.has(a.id)) byId.set(a.id, { fields: [], values: [] });
      const g = byId.get(a.id);
      g.fields.push(a.field);
      if (a.value) g.values.push(a.value);
    }
    L.push(`### ${r.sub} · ${r.code} ${r.name} (항목 ${byId.size}개 · 칸 ${r.ais.length}개)`);
    let k = 0;
    for (const [id, g] of byId) {
      if (++k > 50) { L.push(`- … 외 ${byId.size - 50}개 항목`); break; }
      const rep = g.values.sort((x, y) => y.length - x.length)[0] || '';
      L.push(`- \`${id}\` ${g.fields.join('·')} — ${rep}`);
    }
    L.push('');
  }

  L.push('## 4. 미정 항목 (회의에서 결정되지 않음)', '');
  const withTbd = rep.rows.filter((r) => r.tbds.length);
  if (!withTbd.length) L.push('- 없음', '');
  for (const r of withTbd) {
    L.push(`### ${r.sub} · ${r.code} ${r.name}`);
    for (const t of r.tbds) L.push(`- \`${t.id}\` ${t.field}${t.reason ? ` — ${t.reason}` : ''}`);
    L.push('');
  }

  L.push('## 5. 정보 부족 — 답해 주시면 다음 실행에 반영되는 질문', '');
  let qn = 0;
  for (const r of rep.rows) {
    const qs = r.gaps.filter((g) => g.question);
    if (!qs.length) continue;
    L.push(`### ${r.sub} · ${r.code} ${r.name}`);
    const seen = new Set();
    for (const g of qs) {
      if (seen.has(g.question)) continue;
      seen.add(g.question);
      L.push(`${++qn}. ${g.question} \`[${g.id}]\``);
      if (qn > 400) break;
    }
    L.push('');
  }
  if (!qn) L.push('- 없음', '');
  const other = rep.rows.reduce((a, r) => a + r.gaps.filter((g) => !g.question).length, 0);
  if (other) L.push(`그 밖에 질문 템플릿이 없는 ${miss} 칸 ${other}개는 문서에 그대로 표시됩니다.`, '');

  L.push('## 6. 검증 결과', '');
  const v = rep.validation;
  L.push(`- 오류 ${v.errors.length}건 · 경고 ${v.warnings.length}건`, '');
  for (const e of v.errors.slice(0, 80)) L.push(`- ❌ ${[e.sub, e.code, e.id, e.field].filter(Boolean).join(' · ')} — ${e.message}`);
  const trace = v.warnings.filter((w) => w.message.startsWith('추적성'));
  const others = v.warnings.filter((w) => !w.message.startsWith('추적성'));
  for (const w of others.slice(0, 60)) L.push(`- ⚠️ ${[w.sub, w.code, w.id, w.field].filter(Boolean).join(' · ')} — ${w.message}`);
  if (trace.length) {
    L.push('', `### 추적성 누락 (${trace.length}건)`);
    for (const w of trace.slice(0, 80)) L.push(`- ${w.message}`);
  }
  L.push('');
  return L.join('\n');
}

export function writeReport(ctx, rep) {
  fs.mkdirSync(ctx.p.reports, { recursive: true });
  const stageName = PHASE_NAMES[rep.stage] || rep.stage || '전체';
  const file = path.join(ctx.p.reports, `검토리포트_${stageName}_${rep.date}.md`);
  fs.writeFileSync(file, reportMarkdown(ctx, rep), 'utf8');
  fs.mkdirSync(path.join(ctx.p.work, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ctx.p.work, 'reports', 'review.json'), JSON.stringify(rep, null, 1), 'utf8');
  return file;
}

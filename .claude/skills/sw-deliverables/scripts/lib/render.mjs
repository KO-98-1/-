// DOCX 렌더링 엔진: 스키마 layout + 모델 → 가이드 양식 문서
// 양식 골격(▣ 제·개정 이력 → 헤더표 → 본문)은 모든 산출물에 동일하게 적용된다.
import fs from 'node:fs';
import path from 'node:path';
import { dep } from './deps.mjs';
import { readYaml, formatDate, subsystemById } from './project.mjs';
import { isEmpty, lookup } from './model.mjs';
import { resolveCell, collectSilentFields, getPath, isAiUnconfirmed, tbdOf } from './values.mjs';
import { reqCategory } from './schema.mjs';
import { documentId } from './ids.mjs';
import { traceRows, databasesUsed, dbTables, ddlRows, ddlScripts } from './computed.mjs';
import { loadInputIndex } from './ingest.mjs';
import { diagramPath } from './diagrams.mjs';

const GRID = 24;
const PAGE = { w: 11906, h: 16838, margin: 1134 };
const COLORS = { head: 'D9D9D9', label: 'F2F2F2', missing: '808080', tbd: 'C55A11', border: '404040' };

let D = null;

function pngSize(buf) {
  if (buf.readUInt32BE(12) !== 0x49484452) return { w: 800, h: 600 };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function outputDir(ctx, sub) {
  if (sub === 'SYSTEM') return path.join(ctx.p.output, '00_시스템공통');
  const s = subsystemById(ctx.cfg, sub);
  return path.join(ctx.p.output, `${sub}_${(s?.name || sub).replace(/[\\/:*?"<>|]/g, '_')}`);
}

export function outputFile(ctx, sub, schema) {
  const docId = documentId(ctx.cfg, sub, schema.doc);
  return path.join(outputDir(ctx, sub), `${docId}_${schema.name.replace(/\s+/g, '')}.docx`);
}

// ── 기본 요소 ───────────────────────────────────────────
function run(text, o = {}) {
  return new D.TextRun({ text: String(text ?? ''), bold: o.bold, italics: o.italics, size: o.size, color: o.color });
}

function para(text, o = {}) {
  const shading = o.fill ? { type: D.ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined;
  return new D.Paragraph({
    children: o.children || [run(text, o)],
    alignment: o.align === 'center' ? D.AlignmentType.CENTER : o.align === 'right' ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT,
    spacing: { before: o.before ?? 0, after: o.after ?? 0, line: o.line ?? 260 },
    shading,
    keepNext: o.keepNext,
    indent: o.indent ? { left: o.indent } : undefined,
  });
}

function stateParas(res, rc, o = {}) {
  const size = o.size ?? rc.fontSize;
  const k = o.keepNext;
  if (res.state === 'missing') return [para(rc.markers.missing, { size, color: COLORS.missing, italics: true, align: o.align, keepNext: k })];
  if (res.state === 'tbd') return [para(rc.markers.tbd, { size, color: COLORS.tbd, align: o.align, keepNext: k })];
  if (res.state === 'none') return [para(rc.markers.none, { size, align: o.align, keepNext: k })];
  if (res.state === 'blank' || !res.lines.length) return [para('', { size, keepNext: k })];
  return res.lines.map((l) => para(l, { size, align: o.align, keepNext: k }));
}

function cell(children, o = {}) {
  const kids = Array.isArray(children) ? children : [children];
  return new D.TableCell({
    children: kids.length ? kids : [para('')],
    width: o.width ? { size: Math.round(o.width), type: D.WidthType.DXA } : undefined,
    columnSpan: o.span && o.span > 1 ? o.span : undefined,
    verticalMerge: o.vmerge === 'restart' ? D.VerticalMergeType.RESTART : o.vmerge === 'continue' ? D.VerticalMergeType.CONTINUE : undefined,
    shading: o.fill ? { type: D.ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
    verticalAlign: D.VerticalAlign.CENTER,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
  });
}

const borders = () => {
  const b = { style: D.BorderStyle.SINGLE, size: 4, color: COLORS.border };
  return { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b };
};

function table(rows, widths) {
  return new D.Table({
    rows,
    width: { size: widths.reduce((a, b) => a + b, 0), type: D.WidthType.DXA },
    columnWidths: widths,
    layout: D.TableLayoutType.FIXED,
    borders: borders(),
  });
}

function distribute(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k][1]] += 1;
  return out;
}

function spanWidths(rc, spans) {
  const colW = rc.W / GRID;
  return spans.map((s) => s * colW);
}

// ── 행 소스 ─────────────────────────────────────────────
function computed(name, rc, row) {
  const { ctx, model, sub } = rc;
  if (name === '$subsystems') return ctx.cfg.subsystems.map((s) => ({ ...s, _meta: { origin: 'derived' } }));
  if (name === '$trace') return traceRows(ctx, model).map((r) => ({ ...r, _group: r.req_id, _meta: { origin: 'derived' } }));
  if (name === '$databases_used') return databasesUsed(ctx, model, sub);
  if (name === '$db_tables') return dbTables(model, sub, row?.entity?.id);
  if (name === '$ddl_rows') return ddlRows(ctx, model, sub).map((r) => ({ ...r, _group: r.script_id }));
  return [];
}

function applyFilter(list, filter, rc) {
  if (!filter) return list;
  return list.filter((e) => {
    const v = getPath(e, filter.field);
    if (filter.group) return (reqCategory(rc.schemas, v)?.group || (filter.group === 'functional' ? null : 'nonfunctional')) === filter.group;
    if (filter.in) return filter.in.includes(v);
    if (filter.not_in) return !filter.not_in.includes(v);
    return true;
  });
}

function sortBy(list, key) {
  if (!key) return list;
  const val = (e) => {
    const v = getPath(e, key);
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  };
  return [...list].sort((a, b) => val(a).localeCompare(val(b), 'ko', { numeric: true }));
}

function rowsFrom(spec, rc, baseRow) {
  let list;
  const src = spec.source;
  if (spec.self_row) return [baseRow];
  if (!src) list = [];
  else if (src.startsWith('$')) list = computed(src, rc, baseRow);
  else if (baseRow) {
    const base = src.startsWith('item.') ? baseRow.item : src.startsWith('parent.') ? baseRow.parent : baseRow.entity;
    const key = src.replace(/^(item|parent)\./, '');
    list = getPath(base, key) || [];
  } else list = getPath(rc.data, src) || [];
  if (!Array.isArray(list)) list = [];
  list = sortBy(applyFilter(list, spec.filter, rc), spec.sort);
  let inherited = baseRow?.meta || null;
  // 상위 항목이 이 목록 필드 전체를 AI 추정(ai_fields)으로 표시했으면 하위 행도 AI 제안으로 본다
  if (baseRow && src && !src.startsWith('$')) {
    const listField = src.replace(/^(item|parent)\./, '').split('.')[0];
    if (isAiUnconfirmed(baseRow.meta, listField) && baseRow.meta?.origin !== 'ai') inherited = { origin: 'ai', sources: baseRow.meta?.sources };
  }
  if (spec.flatten) {
    const out = [];
    for (const e of list) {
      const kids = Array.isArray(e[spec.flatten]) ? e[spec.flatten] : [];
      if (!kids.length) out.push({ entity: {}, parent: e, item: {}, meta: e._meta || inherited });
      for (const k of kids) out.push({ entity: k, parent: e, item: k, meta: k?._meta || e._meta || inherited });
    }
    return out;
  }
  return list.map((e) => ({ entity: e, parent: baseRow?.entity, item: e, meta: e?._meta || inherited }));
}

function resolve(spec, row, rc, extra = {}) {
  const res = resolveCell(spec, { ...row, ...extra }, rc);
  // 추적표: 연결 없는 칸은 '-' (정보 부족이 아니라 후속 산출물 미작성)
  if (spec.trace && (res.state === 'missing' || res.state === 'none' || (res.state === 'ok' && !res.lines.length))) {
    return { lines: [rc.markers.trace_empty], state: 'ok', ai: false };
  }
  rc.stats[res.state] = (rc.stats[res.state] || 0) + 1;
  if (res.ai) { rc.stats.ai = (rc.stats.ai || 0) + 1; rc.aiUsed = true; }
  return res;
}

const aiFill = (res, rc) => (res.ai && rc.ctx.cfg.ai_proposal?.highlight !== false ? rc.ctx.cfg.ai_proposal?.color || 'FFF2B3' : undefined);

// ── 표 머리글(그룹 행 + 열 이름 행) ─────────────────────
function headerRows(columns, groups, widths, rc, colSpans = null) {
  const out = [];
  const spanOf = (c) => (colSpans ? colSpans[c] : 1);
  const wOf = (c0, n) => widths.slice(c0, c0 + n).reduce((a, b) => a + b, 0);
  const merged = new Map(); // 시작 열 → 열 개수 (그룹 행에서 세로 병합된 영역)
  for (const g of groups || []) {
    const cells = [];
    let c = 0;
    for (const h of g) {
      const n = h.span || 1;
      const label = h.label || (h.rowspan === 2 ? columns[c]?.label : '');
      const spanUnits = colSpans ? colSpans.slice(c, c + n).reduce((a, b) => a + b, 0) : n;
      cells.push(cell(para(label, { bold: true, size: rc.fontSize, align: 'center' }), {
        width: wOf(c, n), span: spanUnits, fill: COLORS.head, vmerge: h.rowspan === 2 ? 'restart' : undefined,
      }));
      if (h.rowspan === 2) merged.set(c, n);
      c += n;
    }
    out.push(new D.TableRow({ children: cells, tableHeader: true }));
  }
  const cells = [];
  for (let c = 0; c < columns.length;) {
    if (merged.has(c)) {
      const n = merged.get(c);
      const spanUnits = colSpans ? colSpans.slice(c, c + n).reduce((a, b) => a + b, 0) : n;
      cells.push(cell(para(''), { width: wOf(c, n), span: spanUnits, fill: COLORS.head, vmerge: 'continue' }));
      c += n;
      continue;
    }
    const col = columns[c];
    const kids = [para(col.label, { bold: true, size: rc.fontSize, align: 'center' })];
    if (col.header_note) kids.push(para(col.header_note, { size: rc.fontSize - 2, align: 'center' }));
    cells.push(cell(kids, { width: widths[c], span: spanOf(c), fill: COLORS.head }));
    c += 1;
  }
  out.push(new D.TableRow({ children: cells, tableHeader: true }));
  return out;
}

// 병합 대상 열: 연속 행의 값과 그룹이 같으면 세로 병합
function mergePlan(rows, columns, resolved) {
  const plan = rows.map(() => columns.map(() => null));
  const groupIds = new Map();
  const groupOf = (r) => {
    const g = r.parent ?? r.entity?._group ?? null;
    if (g === null || typeof g !== 'object') return String(g);
    if (!groupIds.has(g)) groupIds.set(g, `o${groupIds.size}`);
    return groupIds.get(g);
  };
  columns.forEach((col, c) => {
    if (!col.merge) return;
    let start = 0;
    const keyOf = (i) => JSON.stringify([resolved[i][c].lines, resolved[i][c].state, groupOf(rows[i])]);
    for (let i = 1; i <= rows.length; i++) {
      if (i < rows.length && keyOf(i) === keyOf(start)) continue;
      if (i - start > 1) {
        plan[start][c] = 'restart';
        for (let k = start + 1; k < i; k++) plan[k][c] = 'continue';
      }
      start = i;
    }
  });
  return plan;
}

function dataRows(rows, columns, widths, rc, colSpans = null) {
  const resolved = rows.map((row) => columns.map((col) => resolve(col, row, rc)));
  const plan = mergePlan(rows, columns, resolved);
  return rows.map((row, i) => new D.TableRow({
    cantSplit: false,
    children: columns.map((col, c) => {
      const res = resolved[i][c];
      const vm = plan[i][c];
      const kids = vm === 'continue' ? [para('')] : stateParas(res, rc, { align: col.align });
      return cell(kids, { width: widths[c], span: colSpans ? colSpans[c] : 1, fill: vm === 'continue' ? undefined : aiFill(res, rc), vmerge: vm });
    }),
  }));
}

// ── 목록 표 ─────────────────────────────────────────────
function listTable(spec, rc) {
  const columns = spec.columns;
  const widths = distribute(rc.W, columns.map((c) => c.w || 1));
  const rows = rowsFrom(spec, rc, null);
  const tRows = headerRows(columns, spec.header, widths, rc);
  if (!rows.length) {
    rc.stats.missing = (rc.stats.missing || 0) + 1;
    tRows.push(new D.TableRow({ children: [cell(para(rc.markers.missing, { size: rc.fontSize, color: COLORS.missing, italics: true, align: 'center' }), { width: rc.W, span: columns.length })] }));
  } else tRows.push(...dataRows(rows, columns, widths, rc));
  return [table(tRows, widths), para('', { after: 120 })];
}

// ── 카드(항목별 명세 표, 24칸 격자) ─────────────────────
const KV_SPANS = { 1: [5, 19], 2: [5, 7, 5, 7], 3: [4, 4, 4, 4, 4, 4] };

function diagramCell(spec, row, rc, span = GRID) {
  const key = spec.key ? getPath(row.entity, spec.key) ?? getPath(row, spec.key) : null;
  const file = diagramPath(rc.ctx, rc.sub, spec.kind, key);
  const kids = [];
  // 그림은 칸 전체를 칠하지 않고 캡션에만 AI 제안 표시(그림 가독성 유지)
  const ai = row.meta && isAiUnconfirmed(row.meta, null) && spec.kind !== 'wireframe';
  const fill = ai && rc.ctx.cfg.ai_proposal?.highlight !== false ? rc.ctx.cfg.ai_proposal?.color : undefined;
  if (key && fs.existsSync(file)) {
    const name = row.entity?.name ? ` ${row.entity.name}` : '';
    const caption = `[그림] ${key}${name}${spec.caption_suffix ? ` — ${spec.caption_suffix}` : ''}${ai ? ' (AI 제안)' : ''}`;
    kids.push(imagePara(file, rc, rc.W - 300, { caption, fill }));
    kids.push(para(caption, { size: rc.fontSize - 1, align: 'center', color: '404040', fill }));
    rc.stats.ok = (rc.stats.ok || 0) + 1;
    if (ai) rc.aiUsed = true;
  } else {
    kids.push(para(rc.markers.missing, { size: rc.fontSize, color: COLORS.missing, italics: true, align: 'center' }));
    rc.stats.missing = (rc.stats.missing || 0) + 1;
  }
  return cell(kids, { width: rc.W, span });
}

// 가로 쪽 그림 크기(px): 가로 A4 본문 폭·높이에서 머리글·캡션 여유를 뺀 값
const LAND_W = ((PAGE.h - PAGE.margin * 2) / 1440) * 96;
const LAND_H = ((PAGE.w - PAGE.margin * 2) / 1440) * 96 - 70;

// 세로 문서에서 이 그림이 글씨가 읽기 어려울 만큼 줄어드는지(가로 쪽이면 충분히 커지는지)
function isWideFigure(file, maxWdxa) {
  if (!fs.existsSync(file)) return false;
  const { w, h } = pngSize(fs.readFileSync(file));
  const cw = w / 2;
  const ch = h / 2;
  const scale = Math.min(1, ((maxWdxa / 1440) * 96) / cw, 540 / ch);
  const landScale = Math.min(1, LAND_W / cw, LAND_H / ch);
  return scale < 0.6 && landScale >= scale * 1.3;
}

function imagePara(file, rc, maxWdxa, figure = null) {
  const buf = fs.readFileSync(file);
  const { w, h } = pngSize(buf);
  let cw = w / 2;
  let ch = h / 2; // deviceScaleFactor 2 로 렌더링됨
  const maxW = (maxWdxa / 1440) * 96;
  const maxH = rc.landscape ? 380 : 540; // 헤더가 있는 첫 쪽에도 그림이 들어가도록
  const scale = Math.min(1, maxW / cw, maxH / ch);
  // 세로 문서에서 글씨가 읽기 어려울 만큼 줄어드는 넓은 그림은 바로 뒤 가로 쪽에 크게 싣는다
  if (figure && !rc.landscape) {
    const landScale = Math.min(1, LAND_W / cw, LAND_H / ch);
    if (isWideFigure(file, maxWdxa)) {
      rc.pendingFigures.push({ buf, cw: Math.round(cw * landScale), ch: Math.round(ch * landScale), caption: figure.caption, fill: figure.fill });
      return para('(그림이 커서 바로 다음 가로 쪽에 크게 실었습니다)', { size: rc.fontSize - 1, align: 'center', color: '606060', italics: true, before: 60, after: 60 });
    }
  }
  cw = Math.round(cw * scale);
  ch = Math.round(ch * scale);
  return new D.Paragraph({
    alignment: D.AlignmentType.CENTER,
    spacing: { before: 60, after: 60 },
    children: [new D.ImageRun({ type: 'png', data: buf, transformation: { width: cw, height: ch } })],
  });
}

function cardTable(spec, row, rc) {
  const trs = [];
  const full = (kids, o = {}) => new D.TableRow({ children: [cell(kids, { width: rc.W, span: GRID, ...o })] });
  // 그림 행 앞의 머리 행은 그림과 같은 쪽에 두도록 '다음과 함께 유지'
  const diagIdx = spec.rows.findIndex((r) => r.diagram);
  spec.rows.forEach((r, ri) => {
    const keepNext = diagIdx > ri;
    if (r.kv) {
      const spans = KV_SPANS[r.kv.length] || KV_SPANS[3];
      const cells = [];
      r.kv.forEach((kv, i) => {
        const res = resolve(kv, row, rc, { inKv: true });
        const [ls, vs] = [spans[i * 2], spans[i * 2 + 1]];
        cells.push(cell(para(kv.label, { bold: true, size: rc.fontSize, align: 'center', keepNext }), { width: spanWidths(rc, [ls])[0], span: ls, fill: COLORS.label }));
        cells.push(cell(stateParas(res, rc, { keepNext }), { width: spanWidths(rc, [vs])[0], span: vs, fill: aiFill(res, rc) }));
      });
      trs.push(new D.TableRow({ children: cells, cantSplit: true }));
    } else if (r.label) {
      trs.push(full(para(r.label, { bold: true, size: rc.fontSize }), { fill: COLORS.label }));
    } else if (r.label_text) {
      const res = resolve(r.label_text, row, rc);
      trs.push(full(para(r.label_text.label, { bold: true, size: rc.fontSize }), { fill: COLORS.label }));
      trs.push(full(stateParas(res, rc), { fill: aiFill(res, rc) }));
    } else if (r.text) {
      const res = resolve(r.text, row, rc);
      trs.push(full(stateParas(res, rc), { fill: aiFill(res, rc) }));
    } else if (r.legend) {
      trs.push(full(para(r.legend, { size: rc.fontSize - 1, italics: true })));
    } else if (r.diagram) {
      trs.push(new D.TableRow({ children: [diagramCell(r.diagram, row, rc)] }));
    } else if (r.subtable) {
      const st = r.subtable;
      const spans = distribute(GRID, st.columns.map((c) => c.w || 1)).map((s) => Math.max(1, s));
      // 합이 24가 되도록 보정
      let diff = GRID - spans.reduce((a, b) => a + b, 0);
      for (let k = spans.length - 1; diff !== 0 && k >= 0; k--) { const d = diff > 0 ? 1 : (spans[k] > 1 ? -1 : 0); spans[k] += d; diff -= d; }
      const widths = spanWidths(rc, spans);
      trs.push(...headerRows(st.columns, st.header, widths, rc, spans).map((tr) => tr));
      const rows = rowsFrom(st, rc, row);
      if (!rows.length) {
        // 빈 목록([])을 명시했으면 '해당 없음', 키가 없으면 '정보 부족'
        const srcKey = st.source && !st.source.startsWith('$') ? st.source.replace(/^(item|parent)\./, '') : null;
        const owner = st.source?.startsWith('item.') ? row.item : st.source?.startsWith('parent.') ? row.parent : row.entity;
        const explicitNone = srcKey && Array.isArray(getPath(owner, srcKey));
        if (explicitNone) trs.push(full(para(rc.markers.none, { size: rc.fontSize, align: 'center' })));
        else {
          rc.stats.missing = (rc.stats.missing || 0) + 1;
          trs.push(full(para(rc.markers.missing, { size: rc.fontSize, color: COLORS.missing, italics: true, align: 'center' })));
        }
      } else trs.push(...dataRows(rows, st.columns, widths, rc, spans));
    }
  });
  const widths = Array.from({ length: GRID }, () => rc.W / GRID);
  return table(trs, widths.map(Math.round));
}

function cards(spec, rc) {
  const rows = rowsFrom(spec, rc, null);
  if (!rows.length) {
    rc.stats.missing = (rc.stats.missing || 0) + 1;
    return [para(rc.markers.missing, { size: rc.fontSize, color: COLORS.missing, italics: true, after: 120 })];
  }
  const out = [];
  const landW = PAGE.h - PAGE.margin * 2;
  for (const row of rows) {
    // 넓은 그림(시퀀스도 등)이 든 카드는 카드 전체를 가로 쪽에 싣는다(세로 쪽에서 글씨가 너무 작아지는 것 방지)
    const wide = !rc.landscape && spec.rows.some((r) => {
      if (!r.diagram) return false;
      const key = r.diagram.key ? getPath(row.entity, r.diagram.key) ?? getPath(row, r.diagram.key) : null;
      return key && isWideFigure(diagramPath(rc.ctx, rc.sub, r.diagram.kind, key), rc.W - 300);
    });
    if (wide) {
      const keep = { W: rc.W, landscape: rc.landscape };
      Object.assign(rc, { W: landW, landscape: true });
      const t = cardTable(spec, row, rc);
      Object.assign(rc, keep);
      out.push({ landscape: [t, para('', { after: 160 })] });
      continue;
    }
    out.push(cardTable(spec, row, rc));
    out.push(para('', { after: 160 }));
    if (rc.pendingFigures.length) out.push({ figures: rc.pendingFigures.splice(0) });
  }
  return out;
}

// ── 단독 그림·본문 블록 ─────────────────────────────────
function standaloneDiagram(spec, rc) {
  const key = spec.ctx ? getPath(rc.ctxVars, spec.ctx) : spec.key;
  const file = diagramPath(rc.ctx, rc.sub, spec.kind, spec.kind === 'narr' ? `${rc.schema.code}-${key}` : key);
  if (fs.existsSync(file)) {
    const meta = spec.kind === 'narr' ? getPath(rc.data, key)?._meta : null;
    const ai = meta && isAiUnconfirmed(meta, 'mermaid');
    if (ai) rc.aiUsed = true;
    rc.stats.ok = (rc.stats.ok || 0) + 1;
    const caption = `[그림] ${spec.caption || key}${ai ? ' (AI 제안)' : ''}`;
    const fill = ai ? rc.ctx.cfg.ai_proposal?.color : undefined;
    const before = rc.pendingFigures.length;
    const img = imagePara(file, rc, rc.W, { caption, fill });
    // 가로 쪽으로 옮긴 그림은 캡션도 그쪽에만 둔다(원래 자리에는 안내 한 줄)
    if (rc.pendingFigures.length > before) return [img];
    return [img, para(caption, { size: rc.fontSize - 1, align: 'center', color: '404040', after: 160, fill })];
  }
  rc.stats.missing = (rc.stats.missing || 0) + 1;
  return [para(rc.markers.missing, { size: rc.fontSize, color: COLORS.missing, italics: true, after: 120 })];
}

function textParas(value, meta, field, rc, o = {}) {
  const ai = isAiUnconfirmed(meta, field);
  const tbd = tbdOf(meta, field);
  if (isEmpty(value)) {
    if (tbd !== null) { rc.stats.tbd = (rc.stats.tbd || 0) + 1; return [para(rc.markers.tbd, { color: COLORS.tbd, after: 120 })]; }
    rc.stats.missing = (rc.stats.missing || 0) + 1;
    return [para(rc.markers.missing, { color: COLORS.missing, italics: true, after: 120 })];
  }
  rc.stats.ok = (rc.stats.ok || 0) + 1;
  if (ai) { rc.stats.ai = (rc.stats.ai || 0) + 1; rc.aiUsed = true; }
  const fill = ai && rc.ctx.cfg.ai_proposal?.highlight !== false ? rc.ctx.cfg.ai_proposal?.color : undefined;
  const lines = Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? (value.length > 1 && !/^\s*[-•·\d]/.test(v) ? `- ${v}` : v) : (v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(', ') : String(v)))) : String(value).split('\n');
  return lines.map((l, i) => para(l, { fill, after: i === lines.length - 1 ? 120 : 0, indent: o.indent }));
}

function textBlock(spec, rc) {
  if (spec.key === '$ddl_files') {
    const files = ddlScripts(rc.ctx, rc.model, rc.sub).map((s) => s.name);
    if (!files.length) return textParas(null, null, null, rc);
    return textParas(files.map((f) => `- ${f} (output/${path.basename(outputDir(rc.ctx, rc.sub))}/DDL/)`), { origin: 'derived' }, null, rc);
  }
  const value = getPath(rc.data, spec.key);
  const meta = spec.meta_of ? getPath(rc.data, spec.meta_of)?._meta : null;
  return textParas(value, meta, spec.key.split('.').pop(), rc);
}

// ── 서술형(목차형) 산출물 ───────────────────────────────
function heading(num, title, depth) {
  const size = depth <= 1 ? 24 : depth === 2 ? 22 : 20;
  const p = para(`${num}${title ? ` ${title}` : ''}`.trim(), { bold: true, size, before: depth <= 1 ? 280 : 180, after: 100, keepNext: true });
  p.movesWithNext = true; // 바로 뒤가 가로 쪽 구역이면 제목도 함께 옮긴다(제목만 남은 쪽 방지)
  return p;
}

function simpleTable(columns, rows, rc, meta) {
  const widths = distribute(rc.W, columns.map(() => 1));
  const trs = headerRows(columns.map((c) => ({ label: c })), null, widths, rc);
  const ai = isAiUnconfirmed(meta, 'table');
  if (ai) rc.aiUsed = true;
  const fill = ai && rc.ctx.cfg.ai_proposal?.highlight !== false ? rc.ctx.cfg.ai_proposal?.color : undefined;
  if (!rows || !rows.length) {
    rc.stats.missing = (rc.stats.missing || 0) + 1;
    trs.push(new D.TableRow({ children: [cell(para(rc.markers.missing, { size: rc.fontSize, color: COLORS.missing, italics: true, align: 'center' }), { width: rc.W, span: columns.length })] }));
  } else {
    for (const r of rows) {
      const vals = Array.isArray(r) ? r : columns.map((c) => r[c]);
      trs.push(new D.TableRow({
        children: columns.map((c, i) => {
          const v = vals[i];
          const empty = v === undefined || v === null || v === '';
          rc.stats[empty ? 'missing' : 'ok'] = (rc.stats[empty ? 'missing' : 'ok'] || 0) + 1;
          const kids = empty
            ? [para(rc.markers.missing, { size: rc.fontSize, color: COLORS.missing, italics: true })]
            : String(v).split('\n').map((l) => para(l, { size: rc.fontSize }));
          return cell(kids, { width: widths[i], fill: empty ? undefined : fill });
        }),
      }));
    }
  }
  return [table(trs, widths), para('', { after: 120 })];
}

function sectionContent(sec, node, rc, diagKey) {
  const out = [];
  const meta = sec?._meta || null;
  const hasAny = sec && (!isEmpty(sec.text) || sec.table || sec.mermaid);
  if (!hasAny) {
    if (node.diagram) out.push(...standaloneDiagram({ kind: 'narr', key: diagKey, caption: node.title }, rc));
    if (node.table) out.push(...simpleTable(node.table.columns, (node.table.rows_default || []).map((r) => node.table.columns.map((_, i) => r[i] ?? '')), rc, meta));
    if (!node.diagram && !node.table) out.push(...textParas(null, meta, 'text', rc));
    return out;
  }
  if (!isEmpty(sec.text)) out.push(...textParas(sec.text, meta, 'text', rc));
  if (sec.mermaid || node.diagram) out.push(...standaloneDiagram({ kind: 'narr', key: diagKey, caption: node.title }, rc));
  if (sec.table || node.table) {
    const cols = sec.table?.columns || node.table?.columns || [];
    out.push(...simpleTable(cols, sec.table?.rows || [], rc, meta));
  }
  return out;
}

function narrative(rc) {
  const out = [];
  const sections = rc.data.sections || {};
  const depthOf = (num) => String(num).split('.').filter(Boolean).length;
  for (const node of rc.schema.outline || []) {
    if (node.repeat) {
      const list = rc.data[node.repeat] || [];
      if (!list.length) {
        rc.stats.missing = (rc.stats.missing || 0) + 1;
        out.push(para(rc.markers.missing, { color: COLORS.missing, italics: true, after: 120 }));
        continue;
      }
      list.forEach((item, i) => {
        const num = node.num.replace('{i}', i + 1);
        out.push(heading(num, item[node.title_key] || rc.markers.missing, depthOf(num)));
        for (const ch of node.children || []) {
          const cnum = ch.num.replace('{i}', i + 1);
          out.push(heading(cnum, ch.title, depthOf(cnum)));
          const v = item[ch.key];
          if (ch.table) {
            const rows = (v || []).map((r) => (ch.table.fields || []).map((f) => r[f]));
            out.push(...simpleTable(ch.table.columns, rows, rc, item._meta));
          } else out.push(...textParas(v, item._meta, ch.key, rc));
        }
      });
      continue;
    }
    out.push(heading(node.plain_title ? node.plain_title : node.num, node.plain_title ? '' : node.title, depthOf(node.num)));
    if (node.key) out.push(...sectionContent(sections[node.key], node, rc, `${node.key}`));
    if (rc.pendingFigures.length) out.push({ figures: rc.pendingFigures.splice(0) });
  }
  return out;
}

// ── 제·개정 이력 + 헤더 ─────────────────────────────────
async function historyTable(rc) {
  const hist = (await readYaml(rc.ctx.p.history, { entries: [] })) || { entries: [] };
  const key = `${rc.sub}:${rc.schema.code}`;
  const entries = (hist.entries || []).filter((e) => (e.docs || [e.doc]).includes(key));
  const widths = distribute(rc.W, [14, 8, 12, 12, 54]);
  const trs = headerRows(['날짜', '버전', '작성자', '승인자', '내용'].map((l) => ({ label: l })), null, widths, rc);
  const fillVersion = rc.ctx.cfg.document?.fill_version === true;
  const rows = entries.length ? entries : [{}];
  for (const e of rows) {
    const vals = [e.date ? formatDate(rc.ctx.cfg, e.date) : '', fillVersion ? e.version || '' : '', e.author || '', e.approver || '', e.content || ''];
    trs.push(new D.TableRow({ children: vals.map((v, i) => cell(para(v, { size: rc.fontSize, align: i < 4 ? 'center' : 'left' }), { width: widths[i] })) }));
  }
  return table(trs, widths);
}

function headerTable(rc) {
  const s = rc.schema;
  const cfg = rc.ctx.cfg;
  const widths = distribute(rc.W, [11, 22, 12, 22, 11, 22]);
  const lab = (t) => cell(para(t, { bold: true, size: rc.fontSize, align: 'center' }), { fill: COLORS.label });
  const val = (t, span = 1, o = {}) => cell(para(t, { size: rc.fontSize, align: 'center', ...o }), { span });
  const sysName = cfg.project?.system_name || '';
  const sub = subsystemById(cfg, rc.sub);
  const rows = [
    new D.TableRow({ children: [cell(para(s.label, { bold: true, size: 22, align: 'center' }), { fill: COLORS.label }), cell(para(s.title, { bold: true, size: 30, align: 'center' }), { span: 5 })] }),
    new D.TableRow({ children: [lab('시스템명'), sysName ? val(sysName, 2) : cell(para(rc.markers.missing, { size: rc.fontSize, color: COLORS.missing, italics: true, align: 'center' }), { span: 2 }), lab('서브시스템명'), val(sub?.name || rc.sub, 2)] }),
    new D.TableRow({ children: [lab('단계명'), val(s.phase_name), lab('작성일자'), val(formatDate(cfg)), lab('버전'), val(cfg.document?.fill_version === true ? (cfg.document?.version || '') : '')] }),
  ];
  return table(rows, widths);
}

// 본문을 쪽 방향별 구역으로 나눈다: {figures} 표시가 있으면 그 자리에 가로 쪽 구역을 넣고 다시 원래 방향으로 돌아온다
function toSections(children, landscape, docId, schema, rc) {
  const props = (land) => ({
    page: {
      size: { width: PAGE.w, height: PAGE.h, orientation: land ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT },
      margin: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin, header: 567, footer: 567 },
    },
  });
  const hf = () => ({
    headers: { default: new D.Header({ children: [para(`${docId}   ${schema.name}`, { size: 15, align: 'right', color: '606060' })] }) },
    footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ children: ['- ', D.PageNumber.CURRENT, ' -'], size: 16 })] })] }) },
  });
  const sections = [];
  let cur = [];
  const close = () => { if (cur.length) sections.push({ properties: props(landscape), ...hf(), children: cur }); cur = []; };
  let land = null; // 연속된 가로 카드는 한 구역으로
  const closeLand = () => { if (land) sections.push({ properties: props(true), ...hf(), children: land }); land = null; };
  for (const c of children) {
    if (c && c.landscape) {
      if (landscape) { cur.push(...c.landscape); continue; }
      // 세로 구역 끝에 남은 제목은 가로 구역 앞으로 옮긴다
      const moved = [];
      while (!land && cur.length && cur[cur.length - 1]?.movesWithNext) moved.unshift(cur.pop());
      close();
      land = [...(land || []), ...moved, ...c.landscape];
      continue;
    }
    closeLand();
    if (c && c.figures) {
      close();
      const kids = [];
      c.figures.forEach((f, i) => {
        kids.push(new D.Paragraph({
          alignment: D.AlignmentType.CENTER, pageBreakBefore: i > 0, spacing: { after: 60 },
          children: [new D.ImageRun({ type: 'png', data: f.buf, transformation: { width: f.cw, height: f.ch } })],
        }));
        kids.push(para(f.caption, { size: rc.fontSize - 1, align: 'center', color: '404040', fill: f.fill }));
      });
      sections.push({ properties: props(true), ...hf(), children: kids });
    } else cur.push(c);
  }
  closeLand();
  close();
  return sections;
}

// ── 문서 생성 ───────────────────────────────────────────
export async function renderDoc(ctx, model, code, sub) {
  if (!D) D = await dep('docx');
  const schema = ctx.schemas.byCode[code];
  const landscape = schema.orientation === 'landscape';
  const W = (landscape ? PAGE.h : PAGE.w) - PAGE.margin * 2;
  const subObj = subsystemById(ctx.cfg, sub) || { id: sub, name: sub };
  const rc = {
    ctx, model, schema, schemas: ctx.schemas, sub, W, landscape,
    data: model.get(sub, code),
    fontSize: landscape ? 16 : 17,
    markers: { missing: '(정보 부족)', tbd: '(미정)', none: '해당 없음', trace_empty: '-', ...(ctx.cfg.markers || {}) },
    ctxVars: { sub: subObj, system: { name: ctx.cfg.project?.system_name } },
    silentFields: collectSilentFields(schema),
    inputIndex: await loadInputIndex(ctx.p),
    stats: {},
    aiUsed: false,
    pendingFigures: [], // 세로 쪽에서 너무 작아지는 그림 → 바로 뒤 가로 쪽으로
  };
  // D9: 서브시스템 문서에 공용 데이터베이스 정의를 합쳐 보여준다
  const body = [];
  for (const block of schema.layout || []) {
    if (block.section) body.push(heading(block.section.replace(/^(\S+)\s.*/, '$1'), block.section.replace(/^\S+\s/, ''), 1));
    else if (block.subsection) body.push(heading(block.subsection.replace(/^(\S+)\s.*/, '$1'), block.subsection.replace(/^\S+\s/, ''), 2));
    else if (block.note) body.push(para(block.note, { size: rc.fontSize - 1, after: 100 }));
    else if (block.table) body.push(...listTable(block.table, rc));
    else if (block.cards) body.push(...cards(block.cards, rc));
    else if (block.diagram) body.push(...standaloneDiagram(block.diagram, rc));
    else if (block.textblock) body.push(...textBlock(block.textblock, rc));
    else if (block.narrative) body.push(...narrative(rc));
    if (rc.pendingFigures.length) body.push({ figures: rc.pendingFigures.splice(0) });
  }
  const docId = documentId(ctx.cfg, sub, schema.doc);
  const children = [
    para('▣ 제·개정 이력', { bold: true, size: 20, after: 80 }),
    await historyTable(rc),
    para('', { after: 200 }),
    headerTable(rc),
  ];
  if (rc.aiUsed) {
    children.push(para(ctx.cfg.ai_proposal?.legend || '※ 노란 음영: AI 제안 항목(검토 전)', { size: rc.fontSize - 1, before: 80, fill: ctx.cfg.ai_proposal?.color || 'FFF2B3' }));
  }
  children.push(para('', { after: 160 }), ...body);

  const doc = new D.Document({
    creator: ctx.cfg.document?.author || 'sw-deliverables',
    title: `${schema.name} - ${subObj.name}`,
    description: `${docId} (${ctx.cfg.project?.system_name || ''})`,
    styles: {
      default: {
        document: { run: { font: { ascii: 'Malgun Gothic', eastAsia: ctx.cfg.document?.font || '맑은 고딕', hAnsi: 'Malgun Gothic', cs: 'Malgun Gothic' }, size: 20 } },
      },
    },
    sections: toSections(children, landscape, docId, schema, rc),
  });
  const file = outputFile(ctx, sub, schema);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = await D.Packer.toBuffer(doc);
  try {
    fs.writeFileSync(file, buf);
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error(`파일이 열려 있어 저장할 수 없습니다(Word에서 닫아 주세요): ${file}`);
    throw e;
  }
  return { file, stats: rc.stats, docId };
}

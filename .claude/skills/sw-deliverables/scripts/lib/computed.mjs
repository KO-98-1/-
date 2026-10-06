// 계산 소스($...): 다른 산출물의 ID 연결로부터 기계적으로 도출되는 표 데이터
import { lookup } from './model.mjs';

function byType(model, type) {
  const out = [];
  for (const [id, info] of model.index) if (info.type === type) out.push({ id, ...info });
  return out;
}

function subOrder(cfg) {
  const order = new Map(cfg.subsystems.map((s, i) => [s.id, i]));
  return (a, b) => (order.get(a.sub) ?? 99) - (order.get(b.sub) ?? 99) || String(a.id).localeCompare(String(b.id));
}

const inter = (a = [], b = []) => a.some((x) => b.includes(x));

// R3 요구사항 추적표 행
export function traceRows(ctx, model) {
  const reqs = byType(model, 'REQ').sort(subOrder(ctx.cfg));
  const ucs = byType(model, 'UC');
  const screens = byType(model, 'SCR');
  const comps = byType(model, 'CMP');
  const classes = byType(model, 'CL');
  const ents = byType(model, 'ENT');
  const tables = byType(model, 'TB');
  const pgms = byType(model, 'PGM');
  const uts = byType(model, 'UT');
  const its = byType(model, 'IT');
  const sts = byType(model, 'ST');
  const rows = [];
  for (const r of reqs) {
    const req = r.entity;
    const stIds = sts.filter((s) => s.parent?.requirement_id === req.id).map((s) => s.id);
    const myUcs = ucs.filter((u) => (u.entity.requirement_ids || []).includes(req.id)).sort((a, b) => a.id.localeCompare(b.id));
    const base = { req_id: req.id, req_name: req.name, sub: r.sub, _req: req };
    if (myUcs.length === 0) {
      rows.push({ ...base, uc_id: null, uc_name: null, screen_ids: [], component_ids: [], table_ids: [], program_ids: [], unit_test_ids: [], integration_ids: [], system_test_ids: stIds });
      continue;
    }
    for (const u of myUcs) {
      const scr = screens.filter((s) => s.entity.usecase_id === u.id).map((s) => s.id);
      const cmp = comps.filter((c) => (c.entity.usecase_ids || []).includes(u.id)).map((c) => c.id);
      const clsIds = classes.filter((c) => (c.entity.usecase_ids || []).includes(u.id)).map((c) => c.id);
      const entIds = ents.filter((e) => clsIds.includes(e.entity.class_id)).map((e) => e.id);
      const tb = tables.filter((t) => entIds.includes(t.entity.entity_id) || (t.entity.usecase_ids || []).includes(u.id)).map((t) => t.id);
      const pg = pgms.filter((p) => inter(p.entity.component_ids, cmp) || inter(p.entity.screen_ids, scr) || (p.entity.usecase_ids || []).includes(u.id)).map((p) => p.id);
      const ut = uts.filter((t) => cmp.includes(t.entity.component_id)).map((t) => t.id);
      const it = its.filter((t) => t.entity.usecase_id === u.id).map((t) => t.id);
      rows.push({ ...base, uc_id: u.id, uc_name: u.entity.name, screen_ids: scr, component_ids: cmp, table_ids: [...new Set(tb)], program_ids: pg, unit_test_ids: ut, integration_ids: it, system_test_ids: stIds });
    }
  }
  return rows;
}

export function databasesUsed(ctx, model, sub) {
  const tables = model.get(sub, 'D9').tables || [];
  const ids = [...new Set(tables.map((t) => t.database_id).filter(Boolean))];
  return ids.map((id) => lookup(model, id)?.entity || { id, _meta: { origin: 'derived' } });
}

export function dbTables(model, sub, dbId) {
  const tables = model.get(sub, 'D9').tables || [];
  return tables.filter((t) => t.database_id === dbId).map((t) => ({
    tablespace: t.tablespace,
    ts_size: t.ts_size,
    id: t.id,
    name: t.name,
    index_ids: (t.indexes || []).map((i) => i.id).filter(Boolean),
    index_sizes: (t.indexes || []).map((i) => i.size).filter(Boolean),
    note: t.note,
    _meta: t._meta,
  }));
}

// I3 스크립트: 서브시스템 × 데이터베이스 단위
export function ddlScripts(ctx, model, sub) {
  const tables = model.get(sub, 'D9').tables || [];
  const overrides = model.get(sub, 'I3').scripts || [];
  const dbIds = [...new Set(tables.map((t) => t.database_id || 'NODB'))];
  const dialect = ctx.cfg.database?.dbms || 'postgresql';
  return dbIds.map((dbId, i) => {
    const ov = overrides.find((o) => o.database_id === dbId) || {};
    const n = String(i + 1).padStart(3, '0');
    const id = ov.id || (ctx.cfg.ids?.element?.DDL || 'DDL-{sub}-{n:3}').replace('{sub}', sub).replace(/\{n(:\d+)?\}/, n);
    const db = lookup(model, dbId)?.entity || { id: dbId };
    return {
      id,
      name: ov.name || `${id}_${sub}_${dbId}_${dialect}.sql`,
      database: db,
      tables: tables.filter((t) => (t.database_id || 'NODB') === dbId),
      install_location: ov.install_location,
      _meta: ov._meta || { origin: 'derived' },
      tbd: ov._meta?.tbd,
    };
  });
}

export function ddlRows(ctx, model, sub) {
  const subName = ctx.cfg.subsystems.find((s) => s.id === sub)?.name || sub;
  const rows = [];
  for (const s of ddlScripts(ctx, model, sub)) {
    for (const t of s.tables) {
      rows.push({
        sub_name: subName,
        script_id: s.id,
        script_name: s.name,
        db_id: s.database.id,
        db_name: s.database.name,
        table_id: t.id,
        table_name: t.name,
        index_ids: (t.indexes || []).map((x) => x.id),
        index_names: (t.indexes || []).map((x) => `${x.unique === 'Y' ? 'UNIQUE ' : ''}(${(x.columns || []).join(', ')})`),
        trigger: t.trigger,
        install_location: s.install_location,
        _meta: { origin: 'derived', ...(s._meta?.tbd ? { tbd: s._meta.tbd } : {}) },
      });
    }
  }
  return rows;
}

// ── DDL 생성 ──────────────────────────────────────────────
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function defaultSql(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s) || /^[A-Z_]+(\(\))?$/.test(s) || /^'.*'$/.test(s)) return s;
  return q(s);
}

export function ddlText(ctx, script) {
  const dialect = ctx.cfg.database?.dbms || 'postgresql';
  const L = [];
  const miss = ctx.cfg.markers?.missing || '(정보 부족)';
  L.push(`-- ${script.id} ${script.name}`);
  L.push(`-- 데이터베이스: ${script.database.id} ${script.database.name || ''} / DBMS: ${dialect}`);
  L.push('-- 자동 생성: 데이터베이스 설계서(D9) 기준. 타입 정보가 없는 컬럼은 주석 처리됨.');
  // 다른 스크립트(서브시스템)의 테이블을 FK로 참조하면 그 스크립트를 먼저 실행해야 한다
  const own = new Set(script.tables.map((t) => t.id));
  const external = [...new Set(script.tables.flatMap((t) => (t.columns || []).map((c) => String(c.fk_ref || '').split('.')[0]).filter((x) => x && !own.has(x))))];
  if (external.length) {
    const owners = external.map((tb) => { const m = tb.match(/^TB_([A-Z0-9]+)_/); return m ? `${tb}(DDL-${m[1]}-…)` : tb; });
    L.push(`-- 선행 실행 필요: ${owners.join(', ')} — 해당 서브시스템 스크립트를 먼저 실행한 뒤 이 스크립트의 FK를 추가한다.`);
  }
  L.push('');
  const fks = [];
  for (const t of script.tables) {
    const cols = t.columns || [];
    L.push(`-- ${t.name || ''} (${t.id})`);
    L.push(`CREATE TABLE ${t.id} (`);
    const defs = [];
    const typed = new Set(cols.filter((c) => c.column_id && c.type_length).map((c) => c.column_id));
    const pkAll = cols.filter((c) => c.pk === 'Y').map((c) => c.column_id).filter(Boolean);
    const pk = pkAll.every((c) => typed.has(c)) ? pkAll : [];
    for (const c of cols) {
      if (!c.column_id) continue;
      if (!c.type_length) { defs.push(`  -- ${c.column_id} /* ${miss}: 타입 및 길이 */`); continue; }
      let d = `  ${c.column_id} ${c.type_length}`;
      const dv = defaultSql(c.default);
      if (dv) d += ` DEFAULT ${dv}`;
      if (c.not_null === 'Y' || c.pk === 'Y') d += ' NOT NULL';
      if (dialect === 'mysql' && c.name) d += ` COMMENT ${q(c.name)}`;
      defs.push(d);
      if (c.fk_ref && /^[A-Z0-9_]+\.[A-Z0-9_]+$/i.test(c.fk_ref) && !/\.tbd$/i.test(c.fk_ref)) fks.push({ table: t.id, col: c.column_id, ref: c.fk_ref });
    }
    if (pkAll.length && !pk.length) defs.push(`  -- PRIMARY KEY (${pkAll.join(', ')}) /* ${miss}: 키 컬럼 타입 */`);
    if (pk.length) {
      const pkName = (t.indexes || []).find((i) => /^PK_/i.test(i.id || ''))?.id || `PK_${t.id.replace(/^TB_/, '')}`;
      defs.push(`  CONSTRAINT ${pkName} PRIMARY KEY (${pk.join(', ')})`);
    }
    // 주석 처리된 줄 뒤에 콤마가 붙지 않도록 실제 정의만 콤마로 연결
    const real = defs.map((d, i) => ({ d, i })).filter((x) => !x.d.trim().startsWith('--'));
    const lastReal = real.length ? real[real.length - 1].i : -1;
    defs.forEach((d, i) => L.push(d.trim().startsWith('--') || i === lastReal ? d : `${d},`));
    L.push(dialect === 'mysql' && t.name ? `) COMMENT=${q(t.name)};` : ');');
    if (dialect === 'postgresql' || dialect === 'oracle') {
      if (t.name) L.push(`COMMENT ON TABLE ${t.id} IS ${q(t.name)};`);
      for (const c of cols) if (c.column_id && c.type_length && c.name) L.push(`COMMENT ON COLUMN ${t.id}.${c.column_id} IS ${q(c.name)};`);
    } else if (dialect === 'mssql') {
      if (t.name) L.push(`EXEC sp_addextendedproperty 'MS_Description', ${q(t.name)}, 'SCHEMA', 'dbo', 'TABLE', '${t.id}';`);
    }
    for (const ix of t.indexes || []) {
      if (!ix.id || /^PK_/i.test(ix.id) || !(ix.columns || []).length) continue;
      if (!ix.columns.every((c) => typed.has(c))) { L.push(`-- 인덱스 ${ix.id} (${ix.columns.join(', ')}) /* ${miss}: 컬럼 정의 */`); continue; }
      L.push(`CREATE ${ix.unique === 'Y' ? 'UNIQUE ' : ''}INDEX ${ix.id} ON ${t.id} (${ix.columns.join(', ')});`);
    }
    if (t.trigger && !/^없음$/.test(String(t.trigger).trim())) L.push(`-- 트리거: ${String(t.trigger).replace(/\n/g, ' ')}`);
    L.push('');
  }
  fks.forEach((f, i) => {
    const [rt, rc] = f.ref.split('.');
    L.push(`ALTER TABLE ${f.table} ADD CONSTRAINT FK_${f.table.replace(/^TB_/, '')}_${String(i + 1).padStart(2, '0')} FOREIGN KEY (${f.col}) REFERENCES ${rt} (${rc});`);
  });
  return L.join('\n') + '\n';
}

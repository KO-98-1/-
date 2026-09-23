// ID 규칙: sw-config.yaml ids.element 템플릿 → 정규식·다음 번호
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function catCodes(schemas) {
  return [...new Set((schemas.common.requirement_categories || []).map((c) => c.code))];
}

export function idRegex(cfg, schemas, type) {
  const tpl = cfg.ids?.element?.[type];
  if (!tpl) return null;
  let re = '';
  let i = 0;
  const tokenRe = /\{(\w+)(?::(\d+))?\}/g;
  let m;
  while ((m = tokenRe.exec(tpl))) {
    re += esc(tpl.slice(i, m.index));
    const [, name, width] = m;
    if (name === 'sub') re += '(?<sub>[A-Z][A-Z0-9]{1,4})';
    else if (name === 'n') re += `(?<n>\\d{${width || 1},})`;
    else if (name === 'cat') re += `(?<cat>${catCodes(schemas).join('|')})`;
    else if (name === 'name') re += '(?<name>[A-Z0-9][A-Z0-9_]*)';
    else if (name === 'parent') re += '(?<parent>.+)';
    else if (name === 'project') re += esc(cfg.project?.id || 'PRJ');
    else re += '(.+)';
    i = m.index + m[0].length;
  }
  re += esc(tpl.slice(i));
  return new RegExp(`^${re}$`);
}

export function parseId(cfg, schemas, type, id) {
  const re = idRegex(cfg, schemas, type);
  if (!re) return { ok: true, groups: {} };
  const m = re.exec(String(id));
  return m ? { ok: true, groups: m.groups || {} } : { ok: false, groups: {} };
}

export function formatId(cfg, type, vars) {
  const tpl = cfg.ids?.element?.[type];
  if (!tpl) return null;
  return tpl.replace(/\{(\w+)(?::(\d+))?\}/g, (_, name, width) => {
    if (name === 'project') return cfg.project?.id || 'PRJ';
    const v = vars[name];
    if (v === undefined || v === null) return `{${name}}`;
    return width ? String(v).padStart(Number(width), '0') : String(v);
  });
}

// 이미 쓰인 ID를 보고 다음 ID 계산
export function nextIds(cfg, schemas, index, type, { sub, cat, parent, count = 1 } = {}) {
  const re = idRegex(cfg, schemas, type);
  let max = 0;
  for (const id of index.keys()) {
    const m = re && re.exec(id);
    if (!m || !m.groups) continue;
    if (sub && m.groups.sub && m.groups.sub !== sub) continue;
    if (cat && m.groups.cat && m.groups.cat !== cat) continue;
    if (parent && m.groups.parent && m.groups.parent !== parent) continue;
    const n = Number(m.groups.n || 0);
    if (n > max) max = n;
  }
  const out = [];
  for (let k = 1; k <= count; k++) out.push(formatId(cfg, type, { sub, cat, parent, n: max + k }));
  return out;
}

export function documentId(cfg, sub, docCode) {
  const tpl = cfg.ids?.document || '{project}_{sub}_{doc}_{seq}';
  return tpl
    .replace('{project}', cfg.project?.id || 'PRJ')
    .replace('{sub}', sub === 'SYSTEM' ? 'ALL' : sub)
    .replace('{doc}', docCode)
    .replace('{seq}', cfg.ids?.document_seq || '010');
}

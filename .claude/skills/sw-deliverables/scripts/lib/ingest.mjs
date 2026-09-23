// 입력 정규화: input/ 의 회의록·아이디어·수정사항·참고문서 → .work/inputs/<ID>.txt (줄 번호로 출처 인용)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dep, depDefault, requireDep } from './deps.mjs';
import { readYaml, writeYaml } from './project.mjs';

const KINDS = [
  { prefix: 'MTG', name: '회의록', folders: ['회의록', 'minutes', 'meeting', 'meetings'], words: ['회의록', '회의', 'minutes', 'meeting', '착수', '협의'] },
  { prefix: 'CR', name: '수정사항', folders: ['수정사항', '변경요청', 'changes', 'change'], words: ['수정', '변경', '개선요청', 'change', '보완'] },
  { prefix: 'REF', name: '참고문서', folders: ['참고문서', '참고', 'rfp', 'reference', 'refs'], words: ['rfp', '제안요청', '과업', '제안서', '지시서', '계획서', '규정', '지침'] },
  { prefix: 'IDEA', name: '아이디어', folders: ['아이디어', 'ideas', 'idea', '메모'], words: ['아이디어', 'idea', '메모', 'memo', '구상'] },
];
const SUPPORTED = ['.txt', '.md', '.markdown', '.docx', '.hwp', '.hwpx', '.pdf', '.csv'];
export const GUIDE_FILE = '여기에_자료를_넣으세요.txt';

function kindOf(rel) {
  const parts = rel.split(/[\\/]/).map((x) => x.toLowerCase());
  for (const k of KINDS) if (parts.slice(0, -1).some((p) => k.folders.includes(p))) return k;
  const base = parts[parts.length - 1];
  for (const k of KINDS) if (k.words.some((w) => base.includes(w.toLowerCase()))) return k;
  return KINDS.find((k) => k.prefix === 'IDEA');
}

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('euc-kr').decode(buf); } catch { return utf8; }
}

function htmlToText(html) {
  // 표 셀 안의 문단은 ' / '로 이어 붙여 표 한 행이 한 줄이 되게 한다(줄 번호 인용 안정화)
  let s = html.replace(/<t([dh])(?:\s[^>]*)?>([\s\S]*?)<\/t\1>/gi, (_, t, inner) => {
    const txt = inner.replace(/<\/p>\s*<p[^>]*>/gi, ' / ').replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return `${txt} | `;
  });
  s = s
    .replace(/<\/(p|h[1-6]|li|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '#'.repeat(Number(n)) + ' ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<t[dh][^>]*>/gi, '')
    .replace(/<tr[^>]*>/gi, '| ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return s;
}

async function fromDocx(file) {
  const mammoth = await depDefault('mammoth');
  const { value } = await mammoth.convertToHtml({ path: file });
  return htmlToText(value);
}

async function fromHwpx(file) {
  const JSZip = await depDefault('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /Contents\/section\d+\.xml$/i.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
  let out = '';
  for (const n of names) {
    const xml = await zip.file(n).async('string');
    out += xml
      .replace(/<hp:lineBreak\/>/g, '\n')
      .replace(/<hp:tab[^>]*\/>/g, '\t')
      .replace(/<\/hp:p>/g, '\n')
      .replace(/<\/hp:tc>/g, ' | ')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  return out;
}

// HWP 5.x 바이너리: OLE(CFB) → BodyText/SectionN (raw deflate) → HWPTAG_PARA_TEXT(67)
function fromHwp(file) {
  const CFB = requireDep('cfb');
  const cfb = CFB.read(fs.readFileSync(file), { type: 'buffer' });
  const header = CFB.find(cfb, 'FileHeader');
  if (!header) throw new Error('HWP FileHeader가 없습니다(HWP 5.x 형식이 아님)');
  const hb = Buffer.from(header.content);
  const flags = hb.readUInt32LE(36);
  const compressed = (flags & 1) === 1;
  if (flags & 2) throw new Error('암호가 설정된 HWP 문서입니다. 암호를 해제하거나 txt/docx로 저장해 주세요.');
  if (flags & 4) throw new Error('배포용 HWP 문서는 읽을 수 없습니다. 원본을 txt/docx로 저장해 주세요.');
  const sections = cfb.FileIndex
    .map((e, i) => ({ e, p: cfb.FullPaths[i] }))
    .filter(({ p }) => /BodyText\/Section\d+$/i.test(p))
    .sort((a, b) => Number(a.p.match(/(\d+)$/)[1]) - Number(b.p.match(/(\d+)$/)[1]));
  let out = '';
  for (const { e } of sections) {
    let data = Buffer.from(e.content);
    if (compressed) data = zlib.inflateRawSync(data);
    let off = 0;
    while (off + 4 <= data.length) {
      const h = data.readUInt32LE(off);
      off += 4;
      const tag = h & 0x3ff;
      let size = (h >>> 20) & 0xfff;
      if (size === 0xfff) { size = data.readUInt32LE(off); off += 4; }
      if (tag === 67) {
        const rec = data.subarray(off, off + size);
        let line = '';
        for (let i = 0; i + 1 < rec.length;) {
          const c = rec.readUInt16LE(i);
          if (c < 32) {
            if (c === 10) line += '\n';
            else if (c === 9) line += '\t';
            if ([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31].includes(c)) i += 2; else i += 16;
          } else {
            line += String.fromCharCode(c);
            i += 2;
          }
        }
        out += line + '\n';
      }
      off += size;
    }
  }
  return out;
}

// pdftotext 위치: PATH → winget(Poppler) 설치 폴더
export function findPdftotext() {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return 'pdftotext'; } catch { /* PATH에 없음 */ }
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : null;
  if (!base || !fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base).filter((x) => /poppler/i.test(x))) {
    const stack = [path.join(base, d)];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.toLowerCase() === 'pdftotext.exe') return full;
      }
    }
  }
  return null;
}

function fromPdf(file) {
  const exe = findPdftotext();
  try {
    if (!exe) throw new Error('none');
    return execFileSync(exe, ['-enc', 'UTF-8', file, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch {
    const err = new Error('pdftotext(Poppler)가 없어 PDF를 자동 변환하지 못했습니다. AI가 PDF를 직접 읽어 텍스트 파일로 저장해야 합니다.');
    err.manual = true;
    throw err;
  }
}

export function maskPii(text) {
  return text
    .replace(/\b\d{6}[- ]?[1-4]\d{6}\b/g, '[주민번호]')
    .replace(/\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g, '[카드번호]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[이메일]')
    .replace(/\b0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}\b/g, '[전화번호]');
}

function guessDate(name, text) {
  const hay = `${name}\n${text.split('\n').slice(0, 40).join('\n')}`;
  let m = hay.match(/(20\d{2})[-./년 ]\s*(\d{1,2})[-./월 ]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = hay.match(/\b(\d{2})(\d{2})(\d{2})\b/);
  if (m && Number(m[2]) <= 12 && Number(m[3]) <= 31) return `20${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function guessTitle(file, text) {
  for (const raw of text.split('\n').slice(0, 15)) {
    if (/^\s*<!--/.test(raw)) continue;
    const line = raw.replace(/^#+\s*/, '').replace(/\|/g, ' ').trim();
    if (line.length >= 4 && line.length <= 80 && !/^[-=_*]+$/.test(line)) return line;
  }
  return path.basename(file, path.extname(file));
}

function walk(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('~$') || e.name === GUIDE_FILE) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

export async function ingest(ctx, { force = false } = {}) {
  const { p, cfg } = ctx;
  fs.mkdirSync(p.inputs, { recursive: true });
  const index = (await readYaml(p.inputIndex, { inputs: [] })) || { inputs: [] };
  const byOriginal = new Map(index.inputs.map((x) => [x.original, x]));
  const counters = {};
  for (const x of index.inputs) {
    const [pre, n] = x.id.split('-');
    counters[pre] = Math.max(counters[pre] || 0, Number(n) || 0);
  }
  const results = [];
  for (const rel of walk(p.input).sort()) {
    const ext = path.extname(rel).toLowerCase();
    const full = path.join(p.input, rel);
    const original = path.join('input', rel).replace(/\\/g, '/');
    if (!SUPPORTED.includes(ext)) {
      results.push({ original, status: 'skipped', message: `지원하지 않는 형식(${ext}). txt/md/docx/hwp/hwpx/pdf로 저장해 주세요.` });
      continue;
    }
    const sha1 = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
    const prev = byOriginal.get(original);
    if (prev && prev.sha1 === sha1 && prev.status === 'ok' && !force) {
      results.push({ ...prev, status: 'unchanged' });
      continue;
    }
    const kind = kindOf(rel);
    let id = prev?.id;
    if (!id) {
      counters[kind.prefix] = (counters[kind.prefix] || 0) + 1;
      id = `${kind.prefix}-${String(counters[kind.prefix]).padStart(3, '0')}`;
    }
    const entry = { id, kind: kind.name, original, text: `.work/inputs/${id}.txt`, sha1, ingested_at: new Date().toISOString() };
    try {
      let text;
      if (['.txt', '.md', '.markdown', '.csv'].includes(ext)) text = decodeText(fs.readFileSync(full));
      else if (ext === '.docx') text = await fromDocx(full);
      else if (ext === '.hwpx') text = await fromHwpx(full);
      else if (ext === '.hwp') text = fromHwp(full);
      else if (ext === '.pdf') text = fromPdf(full);
      text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
      if (cfg.security?.mask_pii !== false) text = maskPii(text);
      fs.writeFileSync(path.join(p.inputs, `${id}.txt`), text, 'utf8');
      entry.title = guessTitle(full, text);
      entry.date = guessDate(path.basename(full), text);
      entry.lines = text.split('\n').length - 1;
      entry.status = 'ok';
    } catch (e) {
      entry.status = e.manual ? 'needs_manual' : 'error';
      entry.message = e.message;
      entry.title = path.basename(full);
    }
    byOriginal.set(original, entry);
    results.push({ ...entry, status: entry.status === 'ok' ? (prev ? 'updated' : 'new') : entry.status });
  }
  index.inputs = [...byOriginal.values()].sort((a, b) => a.id.localeCompare(b.id));
  await writeYaml(p.inputIndex, index);
  return { index, results };
}

export async function loadInputIndex(p) {
  const idx = (await readYaml(p.inputIndex, { inputs: [] })) || { inputs: [] };
  return new Map(idx.inputs.map((x) => [x.id, x]));
}

// 'MTG-001:12-18' → {id, from, to}
export function parseSource(s) {
  const m = String(s).trim().match(/^([A-Z]+-\d+)(?::(\d+)(?:-(\d+))?)?$/);
  if (!m) return null;
  return { id: m[1], from: m[2] ? Number(m[2]) : null, to: m[3] ? Number(m[3]) : (m[2] ? Number(m[2]) : null) };
}

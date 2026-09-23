// 검수용 미리보기: DOCX → PDF(Word 또는 LibreOffice) → PNG(pdftoppm)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function has(cmd, argsV = ['-v']) {
  try { execFileSync(cmd, argsV, { stdio: 'ignore' }); return true; } catch { return false; }
}

export async function preview(file, outDir) {
  if (!file || !fs.existsSync(file)) throw new Error(`파일이 없습니다: ${file}`);
  const abs = path.resolve(file);
  const out = path.resolve(outDir || path.join(path.dirname(abs), '_preview'));
  fs.mkdirSync(out, { recursive: true });
  const pdf = path.join(out, path.basename(abs).replace(/\.docx$/i, '.pdf'));
  const logs = [];
  if (process.platform === 'win32') {
    // 자동화로 띄운 Word(/Automation)만 정리한다 — 사용자가 연 Word 창은 건드리지 않는다.
    const ps = `$ErrorActionPreference='Stop'; $t0 = Get-Date
$w = $null
try {
  $w = New-Object -ComObject Word.Application; $w.Visible=$false; $w.DisplayAlerts=0
  $d = $w.Documents.Open('${abs.replace(/'/g, "''")}', $false, $true)
  $d.ExportAsFixedFormat('${pdf.replace(/'/g, "''")}', 17); $d.Close($false)
} finally {
  if ($w) { try { $w.Quit() } catch {} ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) }
  Start-Sleep -Milliseconds 300
  Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" | Where-Object { $_.CommandLine -match '/Automation' -and $_.CreationDate -ge $t0.AddSeconds(-2) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}`;
    for (let attempt = 1; attempt <= 2 && !fs.existsSync(pdf); attempt++) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', timeout: 180000 });
        logs.push(`PDF(Word): ${pdf}`);
      } catch (e) {
        logs.push(`Word 변환 실패(${attempt}회): ${String(e.stderr || e.message).split('\n').find((l) => l.trim()) || ''}`);
      }
    }
  }
  if (!fs.existsSync(pdf) && has('soffice', ['--version'])) {
    execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', out, abs], { stdio: 'ignore', timeout: 180000 });
    logs.push(`PDF(LibreOffice): ${pdf}`);
  }
  if (!fs.existsSync(pdf)) { logs.push('PDF로 변환할 도구(Word/LibreOffice)가 없습니다.'); return logs; }
  if (has('pdftoppm')) {
    const prefix = path.join(out, path.basename(pdf, '.pdf'));
    execFileSync('pdftoppm', ['-png', '-r', '70', pdf, prefix], { stdio: 'ignore' });
    const pngs = fs.readdirSync(out).filter((f) => f.startsWith(path.basename(prefix)) && f.endsWith('.png')).sort();
    logs.push(`PNG ${pngs.length}장: ${pngs.map((f) => path.join(out, f)).join(', ')}`);
  } else logs.push('pdftoppm이 없어 PNG 변환은 생략합니다.');
  return logs;
}

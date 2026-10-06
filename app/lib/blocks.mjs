// 모델 응답의 파일 블록 파싱
//   === FILE: <경로>\n<내용>\n=== END
//   === SKIP: <코드>\n<YAML: reason, needs, sources>\n=== END
export function parseBlocks(text) {
  const out = [];
  const re = /^===\s*(FILE|SKIP):\s*(.+?)\s*$([\s\S]*?)^===\s*END\s*$/gm;
  let m;
  while ((m = re.exec(String(text || '')))) {
    let body = m[3].replace(/^\r?\n/, '');
    // 모델이 블록 안에 ```yaml 울타리를 넣은 경우 벗긴다
    const fence = body.match(/^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/);
    if (fence) body = fence[1];
    out.push({ type: m[1], target: m[2].trim(), body: body.replace(/\s+$/, '') + '\n' });
  }
  return out;
}

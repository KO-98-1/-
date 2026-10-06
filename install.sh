#!/usr/bin/env sh
# SW 표준 산출물 자동 작성 킷 설치 (macOS·Linux)
#   프로젝트에 설치:  ./install.sh /path/to/my-project
#   사용자 전체 설치: ./install.sh --user
set -e
KIT="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = "--user" ]; then BASE="$HOME/.claude"; else BASE="${1:-$(pwd)}/.claude"; fi
SKILL_DST="$BASE/skills/sw-deliverables"
AGENT_DST="$BASE/agents"
mkdir -p "$SKILL_DST" "$AGENT_DST"
# node_modules 는 복사하지 않음(사용자 공유 런타임 사용)
(cd "$KIT/.claude/skills/sw-deliverables" && tar --exclude=node_modules -cf - .) | (cd "$SKILL_DST" && tar -xf -)
cp "$KIT/.claude/agents/sw-deliverable-writer.md" "$AGENT_DST/"
echo "스킬 설치: $SKILL_DST"
echo "서브에이전트 설치: $AGENT_DST/sw-deliverable-writer.md"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 이상이 필요합니다. https://nodejs.org 에서 설치 후 다시 실행하세요." >&2
  exit 1
fi
node "$SKILL_DST/scripts/swd.mjs" setup
echo ""
echo '설치 완료. Claude Code에서 프로젝트 폴더를 열고 "이 프로그램 기반으로 산출물 작성해줘"라고 요청하세요.'

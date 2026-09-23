# SW 표준 산출물 자동 작성 킷 설치
#   프로젝트에 설치:  powershell -ExecutionPolicy Bypass -File install.ps1 -Target "D:\my-project"
#   사용자 전체 설치: powershell -ExecutionPolicy Bypass -File install.ps1 -Scope User
param(
  [string]$Target = (Get-Location).Path,
  [ValidateSet('Project', 'User')][string]$Scope = 'Project'
)
$ErrorActionPreference = 'Stop'
$kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = if ($Scope -eq 'User') { Join-Path $env:USERPROFILE '.claude' } else { Join-Path $Target '.claude' }

$skillSrc = Join-Path $kit '.claude\skills\sw-deliverables'
$skillDst = Join-Path $base 'skills\sw-deliverables'
$agentSrc = Join-Path $kit '.claude\agents\sw-deliverable-writer.md'
$agentDst = Join-Path $base 'agents'

New-Item -ItemType Directory -Force $skillDst, $agentDst | Out-Null
# node_modules 는 복사하지 않음(사용자 공유 런타임 사용)
robocopy $skillSrc $skillDst /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
Copy-Item $agentSrc $agentDst -Force
Write-Host "스킬 설치: $skillDst"
Write-Host "서브에이전트 설치: $agentDst\sw-deliverable-writer.md"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning 'Node.js 18 이상이 필요합니다. https://nodejs.org 에서 설치 후 다시 실행하세요.'
  exit 1
}
node (Join-Path $skillDst 'scripts\swd.mjs') setup
Write-Host ''
Write-Host '설치 완료. Claude Code에서 프로젝트 폴더를 열고 "이 프로그램 기반으로 산출물 작성해줘"라고 요청하세요.'

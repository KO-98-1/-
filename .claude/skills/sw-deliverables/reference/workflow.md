# 명령·파일 참고서

`swd` = `node "<스킬 폴더>/scripts/swd.mjs"`. 산출물 폴더(`deliverables/`) 안에서 실행하거나 `--root`를 붙인다.

## 폴더 구조

```
deliverables/
├─ sw-config.yaml            시스템명·작성자·승인자·서브시스템·ID 규칙·표시 문구 (사용자 고정값)
├─ input/                    근거 자료 (원본, AI는 직접 읽지 않음)
│   ├─ 회의록/ 아이디어/ 수정사항/ 참고문서/
├─ model/                    단일 진실 원천(YAML) — 서브에이전트가 작성
│   ├─ <SUB>/<코드>.yaml      서브시스템 산출물 데이터 (R1, R2, D1 …)
│   ├─ SYSTEM/<코드>.yaml     시스템 공통 (GL, D5, D6, D9 databases, D12, T4, T5)
│   └─ history.yaml          제·개정 이력
├─ output/                   생성 산출물(DOCX) — 제출용
│   ├─ <SUB>_<이름>/<산출물ID>_<산출물명>.docx, DDL/*.sql
│   ├─ 00_시스템공통/
│   └─ _검토/검토리포트_<단계>_<날짜>.md
└─ .work/                    작업 파일
    ├─ inputs/<ID>.txt, index.yaml   정규화 입력(줄 번호 인용, 개인정보 마스킹)
    ├─ allocation.yaml               마스터의 서브시스템 배분표
    ├─ prompts/<단계>_<SUB>.md        서브에이전트 작성 지시서
    ├─ diagrams/<SUB>/<종류>/*.mmd|png 다이어그램 원본·이미지
    └─ reports/review.json
```

## 명령

| 명령 | 설명 |
|---|---|
| `setup` / `doctor` | 런타임 설치(최초 1회) / 환경 점검 |
| `init [폴더] --system <이름> --project <ID>` | 산출물 폴더 생성 |
| `ingest [--force]` | 입력 정규화. 입력ID: 회의록 MTG-, 아이디어 IDEA-, 수정사항 CR-, 참고문서 REF- |
| `prompt --stage <단계> --all \| --sub <ID> [--docs ..]` | 작성 지시서 생성 |
| `next-id --type UC --sub SA [--cat SFR] [--count 3]` | 다음 ID 계산 |
| `validate [--sub] [--docs] [--json]` | 검증(오류 있으면 종료코드 1) |
| `derive --stage implementation\|test` | 결과서 뼈대 현행화(기존 결과 칸은 보존) |
| `scan-code --src <폴더> --sub <ID>` | 소스 → I1 프로그램 목록 초안 |
| `diagrams [--force]` | 다이어그램 생성(변경분만) |
| `render [--sub] [--docs 코드\|단계]` | DOCX 생성 |
| `build --stage <단계>` | validate → diagrams → render → report |
| `report --stage <단계>` | 검토 리포트만 |
| `confirm --stage <단계> [--except A,B] [--ids A,B]` | AI 제안 확인(음영 해제) |
| `history add --stage <단계> \| --docs SA:R1,.. --content "…"` | 제·개정 이력 추가(버전 칸은 비움) |
| `status` | 현황 |
| `preview --file <docx>` | Word/LibreOffice로 PDF·PNG 미리보기 |

## 모델 YAML 공통 형식

```yaml
requirements:
  - id: SFR-SA-001
    name: 상품 주문
    category: 기능 요구사항
    description: 회원은 장바구니의 상품을 주문한다.
    priority: 상
    _meta:
      origin: fact                 # fact | ai | derived
      sources: [MTG-001:12-18]     # 입력ID:줄범위
      ai_fields: [priority]        # fact 항목 중 AI가 추정한 필드
      tbd: {solution: "결제 방식은 다음 회의에서 결정"}   # 미정
      confirmed: false             # swd confirm 이 true로 바꿈
```

서술형 산출물(D6·D12·T3·T4·T5)은 `sections: {"<목차번호>": {text, table: {columns, rows}, mermaid, _meta}}`.

## 검증이 잡는 것

ID 형식·중복, 참조 대상 존재·유형, 필수 항목, 허용값(상/중/하, 주요/보조/숨은, I/O/RO/E/H 등), `_meta` 출처 형식과
입력 줄 범위, 요구사항 분류코드↔구분 일치, 설계단계 산출물의 시험결과 기재 금지, 하위 ID 접두어,
추적성 누락(기능 요구사항→유스케이스, 유스케이스→시퀀스도·화면·컴포넌트·통합시험, 비기능→시스템시험, 컴포넌트→단위시험, 엔티티→테이블).

# Goal Agent Architecture (Phase 9)

## 목적

Goal Agent는 모델이 제안한 task를 실행하는 기존 minitok pipeline 위에 명시적 목표, 결정적 검증, evidence, persistence, recovery를 추가한다. 모델의 `done`, `completed`, `APPROVE`는 메타데이터일 뿐 최종 완료 신호가 아니다.

## 실행 경로

```text
legacy task / goal input
→ Goal compiler
→ validated GoalSpec
→ GoalController
→ task executor / existing pipeline
→ GoalEvaluator
→ evidence + ODD scope
→ session state / terminal result
```

`minitok_run(task)`는 기존 pipeline 호환 API로 유지된다. 장기 goal MCP surface는 별도의 `minitok_goal_*` 도구와 Goal Session을 사용한다.

## 핵심 구성요소

- `src/goal/spec.js`: schema, default constraints, execution modes
- `src/goal/validator.js`: unknown field, dangerous key, path, verifier, ODD validation
- `src/goal/compiler.js`: 명시 goal과 legacy task 변환
- `src/goal/controller.js`: cycle, limit, task proposal, recovery, escalation, terminal state
- `src/goal/evaluator.js`: command/file/test/custom verifier 실행 및 완료 판정
- `src/goal/evidence.js`: stable evidence id와 secret redaction
- `src/goal/odd.js`: repository evidence와 allowed/protected scope
- `src/goal/session.js`: atomic state, checkpoint, lock, pause/resume, migration
- `src/goal/application.js`: Phase 8 mock-first application adapters
- `src/goal/benchmark.js`: Phase 9 deterministic benchmark metrics

## 완료 정의

필수 criterion 모두가 `passed`이고, 각 criterion의 evidence id가 존재하며 `valid === true`이고, repository scope가 유효해야 completed다. 하나라도 `unknown`, 실행되지 않음, timeout, invalid evidence, protected path 변경이면 completed가 아니다.

## 안전 경계

기본 ODD는 `allow_external: false`다. verifier command는 allowlist와 shell metacharacter 검사를 통과해야 하며, 파일 경로는 workspace 내부여야 한다. autonomous mode는 MCP permission `auto_accept` 없이는 거부된다. 변경 범위를 벗어나거나 protected path를 수정하면 blocked다.

## 모델 교체

모델 이름이 아니라 capability contract(`structured_output`, `tool_calling`, `repository_navigation`, `code_editing`, `error_recovery`, `long_horizon`)로 역할 적합성을 평가한다. 반복 실패 시 recovery policy가 더 강한 capability 모델을 선택하고, 후보가 없으면 escalate한다.

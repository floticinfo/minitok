# Phase 0 — Automatic Goal-aware Nunchi Integration Boundary

- **Repository:** `C:\Users\J1\.cline\data\workspaces\chat\minitok-release-1.4.6`
- **Phase:** 0 — integration-path investigation and baseline
- **Status:** 조사 완료 / 구현 변경 없음
- **Date:** 2026-09-20

## 1. 결론

기존 GoalPlan, `expandGoal()`, inferred/optional step, blocker/recovery, execution policy, session 및 evidence 기능은 구현되어 있다. 현재 gap은 일반 CLI/MCP goal start가 다음 경로를 자동 연결하지 않는 것이다.

```text
CLI/MCP goal input → GoalSpec → expandGoal() → GoalPlan
→ GoalController({ goalExpansion }) → required inferred step
```

`GoalController`와 `defaultTaskProposer()`는 expansion-aware 분기를 이미 갖지만, 일반 CLI/MCP 진입점이 `goalExpansion`을 생성하거나 전달하지 않는다. 따라서 expansion-aware 동작은 명시적 내부 호출/테스트에 한정된다.

## 2. 현재 구현 조사

### Compiler와 expansion

`src/goal/compiler.js`의 `compileGoal()`은 deterministic command/file 목표만 바로 ready로 만들고, 성공 조건·verifier를 결정할 수 없는 일반 자연어는 `clarification_required`로 반환한다. `compileModelGoal()`도 `success_criteria`가 없으면 임의 기준을 만들지 않는다. `adaptTaskToGoalSpec()`은 legacy `minitok_run(task)` adapter다.

`src/goal/expansion.js`의 `expandGoal()`은 objective, success criteria, repository context/ODD, environment state, execution policy를 입력으로 받아 required inferred step과 optional follow-up을 만든다. inferred step은 criterion ID를 `target_criteria`로 연결하고 rationale/verifier/scope를 가진다. ODD 위반이나 verifier/environment 누락은 질문, `missing_information`, 낮은 confidence로 반영하며 `GoalPlan`을 validation한다. 기본 정책은 safe다.

### GoalController

`src/goal/controller.js`와 `extension/runtime/src/goal/controller.js`는 대응 구조가 동일하다. `defaultTaskProposer()`는 `options.goalExpansion` 또는 `options.expansion`이 있을 때 `required === true`, `status !== "deferred"`, 남은 criterion과 연결된 첫 inferred step을 제안한다. 없으면 기존 `Address criterion: ...` fallback을 사용한다.

`persistSession()`은 `options.goalExpansion.inferred_steps`와 assumptions가 있을 때 이를 state에 저장한다. 따라서 진입점에서 expansion을 전달하지 않으면 inferred step이 session state/evidence 경로에 저장되지 않는다.

### CLI 경로

`src/cli/commands/goal.js`의 start는 다음 순서다.

```text
cmdGoalStart
→ compileModelGoal/compileGoal
→ resolveExecutionPolicy(source: cli)
→ createGoalSession
→ runGoal(goalSpec, { session, policy fields })
```

`runGoal()` 인자에 `goalExpansion`/`expansion`이 없다. repo와 `minitok.yml`은 policy에 사용되지만 ODD를 expansion input으로 만드는 단계는 없다. `cmdGoalResume()`은 `cmdGoalContinue()` alias이며 continue도 policy resolve → `resumeGoalSession()` → expansion 없는 `runGoal()` 순서다.

### MCP 경로

`src/mcp/goal-tools.js`와 `extension/runtime/src/mcp/goal-tools.js`는 parity 상태다. `minitok_goal_start`는 다음 순서다.

```text
permission/mode check → requireGoalRepo → loadConfig
→ resolveExecutionPolicy(source: mcp) → compileInput
→ createGoalSession → saveGoalSession → launch
→ runGoal(session.goalSpec, { session, policy fields })
```

`compileInput()`은 `goal_spec`가 있으면 model draft, 아니면 일반 goal을 compile한다. `clarification_required`이면 session 없이 질문만 반환한다. ready goal에는 expansion을 만들거나 전달하지 않는다.

`minitok_goal_continue`와 `minitok_goal_resume`은 `continueGoal()`을 통해 policy resolve → `resumeGoalSession()` → expansion 없는 `launch/runGoal()`을 수행한다. 기존 expansion을 재사용하는 marker 검사도 없다.

`src/mcp/tools.js`는 schema/argument validation/response envelope/dispatch를 담당한다. 기존 response field는 유지되어야 하며 expansion 정보는 additive field여야 한다.

## 3. 확인 항목 요약

| 항목 | 결과 |
|---|---|
| `expandGoal()` 호출 | pipeline `next_task`와 controller 내부에는 있으나 CLI/MCP 일반 start에는 없음 |
| proposer context | controller는 전달 가능하지만 CLI/MCP가 생성하지 않음 |
| CLI start/continue/resume | start와 continue의 `runGoal()`에 expansion 없음; resume은 continue alias |
| MCP start/continue/resume | start/continue `launch()` 모두 session과 policy만 전달; source/runtime 동일 |
| GoalPlan/model draft | model draft의 criterion/verifier는 compiler가 검증; start boundary에서 GoalPlan 미생성 |
| 일반 자연어 | 기준/verifier 불명확 시 `clarification_required`; ready여도 자동 expansion 없음 |
| criteria 없음 | 임의 완료 기준을 만들지 않고 clarification; session 미생성 |
| ODD | expansion은 `repository_context.repository_odd`/`scope_boundary`를 소비; CLI/MCP 투영 없음 |
| unrestricted 시점 | CLI/MCP policy는 compile/session/launch 전에 resolve; controller도 재검증 |
| parity | source와 extension runtime의 controller/expansion/MCP goal-tools 구조가 대응 |


## 4. 다음 phase의 안전 경계

1. safe 기본값과 기존 `resolveExecutionPolicy()`/capability resolver를 유지한다.
2. GoalPlan, BlockerReport, AlternativePlan, recovery를 재구현하지 않고 재사용한다.
3. `minitok_run`, `runTask`, `runPipeline`, legacy `next_task` 동작은 변경하지 않는다.
4. expansion은 GoalPlan validation 후 controller에 전달하며 capability를 자동 grant하지 않는다.
5. inferred step은 원래 criterion과 연결하고 optional step은 required step과 분리한다.
6. success criterion/verifier가 없으면 expansion으로 보정하지 않고 clarification을 반환한다.
7. GoalSpec의 `constraints.repository_odd`와 같은 ODD를 사용하고 ODD 밖 후보는 추가하지 않는다.
8. unrestricted도 explicit confirmation, runtime permission, configured allowlist, path/protected-path/verifier-integrity/always-blocked 규칙을 우회하지 않는다.
9. 이미 expansion된 session/GoalPlan은 stable marker 또는 persisted state로 중복 expansion하지 않는다.
10. plan, step 선택/실행, blocker/alternative, verifier/evidence를 기존 redaction/audit/session 규칙으로 저장한다.
11. source와 extension runtime을 함께 변경하고 parity/typecheck로 검증한다.

권장 경계는 다음 공통 helper다.

```text
validated GoalSpec + repository context + policy decision
→ ensureGoalExpansion()
   → persisted expansion이면 재사용
   → 아니면 expandGoal() + GoalPlan/ODD/policy validation
   → clarification이면 side effect 없이 반환
→ runGoal(..., { goalExpansion, goalPlan, ...existing options })
```

이 helper를 CLI/MCP start 및 재개 경로에서 호출하면 기존 direct `runGoal()` 및 legacy API는 보존하면서 자동 연결을 구현할 수 있다.

## 5. Baseline

실행 디렉터리: `C:\Users\J1\.cline\data\workspaces\chat\minitok-release-1.4.6`

- `npm test`: PASS — 1477 tests, 1470 passed, 0 failed, 7 skipped
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm run typecheck:extension`: PASS
- `npm run docs:check`: PASS
- `npm run stage2:parity`: PASS — local contract/boundary checks; production evidence는 미검증

초기 foreground 실행의 30초 제한 초과 후 동일 `npm test`를 끝까지 실행했으며 최종 exit code는 0이다.

## 6. 변경 범위

Phase 0에서는 이 조사 보고서만 추가했다. `src/goal/*`, `src/cli/*`, `src/mcp/*`, `extension/runtime/src/*` 구현 파일과 기존 테스트는 수정하지 않았다.

예정 commit:

```text
docs: define automatic nunchi integration boundary
```

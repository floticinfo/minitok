# Phase 0 — General Autonomous Agent baseline

- **Repository:** `C:\Users\J1\.cline\data\workspaces\chat\minitok-release-1.4.6`
- **Phase:** 0 — 현재 구조 조사 및 baseline
- **Status:** PASS / 기능 구현 없음
- **Date:** 2026-09-20

## 1. 결론

현재 저장소는 Goal-aware Nunchi, GoalPlan, inferred/optional step, blocker/alternative/recovery, execution policy, persistent session/evidence, CLI/MCP goal surface를 이미 제공한다. 명시적인 `GoalSpec` 또는 success criteria/verifier가 있는 목표는 다음 경로로 자동 확장된다.

```text
CLI/MCP goal input
→ validated GoalSpec
→ prepareGoalExecution()
→ expandGoal()
→ validated GoalPlan
→ GoalController({ goalExpansion, goalPlan })
→ required inferred step 실행
→ evaluator/evidence/session
```

그러나 criteria/verifier가 없는 일반 자연어를 안전한 가정과 관찰 가능한 성공 기준으로 변환하는 General Autonomous Agent 계층은 아직 없다. 따라서 현재 일반 자연어의 보수적 결과는 `clarification_required`이며, deterministic compiler가 외부/production 목표를 식별하면 `unsupported`가 될 수 있다. 이 문서는 후속 phase의 구현 범위를 고정하는 기준선이다.

## 2. 현재 계약과 구현 조사

### 자연어 입력과 readiness

`src/goal/compiler.js`의 `compileGoal()`은 명령 실행, lint/typecheck, 파일 존재처럼 verifier를 결정할 수 있는 목표만 `ready` GoalSpec으로 컴파일한다. feature, bug fix, test, API, documentation, refactoring 등은 목표 종류별 질문을 포함한 `clarification_required`를 반환한다. 외부/production 환경을 요구하는 deploy/publish/release 일부는 `unsupported`로 반환한다.

`src/goal/integration.js`의 `compileInput()`은 다음 순서다.

1. `goal_spec`가 있으면 이를 사용한다.
2. `objective + success_criteria`가 있으면 model GoalSpec을 검증한다.
3. objective만 있으면 보수적 `compileGoal()`을 호출한다.
4. objective가 없으면 clarification한다.

따라서 현재 구현은 success criteria/verifier를 임의로 발명하지 않는다. General Agent에서 추가할 “누락된 성공 기준 추론”은 반드시 가설, confidence, 관찰 근거, 사용자 확인 필요 여부를 별도 additive 계약으로 저장해야 한다.

### GoalPlan과 expansion

`src/goal/plan.js`의 GoalPlan은 objective, explicit/inferred steps, dependencies, success criteria, scope boundary, risk, approvals, assumptions, execution policy/capabilities를 표현한다. unknown/dangerous key, path traversal, workspace escape, invalid verifier와 capability/scope 충돌을 validation한다.

`src/goal/expansion.js`의 `expandGoal()`은 현재 주로 다음 패턴을 확장한다.

- release/publish/package/version/tag: version → tests → package, optional external follow-up
- file/module/function/bug/feature/fix/refactor/documentation/test: repository-local change
- deploy/production은 별도 안전 경계와 질문을 적용

환경 상태와 ODD를 읽어 missing information, questions, assumptions, confidence, out-of-scope candidate를 만든다. 하지만 모든 자연어의 의도·범위·관련 작업을 일반적으로 추론하지 않으며, criteria가 없으면 GoalPlan을 만들지 않는다.

명시 criteria가 있는 자동 Nunchi 경로에서는 `prepareGoalExecution()`이 expansion을 생성하고 검증한 뒤 CLI/MCP session에 저장하며 controller에 전달한다. controller의 `defaultTaskProposer()`는 남은 criterion과 연결된 required inferred step을 선택하고, expansion이 없을 때는 기존 `Address criterion: ...` fallback을 유지한다.

### 실행, blocker, recovery, evidence

`src/goal/controller.js`는 cycle, task proposal, task executor, evaluator, blocker report, alternative selection, recovery, escalation 및 terminal result를 관리한다. `BlockerReport`와 alternative는 category/risk/side effect/permission/verification/approval 정보를 가지며, recovery는 replan, repair, reobserve, alternative strategy, approval escalation, scope reduction, model switch를 지원한다. 다만 일반 자연어용 의미 재해석·Plan DAG 재작성은 후속 General Agent 계층의 gap이다.

완료는 모델의 `done`, `completed`, `APPROVE`로 결정되지 않는다. `GoalEvaluator`의 required criteria별 valid/executed evidence가 있어야 하며, `session.js`의 `assertCompletionEvidence()`가 이를 강제한다. evidence와 audit는 secret/token/password/private key 등을 redaction하고, false completion을 허용하지 않는다.

### 정책과 안전 경계

현재 canonical execution policy는 `safe`, `supervised`, `authorized_external`, `unrestricted`, `always_blocked`다. legacy `workspace`, `autonomous`, `never_autonomous` alias가 존재한다. `unrestricted_general`은 아직 구현되어 있지 않다.

`src/goal/execution_policy.js`, `risk_execution.js`, `execution_audit.js`는 다음 경계를 유지한다.

- 기본 mode는 safe
- explicit confirmation/configured capability/runtime permission 없이는 unrestricted 거부
- path traversal/workspace boundary/dangerous object key 차단
- protected path/verifier tampering 차단
- always-blocked operation은 mode와 무관하게 차단
- injected adapter와 audit persistence가 없으면 실행하지 않음
- audit에는 안전한 상대 경로와 URL의 제한된 projection만 저장
- credential 원문과 secret/private key를 수집·출력·저장하지 않음

### Adapter와 runtime parity

`src/goal/application.js`는 local HTTP/read-only assertion, process health, browser/API/database read-only 및 staging deployment mock/injected adapter 경계를 제공한다. `src/goal/risk_execution.js`는 allowlisted operation별 injected adapter를 사용한다. 실제 production publish/deploy/database/SCM 연결은 구현되어 있지 않으며 별도 승인 phase 대상이다.

`extension/runtime/src/goal/`와 `extension/runtime/src/mcp/`에는 source 대응 구현이 있다. `stage2:parity`는 local contract/boundary parity를 확인하지만 production evidence까지 검증하지는 않는다.

### CLI/MCP 및 session

CLI `goal start/continue/resume`는 shared `prepareGoalExecution()`을 거쳐 policy, GoalPlan, expansion을 session에 저장하고 `runGoal()`에 전달한다. MCP `minitok_goal_start/continue/resume`도 같은 integration 경계를 사용하고 additive planning fields를 response에 포함한다. 기존 `runTask`, `runPipeline`, `runGoal`, `minitok_run`, `minitok_run_get` 계약은 별도 legacy surface로 유지된다.

`src/goal/session.js`는 `.minitok/goals/<goal_id>/` 아래 atomic state/events/checkpoints/evidence/lock을 관리하고 state migration, pause/resume, checkpoint 변경 시 verification-required, completion evidence gate를 제공한다.

## 3. General Agent 구현 gap

1. criteria/verifier 없는 자연어를 `clarification_required`에서 관찰 가능한 success hypothesis로 전환하는 interpreter가 없다.
2. 목표의 의도·범위·관련 작업·의존성을 일반적으로 추론하는 typed Plan DAG 계약이 없다.
3. observe → plan → act → observe → blocker → alternative → replan 반복을 하나의 general orchestration state로 저장하지 않는다.
4. 새 환경 관찰 결과로 기존 plan을 versioning/rewrite하는 additive session/evidence 이벤트가 없다.
5. `unrestricted_general` mode, 명시적 enablement, allowlist 및 기존 mode backward compatibility가 없다.
6. 새 external/application adapter는 mock/injected 경계는 있으나 general task routing 계약은 없다.

후속 phase는 위 gap만 추가하고 기존 GoalPlan/BlockerReport/AlternativePlan/recovery/evidence 계약과 legacy API를 변경하지 않아야 한다.

## 4. Baseline 결과

실행 디렉터리: `C:\Users\J1\.cline\data\workspaces\chat\minitok-release-1.4.6`

| Command | Result |
|---|---|
| `npm test` | PASS — 1508 tests, 1501 passed, 0 failed, 7 skipped |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run typecheck:extension` | PASS |
| `npm run docs:check` | PASS |
| `npm run stage2:parity` | PASS — local contract/boundary checks; production evidence 미검증 |
| `npm run test:e2e:goal` | PASS — mock goal E2E, exit 0 |

초기 foreground 실행은 도구의 30초 제한에 도달했으나, background 재실행으로 `npm test`와 goal E2E의 실제 exit code 0을 확인했다.

## 5. Phase 0 변경 범위

- 추가: 이 조사 보고서
- 수정하지 않음: `src/goal`, `src/cli`, `src/mcp`, `extension/runtime`, 기존 테스트 및 legacy API
- 새 테스트: 없음. 기존 baseline/goal integration/security/E2E 테스트를 실행함

## 6. 다음 phase readiness

**READY**. 다음 phase는 자연어 목표 interpreter 및 success-hypothesis 계약부터 시작해야 한다. 구현 순서는 source/runtime parity를 유지하고, phase별 테스트·lint·typecheck·extension typecheck·docs/parity·E2E를 통과한 뒤 별도 commit으로 진행한다.

Known limitation: 이번 Phase 0은 현재 구조와 baseline만 고정한다. `unrestricted_general`을 활성화하거나 실제 external production adapter를 연결하지 않는다.

예정 commit:

```text
docs: define general autonomous agent baseline
```

인덱스에 포함할 때 `final-full-test.exit` 및 baseline 실행 중 생성된 개인 작업 파일은 포함하지 않는다.

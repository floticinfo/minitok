# Phase 0 — `unrestricted_general` 현재 상태 재검증

- **Repository:** `C:\Users\J1\.cline\data\workspaces\chat\minitok-release-1.4.6`
- **Branch:** `fix/mcp-domain-auth`
- **HEAD:** `0967ce9477ca6015d8870b02aff7521d1c78afee`
- **Phase:** 0 — 현재 구현 및 실제 실행 경로 재감사
- **Status:** PASS / 구현 변경 없음
- **Date:** 2026-09-21

## 1. 결론

현재 저장소에는 `unrestricted_general`의 해석·계획·관찰·검증·blocker·replanning·session/persistence·CLI/MCP response 계약이 구현되어 있다. 그러나 이번 재검증에서 다음 통합 공백을 다시 확인했다.

```text
CLI/MCP 자연어 입력
→ intent / hypothesis / assumption / GoalPlan 준비
→ persistent Goal Session
→ 현재 실제 실행: runGoal() → GoalController
```

`runGeneralGoalLoop()`는 별도 구현 및 전용 테스트에서 동작하지만, 현재 CLI/MCP의 실제 launch executor와 `runGoal()` compatibility 함수에서 호출되지 않는다. 따라서 다음 순차 phase의 핵심 작업은 기존 안전 경계를 유지하면서 `unrestricted_general` 요청만 general loop로 라우팅하고, 기존 mode와 legacy 실행 계약은 보존하는 것이다.

**Phase 0 판정: PASS. 다음 phase 진입: READY.**

## 2. 저장소 및 작업 상태

- repository guidance는 상위 `C:\Users\J1\.cline\data\workspaces\chat\AGENTS.md`에서 확인했다.
- 작업 시작 시 working tree는 clean이었다.
- 현재 `origin/master...HEAD` 관계는 `0 50`이다. 즉 `HEAD`는 `origin/master`보다 50 commits ahead, 0 behind다.
- 현재 branch upstream 표시인 `origin/fix/mcp-domain-auth` 기준으로는 branch가 ahead 49로 표시된다. 이는 master 기준 관계와 다른 비교 대상이다.
- 기존 artifact와 문서에는 `.minitok/benchmarks`, `.minitok/live-e2e`, `.minitok/goal-e2e-results.json`, `docs/phase0-general-autonomous-agent-baseline.md` 등이 존재한다. 이번 검증 후에도 working tree 변경은 없었다.
- 실제 외부 서비스, production adapter, live goal E2E는 호출하지 않았다.

## 3. 현재 구현된 기능

### 자연어 해석과 general planning

- `src/goal/intent.js`에서 자연어 objective를 해석하고 normalized intent, 해석 상태, 후보 criterion, hypothesis/assumption 입력을 만든다.
- `src/goal/expansion_general.js`에서 `unrestricted_general`용 open-world expansion을 수행한다. 후보 success criterion, provisional criterion, hypothesis, assumption ledger, inferred/optional step, dependency와 scope를 생성하고 GoalPlan을 validation한다.
- `src/goal/general_planner.js`에서 versioned general Plan DAG, normalized step, planning trace, plan validation/serialization을 제공한다.
- `src/goal/replanner.js`에서 blocker, verifier failure, environment/tool capability 변화, assumption invalidation, 반복 실패와 stagnation을 원인으로 plan version을 증가시키고 보존/폐기/new step을 기록한다.

### 관찰, 도구, adapter와 verifier

- `src/goal/environment_observer.js`가 repository, package scripts, command availability, service/capability, credential presence의 redacted observation을 만든다.
- `src/goal/tool_registry.js`가 tool discovery, TTL/stale 상태, external capability와 required capability preflight를 관리한다.
- `src/goal/adapter_registry.js`가 injected adapter descriptor/schema/capability/policy/production gate를 관리한다. 실제 production adapter를 임의 호출하지 않으며 local/mock/injected 경계를 사용한다.
- `src/goal/dynamic_verifier.js`가 verifier schema, allowlisted command/path, timeout, executed provenance, valid evidence, verifier fingerprint/tampering과 completion evidence를 관리한다.
- `isCompletionVerified()`는 model self-report만으로 완료를 인정하지 않으며 valid/executed verifier evidence를 요구한다.

### General loop와 persistence

- `src/goal/general_loop.js`가 observe → plan → tool/step execute → dynamic verify → blocker classification → alternative selection → replan → checkpoint/persist 흐름을 구현한다.
- `src/goal/session.js`가 `.minitok/goals/<goal_id>/` 아래 goal/state/events/checkpoints/evidence/lock을 atomic/redacted 방식으로 저장하고 pause/resume, crash recovery, rollback record, resume verification을 제공한다.
- `assertCompletionEvidence()`/`markGoalCompleted()`는 required criterion별 evaluator evidence가 없으면 완료 상태를 허용하지 않는다.

### 정책과 안전 경계

- `src/goal/execution_policy.js`의 mode는 `safe`, `supervised`, `authorized_external`, `unrestricted`, `unrestricted_general`, `always_blocked`를 지원한다.
- `unrestricted_general`은 기본 비활성이다. repository config, 명시 mode/confirmation, runtime permission, auto-accept, capability allowlist, budget, audit persistence와 integrity preflight의 교집합을 요구한다.
- `safe`, `supervised`, `authorized_external`, `unrestricted`, `always_blocked`의 기존 계약은 이번 Phase 0에서 수정하지 않았다.
- path traversal/workspace escape, protected path 수정, dangerous object key, verifier tampering, credential/secret/private key 출력·저장, approval bypass와 always-blocked operation은 계속 차단된다.


## 4. 실제 실행 경로 조사

### CLI

`src/cli/commands/goal.js`의 `goal start`는 다음 순서다.

```text
cmdGoalStart
→ GoalSpec compile/입력 준비
→ unrestricted_general policy preflight
→ prepareGoalExecution(... general_inference: true)
→ intent / expansion / hypotheses / assumptions / GoalPlan 생성
→ session state에 planning metadata 저장
→ executeGoal = options.runGoal || runGoal
→ runGoal(goalSpec, { goalPlan, goalExpansion, ... })
→ GoalController 실행
```

CLI는 general plan을 준비하고 `goalExpansion`을 전달하지만 기본 executor는 `runGoal()`이며 `runGeneralGoalLoop()`를 호출하지 않는다. `options.runGoal`은 테스트 seam/호환 주입 경로다. `goal continue`/`goal resume`도 기본적으로 같은 `runGoal()` 경로를 사용하며 checkpoint 변경과 policy 재검증은 유지된다.

### MCP

`src/mcp/goal-tools.js`와 extension runtime 대응 파일의 start/continue/resume은 다음 흐름이다.

```text
MCP validation → policy → compile/prepare → session persist
→ launch(session) → runGoal(session.goalSpec, ...)
→ GoalController 실행
```

response에는 GoalPlan, inferred/optional steps, hypotheses/assumptions, blocker, alternatives, verification/audit metadata가 additive로 포함되지만 general loop 호출은 없다.

### 호출 근거 구분

- 구현/export: `src/goal/general_loop.js`, `extension/runtime/src/goal/general_loop.js`
- 직접 호출: general loop 및 persistence/blocker 전용 테스트
- CLI/MCP/`runGoal()` 제품 경로의 `runGeneralGoalLoop()` import/call: **없음**
- 실제 default executor: `runGoal()` → `GoalController`

따라서 import 또는 테스트 통과를 실제 제품 통합으로 간주하지 않았다.

## 5. Source/runtime parity

다음 핵심 파일의 source와 `extension/runtime/src` 대응 구현을 비교했다.

- `goal/integration.js`
- `goal/expansion_general.js`
- `goal/general_loop.js`
- `goal/general_planner.js`
- `goal/replanner.js`
- `goal/dynamic_verifier.js`
- `goal/environment_observer.js`
- `goal/tool_registry.js`
- `goal/adapter_registry.js`
- `goal/controller.js`
- `goal/session.js`
- `goal/execution_policy.js`

각 파일의 SHA-256가 source/runtime에서 동일했고, `npm run stage2:parity`도 통과했다. parity는 local contract/boundary와 파일 대응을 검증하며 production deployment evidence를 의미하지 않는다.

## 6. Phase 0 검증 결과

실행 디렉터리:

```text
C:\Users\J1\.cline\data\workspaces\chat\minitok-release-1.4.6
```

| Command | Result |
|---|---|
| `npm test` | **PASS** — 1604 tests, 1597 passed, 0 failed, 7 skipped |
| `npm run lint` | **PASS** — exit 0 |
| `npm run typecheck` | **PASS** — exit 0 |
| `npm run typecheck:extension` | **PASS** — exit 0 |
| `npm run docs:check` | **PASS** — exit 0 |
| `npm run stage2:parity` | **PASS** — local contract/boundary checks; production evidence 미검증 |
| `npm run test:e2e:goal` | **PASS** — mock mode, exit 0 |

mock E2E는 deterministic mock provider/model과 local/injected 경계를 사용했다. 이를 live provider, production adapter, production success evidence로 표현하지 않는다. E2E 결과에는 model self-report와 실제 evidence completion이 구분되어 있으며, negative/security scenario는 false completion 없이 blocker/escalation을 유지했다.

## 7. 확인된 gap과 다음 phase 범위

### 핵심 gap

1. CLI/MCP가 general intent와 GoalPlan을 준비하지만 general orchestration executor를 선택하지 않는다.
2. `runGeneralGoalLoop()`의 plan/observe/execute/verify/blocker/replan/persistence 상태가 실제 `unrestricted_general` session 실행 결과의 canonical path가 아니다.
3. CLI/MCP continue/resume이 general session을 재개할 때도 `runGoal()` 경로를 사용한다.
4. 현재 문서 일부는 `GoalController({ goalPlan, goalExpansion })`가 general loop까지 연결된 것처럼 읽힐 수 있으므로, 통합 phase에서 실제 routing 계약과 response/session state를 명확히 해야 한다.

### 다음 phase의 필수 조건

- `unrestricted_general`에만 적용되는 명시적 routing boundary를 추가한다.
- 기존 mode와 legacy `runGoal()`/`GoalController` 실행을 변경하지 않는다.
- CLI와 MCP, source와 extension runtime을 함께 변경하고 parity를 유지한다.
- general loop 진입 전 policy, explicit confirmation, runtime permission, config allowlist, budget, audit/integrity preflight를 재검증한다.
- general loop가 기존 session/checkpoint/rollback/evidence schema를 사용하고, required criterion별 valid/executed verifier evidence 없이는 completed를 반환하지 않도록 한다.
- 실제 외부 서비스/production adapter를 호출하지 않고 deterministic mock/local benchmark로 통합을 검증한다.
- 기존 `safe`, `supervised`, `authorized_external`, `unrestricted`, `always_blocked` 회귀 테스트를 유지한다.

## 8. Phase 0 산출물과 readiness

- 추가 문서: `docs/phase0-general-autonomous-agent-current-state.md`
- 제품 구현 변경: 없음
- 기존 테스트/안전 경계 변경: 없음
- 검증: 위 표의 모든 명령 PASS
- 다음 단계 readiness: **READY**

다음 phase는 `runGeneralGoalLoop()`를 CLI/MCP의 `unrestricted_general` 실제 실행 경로에 연결하는 최소 routing/adapter boundary와 source/runtime parity 테스트부터 시작해야 한다. 이번 Phase 0에서는 `unrestricted_general`을 활성화하거나 실제 외부/production adapter를 연결하지 않았다.

예정 commit:

```text
docs: re-audit general autonomous agent current state
```

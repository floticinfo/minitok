# Goal-agent baseline (Phase 0)

## 목적과 범위

이 문서는 목표 실행형 아키텍처를 추가하기 전, 현재 minitok 1.4.5 task 실행 동작을 기준선으로 고정한다. 이번 페이즈는 관찰·문서화·회귀 테스트만 포함한다.

이번 페이즈에서 구현하지 않는 것:

- `GoalSpec`
- `GoalController`
- `GoalEvaluator`
- goal 단위 영속화·재개 프로토콜
- 모델의 `done` 또는 `APPROVE`를 최종 완료 신호로 승격하는 변경

## 기술 기준선

- Node.js CommonJS (`package.json`의 `type: commonjs`)
- Node.js 내장 test runner (`node --test`)
- `npm test`는 `tests/**/*.js`와 `src/**/*.test.js`를 실행
- ESLint flat config: `npm run lint`
- TypeScript는 JavaScript를 검사하는 `allowJs/checkJs` 설정이며 `npm run typecheck`로 실행
- 외부 라이브러리를 추가하지 않음

## 현재 실행 구조

현재 구조는 task 하나를 여러 cycle로 처리한다.

```text
task
→ runPipeline / runPipelineInWorkspace
→ cycle loop
→ intel (설정 시)
→ plan
→ implement
→ deterministic verification command
→ review
→ repair 또는 다음 task
```

### 1. task 입력과 workspace discovery

- CLI·MCP의 입력은 현재 `task` 문자열이다.
- CLI가 workspace 이름 또는 경로를 해석한 뒤 pipeline에 repository root를 전달한다.
- MCP의 `minitok_discover`는 workspace와 인증된 provider 후보를 조회하고, 필요한 경우 session-scoped `selection_id`를 만든다. `minitok_run`은 선택된 provider와 repository path를 검증한 뒤 실행한다.
- pipeline 자체의 호환 API는 `runPipeline(task, opts)`이며, 기존 호출자는 계속 task 문자열과 기존 `opts`를 사용할 수 있다.

관련 코드:

- `src/mcp/tools.js`
- `src/workspace/manager.js`
- `src/discovery/`
- `src/pipeline/loop.js`

### 2. provider 선택

pipeline은 config의 `default_provider`와 role별 provider(`plan`, `work`, `review`, `intel`)를 사용한다. 명시적인 `providerOverride`가 있으면 해당 선택을 우선하고, provider availability를 확인한다. role별 fallback과 escalation 설정은 provider module/config에 의해 처리된다.

모델 호출은 provider의 `complete(messages, options)` 비동기 API를 사용한다. MCP 경로에서도 pipeline은 await되며, repository verification command도 `verifyCommandAsync`를 사용한다.

### 3. planning

`src/pipeline/planner.js`가 task와 repository context를 입력으로 plan을 생성한다. plan은 단계, 대상 파일, 위험도 등의 구조화된 JSON 결과다. pipeline은 context manifest/contract를 `.minitok/contracts/`에 기록한다.

### 4. implementation

`src/pipeline/implementer.js`가 plan을 provider에 전달하고, 구조화된 changes를 검증한 뒤 보안·경로·보호 파일 정책을 적용한다. 실제 파일 변경에는 승인 정책이 적용된다.

- dry-run이면 변경을 적용하지 않는다.
- MCP `minitok_run`은 기본적으로 `write` 및 `verify_exec` scope가 필요하다.
- `auto_accept`는 명시적인 `auto_accept` permission이 있을 때만 활성화된다.
- 구현 결과와 변경 파일은 cycle 결과 및 evidence에 포함된다.

### 5. verification

implementation 뒤에는 deterministic repository gate가 실행된다.

- 기본 gate: `VERIFY_CMD.mjs`
- 기본 validation timeout: 120초
- async path: `verifyCommandAsync` → `runVerificationAsync`
- gate의 exit status/output은 cycle evidence에 기록된다.
- gate가 통과하지 않으면 review verdict가 있더라도 해당 cycle은 `VERIFICATION_FAILED`가 될 수 있다.

pipeline은 host event loop를 막지 않도록 verification에서 동기 child-process 호출을 사용하지 않는다. `src/pipeline/check.js`에는 호환을 위한 synchronous API도 있지만 pipeline 경로는 async API를 사용한다.

### 6. review와 `APPROVE`의 의미

`src/pipeline/verifier.js`의 review provider는 다음 verdict 중 하나를 반환한다.

- `APPROVE`
- `CHANGES_REQUESTED`
- `REJECT`

`APPROVE`는 모델 review 결과이지 그 자체로 최종 완료 증명이 아니다. pipeline은 deterministic verification이 통과했는지, confidence threshold(기본 0.8)를 충족하는지, cycle 정책을 통과하는지를 함께 확인한다. 이를 통과한 cycle의 status가 `APPROVE`가 될 때만 성공 후보가 된다.

최종 성공은 `summarizeRunOutcome(cycles)`가 **마지막 cycle의 status가 `APPROVE`인지**로 판정한다. 이전 cycle이 `APPROVE`였더라도 후속 cycle이 `REJECT`, `CHANGES_REQUESTED`, `VERIFICATION_FAILED`이면 run은 성공이 아니다. 이전 승인 존재는 `approved: true`인 partial 상태를 구분하는 데만 사용된다.

### 7. repair와 다음 task

- `REJECT` 또는 `VERIFICATION_FAILED`는 `buildRepairTask`를 통해 원래 goal, review feedback, verification 결과를 포함한 repair task로 바뀐다.
- 충분한 confidence의 `APPROVE` 뒤에 cycle이 남아 있고 dry-run이 아니면 `generateNextTask`가 호출될 수 있다.
- `src/pipeline/next_task.js`는 모델에게 다음 JSON을 요청한다.

```json
{"done": true, "summary": "..."}
```

또는 다음 task를 요청한다. 여기서 `done`은 **다음 task를 생성할지 여부에 대한 모델 제안**일 뿐이다. 시스템은 최종 cycle 상태, verification, 제한, persistence를 기준으로 결과를 확정한다. Phase 0 회귀 테스트는 이 분리를 고정한다.

### 8. 승인

변경 적용이 필요한 경우 pipeline은 approval file/nonce와 `approvalTimeoutMs`를 사용해 operator의 결정을 기다린다. MCP의 `minitok_approve_run`과 `minitok_reject_run`은 승인 파일에 검증 가능한 결정을 기록한다. `auto_accept`는 보안 scope와 정책이 모두 허용할 때만 approval wait를 우회한다.

승인 대기 중 `AbortSignal`이 abort되면 대기는 즉시 중단되고 변경 승인이 거부된다.

## 제한과 중단

현재 설정 기본값과 loop guard는 다음과 같다.

| 제한 | 현재 기준선 |
| --- | --- |
| cycle 설정 | `budget.max_cycles: unlimited` |
| cycle hard limit | `budget.max_cycles_hard_limit: 100` |
| token 설정 | `budget.token_budget: unlimited` |
| token hard limit | `budget.token_hard_limit: 2,000,000` |
| stagnation | `budget.stagnation_limit: 3`; 같은 변경 signature 또는 무변경 cycle을 세어 중단 |
| 전체 wall-clock hard limit | `execution.timeout_hard_limit_sec: 86400` (24시간) |
| repository gate timeout | `validation.timeout_ms: 120000` (120초) |
| 변경 파일 제한 | `validation.max_changed_files: 20` |

실제 run에서는 token hard limit 접근 시 escalation/human escalation이 발생할 수 있고, signal/abort는 실행을 중단한다. 제한에 도달해도 모델이 `done`이라고 응답했다는 사실만으로 성공으로 바뀌지 않는다.

## state와 evidence

### task contract state

`src/state/contracts.js`가 repository 내부에 다음을 atomic write한다.

```text
<repo>/.minitok/contracts/task-contract.json
<repo>/.minitok/contracts/context-manifest.json
```

contract에는 schema version, timestamp, status, cycle 수, success/approved/final status 등이 저장된다. goal 원문은 `goal_id`로 sanitize되어 contract 파일에 직접 저장되지 않는다.

### MCP run state

`src/runtime/stdio.js`의 run state는 기본적으로 `~/.minitok/mcp-runs.json`이며 runtime 옵션으로 `runStatePath`를 지정할 수 있다. 상태는 version 2 envelope로 atomic write된다. 실행 중 run은 메모리 `Map`에도 있고, 완료·실패·취소 상태는 persistence에 반영된다.

runtime이 재시작되면 persisted `running` record는 실제 worker가 더 이상 존재한다고 가정하지 않고 다음으로 변환한다.

```json
{"state":"unknown","recovery":"interrupted"}
```

현재는 자동 재개가 없다. 즉, 중단 후 재개 가능한 것은 완료/실패/취소 run의 관찰과 조회이지, 중단된 pipeline의 cycle을 이어서 실행하는 기능이 아니다.

### run evidence

`src/run-evidence.js`는 기본적으로 다음을 atomic write한다.

```text
<repo>/.minitok/evidence/runs/<run_id>.json
<repo>/.minitok/evidence/runs/latest.json
```

기록 대상은 task, 마지막 plan/work/review, changed files, verification commands/exit status/passed, outcome, error다. 민감한 key/token/credential/prompt 값은 redact한다. evidence 저장 실패는 pipeline 결과를 성공으로 바꾸지 않으며 warning으로 보고된다.

## 실패와 중단 처리 요약

- provider unavailable/invalid response/config 오류: pipeline error로 종료하고 failed contract를 기록한다.
- implementation validation/policy 오류: 변경을 적용하지 않거나 cycle 실패로 남긴다.
- deterministic gate 실패: verification evidence를 보존하고 `VERIFICATION_FAILED`/repair 경로를 사용한다.
- review `REJECT`: repair task를 만들 수 있다.
- review `CHANGES_REQUESTED`: 해당 cycle은 승인되지 않으며 max cycle까지 반복될 수 있다.
- approval reject/timeout/cancel: 변경을 성공으로 보고하지 않는다.
- signal/AbortSignal: approval wait와 pipeline child process가 중단되며 MCP run은 cancelled/failed로 반영된다.
- MCP 호출은 비동기이며, JSON-RPC response는 pipeline promise가 완료된 뒤 반환된다. verification child process도 pipeline 경로에서는 비동기다.

## 목표 구조와 향후 계층

현재 task workflow 위에 점진적으로 다음 계층을 추가하는 것이 목표다.

```text
goal
→ GoalSpec
→ GoalController
→ observation
→ task executor
→ goal evaluator
→ continue / done / escalate
```

각 계층의 향후 책임은 다음과 같다.

- `GoalSpec`: 목표, 성공 조건, 관찰 대상, 예산/중단 정책의 명시적 표현
- `GoalController`: observation을 task executor에 공급하고 실행을 반복·중단·재개하는 제어 계층
- `observation`: workspace/provider/state/evidence에서 시스템이 확인한 사실
- `task executor`: 현재 `runPipeline(task, opts)`를 호환 가능한 실행 backend로 사용
- `goal evaluator`: 모델 제안이 아니라 관찰/evidence/검증 결과를 조합해 목표 달성 여부를 시스템 관점에서 판정
- `continue / done / escalate`: evaluator와 hard policy가 결정하는 상태 전이

Phase 0에서는 이 계층을 구현하지 않는다. 특히 기존 `minitok_run(task)` API와 task cycle semantics를 보존한 채, 이후 페이즈에서 명시적 goal 상태를 추가할 수 있도록 기준선만 확보한다.

## Phase 0 회귀 테스트

`tests/test-phase0-baseline.js`는 다음 계약을 고정한다.

1. 모델 `done: true`는 task-generation metadata이며 final success가 아니다.
2. 마지막 cycle이 실패하면 이전 `APPROVE`가 있어도 run은 실패이고 partial approval만 구분된다.
3. `minitok_run`은 async runner를 await하고 `success: false`를 failed/error envelope로 전달한다.
4. runtime 재시작 시 running run은 `unknown/interrupted`로 복구되며 자동 실행되지 않는다.

## Phase 1 추가 기준선: GoalSpec

Phase 1은 기존 task workflow 위에 독립적인 GoalSpec 모듈 경계를 추가했다.

- `src/goal/spec.js`: schema version, verifier/mode 상수, GoalSpec 생성 및 JSON serialization/deserialization
- `src/goal/validator.js`: 필수 필드, goal id, criterion, verifier, path, 숫자 제한, execution mode, unknown/dangerous field 검증
- `src/goal/compiler.js`: 명확한 자연어 목표의 보수적 초안 생성, model draft validation, `clarification_required` 상태, 기존 `minitok_run(task)`용 compatibility adapter

compiler는 모델의 `done`/`completed`를 완료 판정에 사용하지 않는다. 성공 criteria를 만들 수 없는 모호한 목표는 자동 실행 가능한 spec으로 변환하지 않고 `clarification_required`를 반환한다. legacy adapter는 기존 `runPipeline(task, opts)`와 `minitok_run(task)` 호출 경로를 변경하지 않으며, GoalSpec을 생성하는 별도 변환 함수로만 제공된다.

Phase 1 범위 밖:

- `GoalController`
- `GoalEvaluator`
- persistent goal session
- MCP goal API
- 브라우저 및 배포 도구

## Phase 2 추가 기준선: GoalEvaluator

Phase 2는 GoalSpec의 success criteria를 실제 관찰/evidence로 평가하는 독립 evaluator를 추가했다.

- `src/goal/evaluator.js`: `command`, `test`, `file` verifier와 `passed|failed|unknown` 판정
- `src/goal/evidence.js`: criterion evidence schema, deterministic evidence id, stdout/stderr/result redaction
- `src/goal/evaluator.test.js`: required/optional, timeout/error, redaction, 안정성, file verifier 회귀 테스트

GoalEvaluator 결과는 다음 계약을 따른다.

```json
{
  "goal_id": "goal_123",
  "completed": false,
  "criteria": [
    { "id": "criterion", "status": "unknown", "evidence_ids": ["evidence_..."], "reason": "..." }
  ],
  "remaining_criteria": [],
  "unknown_criteria": ["criterion"],
  "evaluated_at": "...",
  "state_version": 3
}
```

`unknown`은 `passed`로 승격되지 않는다. `completed: true`는 모든 required criterion이 `passed`이고 해당 evidence가 valid일 때만 가능하다. optional criterion의 실패는 결과에 보존되지만 전체 완료를 막지 않는다.

command verifier는 임의 shell 문자열을 실행하지 않고 `npm`, `node`, `npx` allowlist와 argv만 허용하며 shell metacharacter를 거부한다. 실행은 기존 `src/pipeline/check.js`의 비동기 process utility를 재사용하고 timeout, exit code, output, duration을 evidence에 기록한다. test verifier는 기존 `verifyCommandAsync` 또는 동일한 제한 command 경로를 사용한다.

file verifier는 workspace 내부의 존재 여부, 제한된 문자열 포함/정확한 내용, 제공된 baseline 대비 변경 여부만 평가한다. 정규식·임의 JavaScript expression·custom handler 실행은 Phase 2에서 지원하지 않으며 `unknown`으로 남는다.

모델의 `done`, `completed`, review `APPROVE`는 evaluator 입력에 있어도 최종 결과를 덮어쓰지 않는다. GoalEvaluator는 현재 pipeline이나 MCP API에 연결하지 않았으며, `GoalController`가 이후 phase에서 명시적으로 연결해야 한다.


## Phase 3 추가 기준선: GoalController

Phase 3은 기존 `runPipeline(task, opts)`를 task executor로 감싸고, GoalSpec 위에 독립적인 controller 경계를 추가했다.

- `src/goal/task_executor.js`: 기존 `runPipeline` compatibility wrapper인 `runTask(task, options)`
- `src/goal/controller.js`: `GoalController`와 `runGoal(goalSpec, options)`
- `src/goal/controller.test.js`: fake evaluator/task executor/proposer 기반 상태 전이 테스트

현재 task 실행 책임은 다음과 같이 분리된다.

```text
runPipeline(task, opts)
→ 기존 task cycle orchestration / provider / plan / implement / verify / review / repair

runTask(task, opts)
→ runPipeline compatibility adapter
→ 표준 task 결과(task_id, success, status, changes, verification, review, evidence, tokens, duration)

runGoal(goalSpec, opts)
→ GoalController
→ observe → evaluate → select criterion → propose task → runTask → repeat
```

GoalController는 current goal/task, state version 4, evaluator 결과와 evidence, criterion 상태, task/action history, cycle/token usage, timeout/approval, 반복 task/failure/stagnation을 관리한다.

각 cycle은 evaluator를 먼저 실행한다. evaluator가 모든 required criteria를 통과하면 task를 추가 실행하지 않고 `completed`로 종료한다. 모델의 `done: true`는 evaluator 결과를 덮어쓰지 않는다.

GoalController safety limits:

- `max_cycles`
- `max_tokens`
- `timeout_ms`
- `stagnation_limit`
- `same_task_limit`
- `same_failure_limit`
- `max_changed_files`
- `allowed_paths`/`blocked_paths`

Task proposal은 `next_task`, `target_criteria`, `rationale`, `expected_verification`을 사용한다. `done`은 action history에 `model_done` metadata로만 보존한다. task executor 예외는 `recover` 상태와 task history에 기록되고 성공으로 처리되지 않는다.

이번 Phase 3에서는 `runPipeline`을 제거하거나 MCP API에 goal mode를 연결하지 않았다. persistent goal session, 브라우저/배포 동작은 후속 범위다.


## Phase 4 추가 기준선: Persistent Goal Session

Phase 4는 GoalController 상태를 task contract와 분리된 goal session namespace에 저장하는 내부 API를 추가했다.

```text
<workspace>/.minitok/goals/<goal_id>/
├─ goal.json
├─ state.json
├─ events.jsonl
├─ checkpoints/
├─ evidence/
└─ locks/session.lock
```

`src/goal/session.js`가 제공하는 내부 API:

- `createGoalSession`
- `loadGoalSession`
- `saveGoalSession`
- `appendGoalEvent`
- `createCheckpoint`
- `restoreCheckpoint`
- `pauseGoalSession`
- `resumeGoalSession`
- `markGoalCompleted`
- `markGoalFailed`
- `markGoalEscalated`

저장 원칙:

- JSON 상태는 임시 파일을 만들고 rename하는 atomic write
- Windows rename 동작을 고려한 기존 state contract 패턴 사용
- 파일은 owner-only permission을 적용
- `events.jsonl`은 append-only 구조이며 event payload는 redaction
- GoalSpec은 기존 validator를 통과해야 저장
- state schema version은 `2`, future migration을 위해 `migrateState`를 제공
- goal id와 tracked path는 workspace 밖으로 escape할 수 없음
- goal별 exclusive `session.lock`으로 동일 goal session의 concurrent access를 거부

resume은 다음을 검사한다.

- GoalSpec validation
- state JSON corruption 및 schema version
- 저장된 workspace와 요청 workspace 일치 여부
- 마지막 checkpoint의 tracked file hash 변경 여부
- 변경이 있으면 `safe_to_resume: false`, `requires_verification: true`
- model/provider는 구조화된 state metadata를 교체할 수 있으며 대화 transcript에 의존하지 않음

checkpoint restore는 controller state와 checkpoint metadata를 복원하지만 workspace 파일 자체를 자동 rollback하지 않는다. tracked file이 checkpoint 이후 변경되었는지 별도 결과로 보고하므로, 다음 verifier 실행 여부를 controller가 결정할 수 있다.

이번 페이즈에서는 MCP API를 추가하지 않았고, 기존 `runPipeline(task)`, `runTask`, `runGoal` 호출의 자동 persistence 동작을 변경하지 않았다. GoalController와 session API의 직접 통합은 다음 페이즈에서 approval/recovery 정책과 함께 연결해야 한다.


## Phase 5 추가 기준선: Failure Recovery와 Capability Routing

Phase 5는 GoalController 위에 실패 분류, 정체 감지, recovery strategy, capability 기반 모델 routing을 추가했다.

신규 모듈:

- `src/goal/failure.js`: failure category, failure/patch signature, stagnation detection
- `src/goal/recovery.js`: category별 recovery strategy와 non-repeating recovery task 생성
- `src/goal/capabilities.js`: model capability contract, role requirement, fallback selection

지원 failure category:

```text
model_output_invalid
planning_error
implementation_error
verification_failure
environment_failure
permission_blocked
timeout
repeated_failure
scope_violation
unknown
```

controller는 동일 task/verifier failure/patch, 새 evidence 부재, criterion progress 부재, 동일 state fingerprint를 정체 신호로 판정한다. 반복 failure는 `repeated_failure` strategy로 승격될 수 있다.

recovery strategy 예시:

- invalid structured output → structured retry
- planning error → replan
- implementation error → repair task
- verification failure → alternative strategy
- environment failure → environment re-observation
- permission blocked → approval/escalation
- repeated failure → recovery capability가 높은 다른 model 선택
- scope violation → scope 재계획

model capability contract는 `structured_output`, `tool_calling`, `repository_navigation`, `code_editing`, `error_recovery`, `long_horizon`을 관리한다. role routing은 `intel`, `plan`, `work`, `review`, `goal_evaluation`, `recovery`를 지원한다. 후보 model이 없거나 capability minimum을 충족하지 못하면 무한 retry하지 않고 `escalate` 상태로 종료한다.

기존 GoalState/evidence는 유지되며 model/provider 변경 내역은 `model_routing`과 recovery history에 기록된다. 기존 `execution.max_retries`는 controller options의 `maxRetries`/`execution.max_retries`로 연결하고, 없으면 GoalSpec same-failure limit을 fallback으로 사용한다. 기존 `runPipeline` retry/stagnation semantics와 MCP API는 변경하지 않았다.


## Phase 6 추가 기준선: MCP Goal Session Integration

Phase 6은 persistent Goal Session을 MCP transport에 additive하게 연결했다.

추가 MCP tools:

- `minitok_goal_start`
- `minitok_goal_status`
- `minitok_goal_continue`
- `minitok_goal_pause`
- `minitok_goal_resume`
- `minitok_goal_cancel`

`minitok_run(task)`는 기존대로 유지하며, 하나의 구체적인 task에는 계속 `minitok_run`을 사용한다. 장기 목표는 Goal Session API를 사용한다.

### MCP Goal API 상태

Goal start 결과는 다음 상태를 구조화해 반환한다.

```text
running
paused
completed
failed
escalated
clarification_required
```

`completed`는 모델 응답이 아니라 persistent GoalEvaluator 결과의 `completed: true`에서만 설정된다. `done=true`, `completed=true`, review `APPROVE`는 최종 완료 판정에 사용되지 않는다.

### 권한 정책

- `minitok_goal_status`: `read`
- start/continue/pause/resume/cancel: `write`
- 기본 mode: `safe`/`supervised` 경로
- `autonomous`: 명시적인 `auto_accept` MCP scope가 없으면 거부
- 기존 `minitok_run`의 write/verify_exec/approval 정책은 변경하지 않음

Goal session은 `.minitok/goals/<goal_id>`에 저장되므로 MCP process가 종료되어도 status를 다시 읽을 수 있다. 실행 중인 controller promise는 runtime process가 살아 있는 동안만 메모리에 존재하며, process 종료 후에는 persistent state를 기반으로 `goal_status`와 `goal_resume`이 동작한다.

### Host Agent 정책

`minitok-mcp-host` system prompt는 다음을 명시한다.

- 장기/다단계 목표에는 goal API 사용
- 단일 task에는 `minitok_run` 사용
- `goal_status`가 evaluator 기반 `completed`를 반환하기 전 완료 주장 금지
- paused/failed/escalated/clarification_required 상태 숨기지 않기
- MCP process 재시작 후에도 `goal_status`로 persistent 상태 확인

host의 기본 goal mode는 `supervised`이며, autonomous는 MCP server가 권한으로 거부할 수 있다. goal status만 auto-approve 대상으로 추가하고, 변경을 수행하는 goal tools는 기존 write approval 정책을 따른다.

이번 Phase 6에서는 외부 MCP goal API 외에 browser/deployment 동작을 추가하지 않았다.



## Phase 7 추가 기준선: Repository ODD와 로컬 Benchmark

Phase 7은 외부 환경으로 확장하기 전에 Git repository와 local verifier만으로 목표 달성 신뢰성을 검증한다.

자동화 범위:

- Git repository/status/diff
- source/test/build/typecheck/lint
- 정해진 local verifier

구현하지 않는 범위:

- 실제 배포
- cloud 설정 변경
- production database 변경
- 외부 계정 생성
- 결제
- 임의 외부 API 호출

GoalSpec constraints는 다음 `repository_odd`를 지원한다.

```json
{
  "allowed_paths": ["src", "tests"],
  "protected_paths": ["VERIFY_CMD.mjs", "minitok.yml"],
  "required_checks": ["git_status", "git_diff", "changed_files", "protected_paths"],
  "allow_external": false
}
```

`allow_external`은 Phase 7에서 반드시 false여야 한다. unknown ODD field/check, path traversal, 외부 path는 validator가 거부한다.

`src/goal/odd.js`는 git status, git diff, changed file list, protected path check와 local command/test/build/typecheck/lint result를 evidence로 수집한다. local verifier가 실행되지 않았거나 command가 없거나 timeout/외부 상태 불확실이면 `unknown`이며 passed로 취급하지 않는다. protected file 변경이나 allowed path 밖의 변경이 있으면 repository scope는 invalid다.

GoalEvaluator 결과에는 다음 progress summary가 포함된다.

```json
{"required_total":5,"passed":3,"failed":1,"unknown":1,"progress_ratio":0.6}
```

모델의 조기 완료 주장, 실행되지 않은 테스트, missing verifier, timeout, 일부 criterion만 통과한 상태는 completed가 될 수 없다.

### Repository benchmark

`src/goal/benchmark.js`에 외부 접근 없는 local benchmark scenario를 추가했다.

- single-file bug fix
- multi-file feature
- test failure 후 repair
- partial criteria
- early completion claim
- repeated failure
- scope violation
- verifier command failure

각 benchmark record는 goal, initial state, expected success criteria, actual completed 여부, cycle count, model count, verifier evidence, invalid completion 여부, missing goal 여부, duration을 포함한다. benchmark runner는 실제 배포나 cloud/database/API 호출을 수행하지 않는다.

## Phase 8 추가 기준선: Application Environment Adapters

Phase 8은 Repository ODD를 통과한 GoalController를 mock-first application environment로 확장한다.

신규 모듈:

- `src/goal/application.js`
- `src/goal/application.test.js`

지원 adapter:

- `local_http`
- `process_health`
- `api_assertion`
- `browser_assertion`(injected mock driver만)
- `database_read_only`(injected read-only reader만)

모든 adapter는 명시된 capability, approval policy, timeout, URL/account/action allowlist, evidence redaction, 실행 여부를 확인한다. 외부 접근은 기본적으로 실행되지 않는다. HTTP는 허용된 localhost origin과 injected request driver가 있어야 하며, browser/database는 injected driver가 없으면 `unknown`이다.

timeout, connection failure, health check 미실행, assertion path 오류는 성공이 아니다. application evidence는 code state와 application state를 분리한다. browser assertion은 허용 URL/계정/action과 timeout/assertion evidence를 요구하며 arbitrary browser action을 실행하지 않는다.

`deployment` adapter는 등록하지 않았다. staging, rollback, health check, approval, auto rollback/human escalation 계약이 모두 정의되기 전에는 deployment command를 성공으로 취급하지 않는다.

이번 Phase 8의 기본 테스트는 모두 mock environment에서 실행하며 실제 외부 서비스, cloud, production database, 배포, 임의 외부 API를 호출하지 않는다.

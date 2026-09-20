# Goal Agent Operations

## 표준 운영 절차

1. 목표를 명시하고 성공 기준과 verifier를 확인한다.
2. `safe` 또는 `supervised` mode로 시작한다.
3. Goal status에서 evaluator criteria, evidence, scope, current task를 확인한다.
4. `passed`와 `valid evidence`가 있는 필수 기준만 완료로 인정한다.
5. `unknown`은 실패로 임의 변환하지 않고 verifier를 재실행하거나 사람에게 확인을 요청한다.
6. 반복 실패, timeout, scope violation, approval 거부는 recovery 또는 escalation으로 처리한다.

## Approval 정책

파일 변경과 verifier 실행 scope는 MCP permission과 실행 정책으로 제한된다. autonomous mode와 `auto_accept`는 명시 permission이 없으면 시작되지 않는다. safe mode에서 approval이 필요한 작업은 approval state를 기록하고 승인 전 write를 실행하지 않는다. approval 기록만으로 goal 완료를 만들 수 없으며 deterministic verifier가 필요하다.

## Unknown 처리

다음은 `unknown`이다.

- verifier가 실행되지 않음
- timeout 또는 환경 불가
- driver/health check/evidence 누락
- 외부 상태가 ODD에서 허용되지 않음
- malformed 또는 unsupported verifier

unknown criterion이 남으면 controller는 계속 평가하거나 blocked/escalated 상태로 종료할 수 있지만 completed로 종료하지 않는다.

## Recovery와 escalation

`verification_failure`, `environment_failure`, `model_output_invalid`, `timeout`, `repeated_failure`, `scope_violation`, `permission_blocked`를 구분한다. 같은 task/failure/patch를 반복하지 않도록 signature와 stagnation을 기록한다. recovery model이 capability 요건을 만족하지 못하면 escalation한다. 사람에게 제공할 정보는 마지막 task, failure category, verifier evidence, scope, token/cycle budget이다.

## Resume

Goal Session은 atomic JSON state, JSONL event, lock, checkpoint를 사용한다. pause 후 resume 시 checkpoint tracked file이 변했으면 `requires_verification`을 true로 하고 검증 전 작업을 허용하지 않는다. corrupt state, workspace mismatch, concurrent lock은 fail closed한다.

## Release 운영 점검

다음 명령을 실행한다.

```text
npm test
npm run lint
npm run typecheck
npm run test:packed-install
```

각 결과에서 기존 worktree 오류와 이번 변경 오류를 분리한다. 외부 service, cloud, production database, browser 자동화는 기본 benchmark와 회귀 suite에서 실행하지 않는다.

## Unrestricted 운영 runbook

### 1. 시작 전 점검

1. 목표와 required criterion, verifier, allowed path를 확인한다.
2. 먼저 `safe` 또는 `supervised`로 read-only 관찰과 검증을 수행한다.
3. unrestricted가 정말 필요한 side effect인지 확인한다.
4. `minitok.yml`의 `goal.unrestricted.enabled`와 최소 capability allowlist를 review한다.
5. `always_blocked` (always-blocked), protected path, verifier tampering, workspace boundary 조건을 확인한다.

### 2. 명시적 실행

CLI에서는 `--mode unrestricted --confirm-unrestricted --auto-accept`와 필요한 반복 `--capability`만 전달한다. MCP에서는 `mode: "unrestricted"`, `confirm_unrestricted: true`, 필요한 `capabilities`를 전달하고 unrestricted runtime permission을 확인한다. `publish`, `deploy`, `database_mutation`, `force_push`, `tag_overwrite`, `credential_use`는 각자 별도 allowlist 항목이다.

### 3. 실행 중 확인

- preflight audit가 persistence된 뒤에만 adapter가 호출된다.
- audit persistence 실패는 adapter와 후속 task executor를 모두 차단한다.
- status 응답의 policy decision, granted/denied capability, blocker, verification result를 확인한다.
- credential 값과 raw provider/adapter response를 복사하거나 출력하지 않는다.

### 4. Pause/resume

pause 후에는 `<repository>/.minitok/goals/<goal_id>/state.json`, `events.jsonl`, `evidence/`와 기본 audit 경로 `~/.minitok/audit.jsonl` 또는 실행 시 지정한 `auditPath`의 redacted 상태를 확인한다. resume 시 unrestricted 정책을 자동 상속하지 않으므로 mode, confirmation, capability, auto-accept를 다시 제출한다. checkpoint tracked file이 바뀌었으면 read-only verifier 통과 전에는 executor를 호출하지 않는다.

### 5. 중단과 safe 복귀

위험 신호가 있으면 즉시 pause 또는 cancel하고, 새 요청은 `mode: safe`로 시작한다. unrestricted capability와 `--auto-accept`를 제거하고, 외부 target과 변경 path를 재검토한 뒤 필요하면 supervised approval로 전환한다.

### 6. 검증 범위

현재 운영 검증은 injected/mock adapter와 dry-run이다. production publish/deploy/database/SCM 호출은 실행하지 않는다. production adapter를 도입할 때도 동일한 policy resolver, integrity gate, secret redaction, preflight/final audit persistence와 rollback/observability 계약을 먼저 검증해야 한다.

## 문서화된 운영 검증 명령

```text
npm test
npm run lint
npm run typecheck
npm run typecheck:extension
npm run docs:check
npm run check:mcp-registry
npm run check:version-metadata
npm run stage2:parity
npm run test:e2e:goal
npm pack --dry-run
npm run test:packed-install
```

`stage2:parity`와 기본 E2E는 production에 접속하지 않는다. production evidence가 필요하면 별도 승인된 harness와 명시적인 live gate를 사용하고, 그 결과를 mock 검증 결과와 혼동하지 않는다.


## Phase 14: General Autonomous 운영 Runbook

### Mode 선택과 사전 조건

| mode | 운영 의미 |
| --- | --- |
| `safe` | 기본값. read/inspect/verify/dry-run만 수행 |
| `supervised` | local mutation을 operator 승인 후 수행 |
| `authorized_external` | scope·confirmation·capability·credential presence가 확인된 외부 작업 |
| `unrestricted` | 정형 목표에서 allowlist 작업을 자동 수행 |
| `unrestricted_general` | 자연어 목표를 해석하고 criteria, 의존성, Plan, 도구, blocker 대안과 replanning을 수행 |
| `always_blocked` | 모든 mode에서 차단되는 무결성 보호 작업 |

`unrestricted_general`은 기본 비활성이다. 시작 전 `goal.unrestricted_general.enabled`, 명시 mode, `confirm_unrestricted_general`, `unrestricted_general_autonomous` permission, auto-accept, capability allowlist, `max_plan_depth`/`max_replan_count`/`max_assumption_count`, audit persistence와 integrity preflight를 확인한다. 설정되지 않은 capability는 실행하지 않는다.

### General 목표 운영 순서

1. 목표를 자연어 그대로 기록하고 repository scope를 확인한다.
2. explicit requirement와 inferred requirement를 구분한다.
3. assumptions, confidence, provisional criteria와 invalidation signal을 기록한다.
4. dependency DAG와 각 step의 verifier/rollback을 확인한다.
5. safe read-only observation을 먼저 수행한다.
6. 현재 mode와 capability에서 실행 가능한 step만 실행한다.
7. 결과 evidence를 수집하고 blocker category를 분류한다.
8. 대안을 risk, side effect, permission, cost, reversibility, verification으로 비교한다.
9. 선택 후 verifier를 실행하고 실패하면 plan version을 증가시켜 replanning한다.
10. completed, blocked, escalated, clarification_required, unknown을 구분해 종료한다.

모델이 만든 inferred requirement나 provisional criterion은 사용자 요구와 동등하지 않다. 모호하거나 관찰할 verifier가 없는 목표는 clarification/unsupported로 멈추고, scope 밖 후보는 실행하지 않는다.

### Blocker, rollback, resume

동일 task/failure/patch의 반복은 중단한다. 현재 policy에서 실행 가능한 최소 위험 대안만 자동 선택하고, external/approval 대안은 operator에게 `approval_required`와 `resume_action`을 제공한다. always-blocked 작업은 대안으로 우회하지 않는다.

mutation 전 checkpoint와 rollback plan을 저장한다. rollback 실패, verifier 미실행, timeout, 환경 불가, evidence 누락은 completed가 아니다. resume 시 checkpoint 이후 tracked file 변경 여부를 확인하고, 변경되었으면 read-only verifier 통과 전 executor를 호출하지 않는다. 이전 unrestricted/general 권한은 자동 상속하지 않으며 새 요청에서 mode, confirmation, capability, runtime permission과 auto-accept를 재확인한다.

### Capability와 항상 차단되는 작업

General planning capability는 `goal_inference`, `criteria_inference`, `plan_expansion`, `replanning`, `tool_discovery`다. side-effect capability는 `workspace_write`, `external_call`, `credential_use`, `publish`, `deploy`, `database_mutation`, `force_push`, `tag_overwrite`이며 각각 독립 allowlist다.

path traversal, workspace 경계 탈출, dangerous object key, protected path 또는 verifier tampering, approval bypass, private key/credential/password/token 원문 노출과 secret logging은 `always_blocked`다. 권한이 높아도 실행하지 않고 evidence와 escalation만 남긴다.

### Audit와 완료 판정

다음 evidence를 확인한다.

```text
<repository>/.minitok/goals/<goal_id>/goal.json
<repository>/.minitok/goals/<goal_id>/state.json
<repository>/.minitok/goals/<goal_id>/events.jsonl
<repository>/.minitok/goals/<goal_id>/checkpoints/
<repository>/.minitok/goals/<goal_id>/evidence/
~/.minitok/audit.jsonl
```

`completed`는 모든 required criterion에 대해 실행된 valid verifier evidence와 evaluator 판정이 있을 때만 인정한다. 모델의 `done`, `completed`, `APPROVE`, approval 기록 또는 capability grant만으로 완료하지 않는다. audit에는 안전한 path/target, policy decision, capability, verification/final outcome만 저장하며 credential 값, private key, authorization header, password, token, URL query/userinfo와 raw adapter response는 redaction한다.

### Benchmark와 production

Phase benchmark와 mock/injected E2E는 deterministic local contract, evaluator, redaction, policy 경계를 검증한다. production publish/deploy/database/browser/SCM의 실제 성공·권한·비용·가용성·rollback은 검증하지 않는다. production adapter는 별도 승인, dry-run, live gate, observability, credential 운영과 rollback 계획을 통과해야 한다.

### 중지와 safe mode 복귀

무관한 변경, 반복 실패, 예상 밖 외부 대상, redaction 누락, verifier 불일치가 보이면 즉시 pause/cancel한다. 새 CLI 요청은 `--mode safe`, MCP 요청은 `"mode": "safe"`와 빈 capability로 실행한다. `confirm_unrestricted_general`, general runtime permission, side-effect capability와 `auto-accept`를 제거하고 read-only verifier를 먼저 수행한 뒤 필요하면 supervised approval로 전환한다.

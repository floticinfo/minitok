# Goal Agent MCP 운영 가이드

## 기본 원칙

MCP Goal API의 기본 mode는 `safe`다. `unrestricted`는 기본 비활성이고 runtime permission, repository config, request confirmation, capability allowlist를 모두 통과해야 한다. CLI와 MCP는 동일한 `src/goal/execution_policy.js` resolver를 호출한다.

주요 tools:

```text
minitok_goal_start
minitok_goal_status
minitok_goal_continue
minitok_goal_pause
minitok_goal_resume
minitok_goal_cancel
```

## Unrestricted start schema 예시

```json
{
  "goal": "Update and publish the package",
  "repo": "C:\\repo",
  "mode": "unrestricted",
  "confirm_unrestricted": true,
  "capabilities": ["workspace_write", "publish"]
}
```

MCP runtime은 다음 permission을 별도로 확인한다.

```text
write
unrestricted_autonomous
auto_accept
```

`unrestricted_autonomous`가 없으면 `UNRESTRICTED_PERMISSION_DENIED`, confirmation이 없으면 `UNRESTRICTED_CONFIRMATION_REQUIRED`로 거부한다. 설정 allowlist 밖 capability, credential presence 누락, integrity violation과 always-blocked operation도 실행하지 않는다.

## Capability allowlist

```text
workspace_write
external_call
credential_use
publish
deploy
database_mutation
force_push
tag_overwrite
```

이 목록의 각 항목은 독립적인 capability다. `publish`를 요청했다고 deploy나 database mutation이 허용되지 않는다. `always_blocked`는 unrestricted에서도 차단되며, path traversal, workspace 경계 탈출, dangerous object key, protected path 변경, 실행 파일/verifier tampering, private key/secret logging이 포함된다.

## Status와 response

```json
{
  "goal_id": "goal_123",
  "state": "running",
  "execution_mode": "unrestricted",
  "requested_capabilities": ["workspace_write", "publish"],
  "granted_capabilities": ["workspace_write", "publish"],
  "denied_capabilities": [],
  "policy_decision": "allowed",
  "audit_id": "audit-0123456789abcdef",
  "approval_required": false
}
```

기존 response field는 유지된다. `blocker`, `alternatives`, `recommended_action`, `resume_action`, `verification_required`, `execution_audits`, `execution_audit_refs`도 함께 확인한다. MCP 응답과 evidence에는 credential 값, private key 원문, authorization header, password, token, URL query/userinfo가 나타나지 않아야 한다.

## Pause/Resume

```json
{
  "goal_id": "goal_123",
  "repo": "C:\\repo",
  "mode": "unrestricted",
  "confirm_unrestricted": true,
  "capabilities": ["workspace_write", "publish"]
}
```

continue/resume에서도 unrestricted 요청을 새로 제출해야 한다. 저장된 session policy를 읽는 것만으로 unrestricted permission을 회복하지 않는다. checkpoint tracked file이 변경되면 `verification_required`가 유지되고 read-only verifier를 통과하기 전에는 executor가 호출되지 않는다.

safe로 복귀하려면 새 continue/resume 요청에서 `"mode": "safe"`를 사용하고 capabilities, unrestricted confirmation, auto-accept permission을 제거한다.

## Audit evidence

기본 audit 위치는 `~/.minitok/audit.jsonl`이며, injected/internal 실행과 테스트에서는 지정한 `auditPath`로 repository-local 경로를 사용할 수 있다.

```text
~/.minitok/audit.jsonl
<repository>/.minitok/goals/<goal_id>/state.json
<repository>/.minitok/goals/<goal_id>/events.jsonl
```

risk operation은 preflight audit persistence 이후에만 injected adapter가 실행된다. final audit persistence가 실패하면 작업과 후속 task executor를 fail-closed한다. audit는 operation, policy decision, capability 목록, 안전한 상대 path, 외부 target의 protocol/hostname/port/pathname, credential presence boolean, verification/final outcome만 보존한다.

## Mock 검증과 production 검증

현재 Goal MCP unrestricted 실행은 injected/mock adapter 계약을 검증한다. `stage2:parity`, 기본 E2E와 packed-install은 local contract/mock 검증이며 production registry, cloud, database, browser, SCM에 접속하지 않는다. production adapter를 연결하려면 동일한 policy resolver, runtime permission, integrity gate, redaction, preflight/final audit와 rollback 계획을 별도 승인 단계에서 검증해야 한다.

unrestricted를 사용하면 설정된 side effect가 승인 대기 없이 실행될 수 있으므로 좁은 repository scope와 최소 capability로 시작하고, 불확실하면 safe 또는 supervised로 되돌린다.

## 자동 Nunchi MCP goal 통합

`minitok_goal_start`, `minitok_goal_continue`, `minitok_goal_resume`는 CLI와 같은 shared `prepareGoalExecution` 경계를 사용한다.

```text
MCP args
→ argument/schema validation
→ compile input
→ prepareGoalExecution
→ GoalPlan/expansion + repository ODD
→ MCP capability와 expansion capability를 합친 policy resolver
→ persistent Goal Session
→ GoalController({ goalPlan, goalExpansion })
```

MCP schema는 `mode`, `confirm_unrestricted`, `capabilities`, `goal_spec`, `success_criteria`, `repository_context`, `environment_state`를 지원하며 `additionalProperties: false`로 알 수 없는 필드를 거부한다.

### Required/optional와 clarification

`required: true` inferred step은 원래 required success criterion과 연결되어 GoalPlan/session에 저장되고 controller가 먼저 실행한다. `required: false` optional follow-up은 별도 `optional_steps`로 반환되며 보통 `deferred`다. ODD 밖 후보는 Plan에 넣지 않고 `out_of_scope_candidates`로 기록한다.

성공 조건 또는 verifier가 없거나 목표가 모호하면 `clarification_required` response를 반환한다. 질문과 `missing_information`을 제공하며 임의의 완료 기준을 만들지 않고 session/executor를 시작하지 않는다.

### Response additive fields

기존 MCP 응답과 blocker/recovery/policy/audit field는 유지된다. 다음 field가 추가된다.

```json
{
  "goal_plan": {},
  "inferred_steps": [],
  "optional_steps": [],
  "requested_capabilities": [],
  "granted_capabilities": [],
  "denied_capabilities": [],
  "execution_mode": "safe",
  "policy_decision": "allowed",
  "requires_user_confirmation": false,
  "questions": [],
  "missing_information": [],
  "out_of_scope_candidates": [],
  "blocker": null,
  "alternatives": [],
  "recommended_action": null,
  "resume_action": null
}
```

### Unrestricted와 resume

unrestricted는 다음 교집합을 모두 통과해야 한다.

```text
mode=unrestricted
+ confirm_unrestricted=true
+ runtime permission: unrestricted_autonomous
+ runtime permission: auto_accept
+ config capability allowlist
+ capability validation
+ integrity/always_blocked checks
+ audit persistence
```

기존 오류 코드는 유지된다.

```text
UNRESTRICTED_PERMISSION_DENIED
UNRESTRICTED_CONFIRMATION_REQUIRED
ALWAYS_BLOCKED
EXECUTION_POLICY_DENIED
```

continue/resume은 저장된 GoalPlan을 재사용하여 duplicate expansion을 피하지만 unrestricted policy를 자동 상속하지 않는다. 새 요청의 mode/confirmation/capability/permission을 다시 확인하고 checkpoint 변경 시 read-only verifier 전에는 executor를 호출하지 않는다.

### Blocker, session, mock/live

inferred step failure는 기존 BlockerReport → AlternativePlan → policy/capability → recovery 또는 approval/escalation 흐름을 사용한다. safe 대안만 자동 선택하며 외부 side effect/permission 대안은 approval request와 resume action으로 반환된다. session은 `<repository>/.minitok/goals/<goal_id>/`에, redacted audit는 `~/.minitok/audit.jsonl`에 저장된다.

`stage2:parity`, 기본 E2E, packed-install과 injected/mock adapter는 local contract 검증이며 production registry/cloud/database/browser/SCM에 접속하지 않는다. live production 검증은 별도 승인된 integration harness와 rollback 계획이 필요하다.


## Phase 11: MCP General Agent 계약

> 이 문서는 현재 검증된 `unrestricted_general` 경계만 설명한다. 이 mode는 임의 작업을 무제한으로 수행하거나 안전 검사를 우회하는 기능이 아니다.

### Mode와 명시적 활성화

MCP 기본 mode는 `safe`다. `supervised`는 local mutation 승인, `authorized_external`은 승인된 external adapter, `unrestricted`는 정형 목표의 allowlist 실행, `unrestricted_general`은 자연어 목표의 general loop, `always_blocked`는 영구 차단을 뜻한다.

`unrestricted_general`은 기본 비활성이다. 요청은 `mode: "unrestricted_general"`와 `confirm_unrestricted_general: true`를 포함해야 하며 runtime permission `unrestricted_general_autonomous`, `auto_accept`, repository `goal.unrestricted_general.enabled`, general capability allowlist, `max_plan_depth`/`max_replan_count`/`max_assumption_count` budget, audit persistence와 integrity preflight가 모두 필요하다. `unrestricted_autonomous` permission이나 `confirm_unrestricted`만으로 general mode를 활성화하지 않는다. MCP argument schema의 알 수 없는 필드는 거부한다.

```json
{
  "goal": "Make the service production-ready",
  "repo": "C:\\repo",
  "mode": "unrestricted_general",
  "confirm_unrestricted_general": true,
  "capabilities": [
    "goal_inference",
    "criteria_inference",
    "plan_expansion",
    "replanning",
    "tool_discovery",
    "workspace_write"
  ]
}
```

### 자연어 해석 response

MCP는 다음 흐름을 사용한다.

```text
goal
→ intent/범위 해석
→ explicit requirement 추출
→ inferred requirement/dependency
→ assumptions와 provisional criteria
→ Plan DAG/verifier 후보
→ 관찰·실행
→ blocker/alternative
→ replanning
→ evaluator evidence 또는 escalation
```

explicit requirement는 사용자가 직접 준 계약이고, inferred requirement는 rationale·target criterion·verification이 있는 필수 연관 작업이다. optional follow-up은 `optional_steps`와 `deferred`로 분리한다. 목표가 추상적이거나 대상·범위·완료 결과·검증 방법이 모호하거나 deterministic verifier가 없으면 `clarification_required`/`unsupported`로 반환하고 executor를 시작하지 않는다. provisional criteria는 추론된 후보일 뿐 사용자 확인을 대체하지 않으며 완료 근거가 될 수 없다. `goal_plan`, `inferred_steps`, `assumptions`, `provisional_success_criteria`, `replanning_trace`, `out_of_scope_candidates`를 응답에서 확인한다.

### Capability, blocker, rollback/resume

General capability(`goal_inference`, `criteria_inference`, `plan_expansion`, `replanning`, `tool_discovery`)와 side-effect capability(`workspace_write`, `external_call`, `credential_use`, `publish`, `deploy`, `database_mutation`, `force_push`, `tag_overwrite`)는 독립 allowlist다. path traversal, workspace escape, dangerous object key, protected path/verifier tampering, approval bypass, private key·credential·password·token 원문 및 secret logging은 `always_blocked`다.

blocker는 risk, benefit, permission, cost, reversibility와 verification을 비교해 현재 policy에서 가능한 최소 위험 대안을 선택한다. 외부/승인 대안은 실행하지 않고 `approval_required`, `alternatives`, `resume_action`으로 반환한다. replanning은 blocker, verifier failure 또는 assumption invalidation 후 plan version과 evidence를 남긴다. mutation 전 rollback plan/checkpoint를 만들며 rollback failure는 completed가 아니다.

continue/resume은 저장된 general permission을 자동 상속하지 않는다. 새 요청에서 mode, `confirm_unrestricted_general`, capabilities, runtime permission과 auto-accept를 재확인한다. checkpoint 변경 시 read-only verifier가 통과하기 전에는 executor를 호출하지 않는다. 완료는 required criterion의 실행된 valid evidence와 evaluator 판정으로만 결정하며 모델의 `done`, `completed`, `APPROVE`는 권한이 아니다.

### Audit와 production 한계

세션은 `<repository>/.minitok/goals/<goal_id>/`에, audit는 기본 `~/.minitok/audit.jsonl`에 redacted 형태로 저장한다. MCP response/evidence에는 credential 값, private key, authorization header, password, token, URL query/userinfo와 raw adapter response를 포함하지 않는다.

Registry가 아는 adapter kind는 `filesystem`, `shell`, `repository`, `test_runner`, `package_manager`, `local_http`, `process_health`, `browser`, `api`, `database_read_only`, `database_mutation`, `deployment`, `publish`, `scm`이다. descriptor는 injected executor와 verifier evidence 계약을 표현할 뿐 자동으로 live 연결을 만들지 않는다. `api`, `database_mutation`, `deployment`, `publish`, `scm`은 authorized-external 정책과 별도 gate가 필요하다. benchmark, `stage2:parity`, mock/injected adapter와 E2E는 local 계약 검증이다. production registry/cloud/database/browser/SCM의 성공, 권한, 비용, 가용성, rollback을 증명하지 않으며 live 연결은 별도 승인 harness와 rollback 계획이 필요하다. 모델이 만든 provisional criteria가 실제 의도와 다를 수 있으므로 모호한 목표는 clarification 또는 supervised로 낮춘다.

위험하면 pause/cancel 후 다음처럼 safe로 되돌린다.

```json
{
  "goal_id": "goal_123",
  "mode": "safe",
  "capabilities": []
}
```

general confirmation, runtime permission, side-effect capability와 auto-accept를 제거한 새 요청이어야 한다.

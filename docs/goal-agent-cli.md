# Goal Agent CLI 운영 가이드

## 기본 원칙

Goal CLI의 기본 mode는 `safe`다. unrestricted는 기본 비활성이고, repository 설정과 사용자의 명시적 요청이 모두 있어야 한다. `--auto-accept`만으로 unrestricted가 활성화되지 않으며, 기존 `--explicit-confirmation`은 backward-compatible alias다.

정책 resolver는 `src/goal/execution_policy.js` 하나를 사용한다. CLI는 resolver 결과를 JSON 응답의 `execution_mode`, `requested_capabilities`, `granted_capabilities`, `denied_capabilities`, `policy_decision`, `audit_id`로 노출한다.

## 설정과 capability allowlist

```yaml
# <repository>/minitok.yml
goal:
  unrestricted:
    enabled: true
    capabilities:
      - workspace_write
      - external_call
      - publish
    require_explicit_confirmation: true
    require_auto_accept: true
```

지원 operation capability는 다음과 같다.

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

각 capability는 독립적으로 allowlist되어야 한다. 예를 들어 `publish`를 허용해도 `deploy`나 `force_push`는 허용되지 않는다. path traversal, workspace escape, dangerous object key, protected path/verifier tampering, secret/private-key logging과 `always_blocked` (always-blocked) operation은 capability와 무관하게 차단된다.

## Safe 시작

```text
minitok goal start "Inspect the repository and verify tests" --repo <repository>
```

mode를 생략하면 `safe`다. safe에서는 read/inspect/verify/dry-run 범위만 자동 실행하며 workspace write와 외부 side effect는 executor 경계에서 차단하거나 approval request로 반환한다.

## Supervised 시작

```text
minitok goal start "Update the workspace implementation" --repo <repository> \
  --mode supervised \
  --capability workspace_write
```

승인 전에는 workspace write executor가 호출되지 않는다. status 응답의 `approval_required`, `approval_requests`, `resume_action`을 확인한 뒤 operator 승인 절차를 진행한다.

## Unrestricted 시작

```text
minitok goal start "Update and publish the package" --repo <repository> \
  --mode unrestricted \
  --confirm-unrestricted \
  --capability workspace_write \
  --capability publish \
  --auto-accept
```

필수 조건:

1. `--mode unrestricted`가 명시되어야 한다.
2. `--confirm-unrestricted`가 필요하다.
3. 각 capability가 `minitok.yml` allowlist에 있어야 한다.
4. 설정이 요구하는 `--auto-accept`를 전달해야 한다.
5. credential operation이면 credential presence가 확인되어야 한다.
6. integrity와 audit preflight persistence가 성공해야 한다.

`--capabilities workspace_write,publish` comma-list도 지원한다. 최소 권한 운영에서는 반복 `--capability`를 권장한다.

## Status와 audit

```text
minitok goal status --repo <repository> --goal-id <goal_id> --json
```

기본 append-only audit evidence는 `~/.minitok/audit.jsonl`에 있다. injected/internal 실행과 테스트에서는 `auditPath`를 지정해 repository-local 경로를 사용할 수 있다.

```text
~/.minitok/audit.jsonl
<repository>/.minitok/goals/<goal_id>/state.json
<repository>/.minitok/goals/<goal_id>/events.jsonl
<repository>/.minitok/goals/<goal_id>/evidence/
```

audit에는 capability decision, operation, 안전한 상대 경로, 외부 target의 protocol/hostname/port/pathname, credential presence boolean, verification result와 final outcome만 남는다. URL query/fragment/userinfo, credential 값, private key 원문, authorization header, password, token과 raw adapter response는 기록하지 않는다.

## Continue/Resume 재확인

이전 unrestricted session은 자동으로 unrestricted로 재개되지 않는다.

```text
minitok goal resume --repo <repository> --goal-id <goal_id> \
  --mode unrestricted \
  --confirm-unrestricted \
  --capability workspace_write \
  --capability publish \
  --auto-accept
```

`--mode unrestricted` 또는 `--confirm-unrestricted`가 누락되면 resume 전에 policy denial이 반환된다. checkpoint 이후 tracked file이 바뀌면 read-only verifier를 먼저 실행해야 하며, 검증 전 task executor가 호출되지 않는다.

## Safe 복귀와 위험

안전하게 복귀하려면 새 요청에 다음처럼 전달한다.

```text
minitok goal continue --repo <repository> --goal-id <goal_id> --mode safe
```

unrestricted capability와 `--auto-accept`를 제거한다. unrestricted는 allowlisted 파일 변경, 외부 호출, publish/deploy 및 기타 mutation을 승인 대기 없이 실행할 수 있으므로 데이터 손실, 비용 발생, 배포, branch history 변경 위험이 있다. 실제 production publish/deploy는 이 문서의 mock/injected 검증으로 대체되지 않으며 별도 승인된 integration 단계가 필요하다.

## 자동 Nunchi goal 통합

일반 CLI goal은 다음 공통 흐름으로 처리된다.

```text
objective/goal_spec
→ compileGoal 또는 compileModelGoal
→ prepareGoalExecution
→ GoalPlan + goalExpansion
→ expansion capability와 CLI capability를 합친 policy resolver
→ Goal Session 저장
→ GoalController 실행
```

대상 명령은 `goal start`, `goal continue`, `goal resume`다. 명시적인 세부 단계를 입력하지 않아도 required inferred step이 `target_criteria`로 원래 success criterion에 연결되어 제안된다.

### Required와 optional

- `required: true` inferred step은 목표 완료에 필요한 작업이며 `GoalPlan.inferred_steps`와 session state에 저장된다.
- `required: false` follow-up은 `optional_steps`로 분리되고 일반적으로 `deferred`다. publication/tag 확인이나 문서 보강처럼 목표에 도움이 되더라도 safe mode에서 자동 실행되지 않는다.
- ODD 밖 후보는 자동 실행·Plan 추가에서 제외하고 `out_of_scope_candidates`로 반환한다.

### Clarification

`success_criteria` 또는 verifier가 없거나 자연어 목표가 deterministic completion contract로 해석되지 않으면 `clarification_required`를 반환한다. 임의 verifier를 만들지 않으며 session과 executor를 만들지 않는다. JSON 응답에는 `questions`, `missing_information`, `requires_user_confirmation`이 포함될 수 있다.

### JSON additive response

기존 CLI response는 유지되며 다음 field가 추가될 수 있다.

```text
goal_plan
inferred_steps
optional_steps
requested_capabilities
granted_capabilities
denied_capabilities
execution_mode
policy_decision
questions
missing_information
requires_user_confirmation
out_of_scope_candidates
blocker
alternatives
recommended_action
resume_action
execution_audits
```

`goal status`에서도 persisted GoalPlan과 expansion metadata를 확인할 수 있다.

### Continue/resume

continue/resume은 저장된 `state.goal_plan`과 expansion history를 재사용하므로 동일 목표를 다시 확장하지 않는다. 이전 unrestricted mode를 자동 상속하지 않으며 새 요청에서 mode, `--confirm-unrestricted`, capability, 필요한 `--auto-accept`와 config allowlist를 다시 검사한다. checkpoint 이후 tracked file 변경 시 read-only verifier가 통과하기 전 executor를 호출하지 않는다.

### Blocker와 검증 범위

inferred step failure는 기존 BlockerReport, AlternativePlan, recovery 정책을 사용한다. safe alternative만 자동 선택하며 approval이 필요한 변경/외부 작업은 approval request와 resume action으로 멈춘다. always-blocked operation은 모든 mode에서 escalation된다.

세션은 `<repository>/.minitok/goals/<goal_id>/`에, 일반 audit는 `~/.minitok/audit.jsonl`에 redacted 형태로 저장된다. `stage2:parity`, mock/injected E2E와 packed-install은 local contract 검증이며 실제 production publish/deploy를 검증하지 않는다. live production 검증은 별도 승인된 harness가 필요하다.


## Phase 14: 자연어 General Agent CLI

### Mode 선택

CLI의 기본 mode는 계속 `safe`다. mode별 의미는 다음과 같다.

- `safe`: read/inspect/verify/dry-run. write와 external side effect는 실행하지 않는다.
- `supervised`: workspace/local mutation을 approval 후 실행한다.
- `authorized_external`: 명시 confirmation, scope, capability와 credential presence가 있는 외부 작업만 실행한다.
- `unrestricted`: 기존 정형 목표에서 allowlist된 capability를 자동 실행한다.
- `unrestricted_general`: 자연어 목표를 해석하고 criteria, dependency, Plan DAG, 도구 관찰, blocker 대안과 replanning을 추론한다.
- `always_blocked`: 어떤 mode에서도 실행하지 않는 시스템 무결성 작업이다.

`unrestricted_general`은 기본 비활성이다. repository 설정의 `goal.unrestricted_general.enabled: true`, `--mode unrestricted_general`, `--confirm-unrestricted-general`, `--allow-unrestricted-general`, `--auto-accept`, general capability allowlist와 budget이 모두 필요하다. 설정이 요구하지 않는 flag라도 명시적 confirmation과 runtime gate가 없으면 거부된다.

### 자연어 목표 처리

```text
objective
→ intent/범위 해석
→ explicit requirement와 inferred requirement 구분
→ assumptions/provisional criteria 기록
→ Plan DAG와 verifier 후보 생성
→ 관찰/실행
→ blocker/AlternativePlan
→ replanning
→ verifier evidence 또는 escalation
```

명시된 요구는 `explicit_steps`/기준으로, 필요한 연관 작업은 rationale과 `target_criteria`를 가진 `inferred_steps`로 저장한다. optional follow-up은 자동 완료와 분리해 deferred로 남긴다. scope 밖 작업은 `out_of_scope_candidates`로 반환한다. 성공 기준 또는 verifier를 결정적으로 만들 수 없으면 `clarification_required`이며 임의 기준으로 완료하지 않는다.

### General start 예시

```text
minitok goal start "Make the service production-ready" --repo <repository> \
  --mode unrestricted_general \
  --confirm-unrestricted-general \
  --allow-unrestricted-general \
  --capability goal_inference \
  --capability criteria_inference \
  --capability plan_expansion \
  --capability replanning \
  --capability tool_discovery \
  --capability workspace_write \
  --auto-accept --json
```

상태와 계획을 확인한다.

```text
minitok goal status --repo <repository> --goal-id <goal_id> --json
minitok goal continue --repo <repository> --goal-id <goal_id> --mode safe --json
minitok goal resume --repo <repository> --goal-id <goal_id> --mode safe --json
```

`goal_plan`, `assumptions`, `provisional_success_criteria`, `replanning_trace`, `blocker`, `alternatives`, `verification_status`, `execution_audits`, `resume_action`을 확인한다.

### Capability와 안전

General planning capability(`goal_inference`, `criteria_inference`, `plan_expansion`, `replanning`, `tool_discovery`)와 side-effect capability(`workspace_write`, `external_call`, `credential_use`, `publish`, `deploy`, `database_mutation`, `force_push`, `tag_overwrite`)는 독립적으로 allowlist된다. 하나를 허용해도 다른 capability는 허용되지 않는다. path traversal, workspace escape, dangerous object key, protected path/verifier tampering, approval bypass, private key·credential·password·token 원문 출력과 secret logging은 `always_blocked`다.

### 완료, blocker, resume

`completed`는 required criterion의 실행된 valid verifier evidence와 독립 evaluator가 모두 확인할 때만 반환한다. 모델의 `done`, `completed`, `APPROVE`는 권한이 아니다. blocker 발생 시 benefit/risk/permission/cost/reversibility/verification을 비교해 현재 policy에서 실행 가능한 최소 위험 대안을 선택하고, 외부/승인 대안은 request와 resume action으로 멈춘다. replanning은 blocker나 assumption invalidation 후 plan version과 evidence를 남기며, 변경 전 rollback/checkpoint를 만든다.

resume은 저장된 unrestricted 정책을 자동 사용하지 않는다. 새 요청에서 mode, confirmation, capability와 auto-accept를 다시 전달해야 하고, checkpoint 이후 tracked file이 바뀌면 read-only verifier 전에는 executor를 호출하지 않는다.

### Audit, 한계와 safe 복귀

세션 evidence는 `<repository>/.minitok/goals/<goal_id>/`에, 기본 audit는 `~/.minitok/audit.jsonl`에 있다. credential 값, private key, authorization header, password, token, URL query/userinfo와 raw adapter response는 출력하거나 저장하지 않는다.

deterministic benchmark/mock 결과는 production publish/deploy/database/browser/SCM의 성공을 증명하지 않는다. 모호한 목표에서 모델이 만든 provisional criteria는 실제 사용자 의도와 다를 수 있으므로 중요한 작업은 clarification, supervised 또는 authorized_external로 낮춘다. 위험하면 즉시 pause/cancel 후 새 요청을 `--mode safe`로 실행하고 general capability, confirmation, `--auto-accept`를 제거한다.

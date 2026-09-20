# Goal-aware Nunchi Planning and Blocker Resolution

## 1. 개념

**Nunchi**는 사용자의 명시적 목표를 달성하기 위해 필요한 맥락과 의존성을 먼저 관찰하는 계획 방식이다. 시스템은 목표를 그대로 반복하지 않고 다음을 구분한다.

- 사용자가 직접 요청한 `explicit step`
- 목표 달성에 필수인 `required related` inferred step
- 목표 완료를 막지 않는 `optional follow-up` step
- 실패를 다루기 위한 `recovery` step

핵심 원칙은 다음과 같다.

> 목표를 넘어서 판단하지만, 무제한으로 행동하지 않는다.

시스템은 필요한 다음 작업과 blocker 대안을 추론할 수 있지만, 원래 목표와 무관한 작업으로 범위를 넓히거나 승인 없는 외부 side effect를 실행하지 않는다.

## 2. 목표와 단계의 범위

### Explicit step

사용자가 직접 요청했거나 이미 승인된 작업이다. 원래 목표의 직접 수행이며 GoalPlan의 `explicit_steps`에 저장된다.

### Required related step

명시 목표를 달성하기 위해 필요한 연관 작업이다. 예를 들어 릴리스 목표에는 버전 메타데이터 확인, 테스트, package dry-run이 필요할 수 있다. 이러한 단계는 `inferred_steps`에 기록하되 다음을 만족해야 한다.

- 원래 success criterion 또는 기존 단계와 연결된다.
- rationale이 있다.
- allowed path와 repository ODD 안에 있다.
- 검증 방법이 있다.
- 목표 달성에 실제로 필요해야 한다.

### Optional follow-up

문서 보강, tag/publication 확인처럼 목표에 도움이 되지만 완료에 필수는 아닌 작업이다.

- `required: false`
- 일반적으로 `status: deferred`
- 사용자가 목표만 달성하라고 했으면 자동 실행하지 않는다.
- 필요하면 제안으로만 반환한다.

## 3. GoalPlan과 Goal Session

GoalPlan은 다음 정보를 표현한다.

- objective
- explicit/inferred steps
- dependencies
- success criteria
- scope boundary
- risk level
- approval requirements
- assumptions
- execution policy

영속 Goal Session은 다음 위치에 저장된다.

```text
<repository>/.minitok/goals/<goal_id>/
├─ goal.json
├─ state.json
├─ events.jsonl
├─ checkpoints/
├─ evidence/
└─ locks/session.lock
```

state에는 원래 목표, explicit/inferred step, blocker, alternative, approval request, resolution attempt, verification result, resume provenance, final outcome이 redaction 후 저장된다. 기존 state migration은 누락 필드를 안전한 기본값으로 채운다.

## 4. Blocker와 AlternativePlan

실패는 단순한 `failed` 문자열로 끝나지 않는다. BlockerReport에는 다음이 기록된다.

- category
- stage
- cause
- affected step
- evidence
- retryability
- permission/external access/user decision 여부
- alternatives
- recommended alternative
- terminal reason

지원 category:

```text
environment_failure
network_failure
authentication_failure
permission_blocked
verification_failure
dependency_failure
metadata_mismatch
external_service_failure
timeout
scope_violation
unknown
```

AlternativePlan은 다음을 비교한다.

- expected benefit
- risk level
- side effects
- required permissions
- estimated cost
- reversibility
- verification plan
- execution policy
- approval requirement

대안을 적용할 수 없으면 대안이 없는 이유, 필요한 외부 조치, credential 값 없는 사용자 명령, 재개 조건을 기록한다.

## 5. Execution policy

### `safe`

자동 실행 가능 범위:

- 읽기와 분석
- local test/lint/typecheck
- read-only inspection
- dry-run
- 외부 side effect 없는 검증

### `supervised`

다음 작업은 사용자 승인이 필요하다.

- workspace 파일 변경
- branch/PR 생성
- 기타 local mutation

승인 전에는 write를 실행하지 않고 approval request와 resume action만 반환한다.

### `authorized_external`

다음 작업은 명시적 승인과 필요한 credential 존재 확인이 필요하다.

- npm publish
- MCP Registry publish
- 외부 API mutation
- cloud/deployment
- credential 사용
- database mutation

credential 값은 수집하거나 로그에 남기지 않는다.


## 6. Phase 0 정책 경계와 목표 계약

Phase 0에서는 현재 동작을 보존하면서 실행 정책의 의미를 다음처럼 고정한다. `safe`가 명시되지 않은 기존 호출의 유효한 기본값이며, 이 문서의 목표 모드는 다음 Phase에서 단일 resolver로 적용한다.

### 정책 매트릭스

| mode | 기본/opt-in | workspace 변경 | 외부 호출·publish·deploy | credential 사용 | database mutation | approval state | 비고 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `safe` | 기본값 | 차단 또는 읽기 전용 | 차단 | 차단 | 차단 | `approval_required` | 기존 기본 동작을 그대로 유지한다. |
| `supervised` | 명시 선택 | 승인 후 허용 | 승인과 capability가 필요 | 승인과 capability가 필요 | 승인과 capability가 필요 | `approval_required` | 승인 전에는 실행하지 않고 request/resume만 반환한다. |
| `authorized_external` | 기존 명시 정책 | 승인과 scope가 필요 | 승인과 scope가 필요 | 값은 전달할 수 있으나 기록하지 않는다 | 승인과 scope가 필요 | `approval_required` | 기존 외부 side-effect 계약을 유지한다. |
| `unrestricted` | 사용자 명시적 opt-in만 허용 | 설정된 workspace 범위에서 자동 실행 가능 | 설정된 범위에서 자동 실행 가능 | 설정된 capability가 있을 때만 사용 | 설정된 범위에서 자동 실행 가능 | `not_requested` 또는 resolver가 기록한 명시적 opt-in | `auto_accept` 하나만으로 활성화되지 않으며, 항상 무결성 보호를 통과해야 한다. |
| `always_blocked` | 정책 고정 | 불가 | 불가 | 불가 | 불가 | 어떤 approval도 우회하지 못함 | `never_autonomous`의 영구 차단 의미를 이 범주로 이동한다. |
| `approval_required` | capability 상태 | 현재 mode에 따라 승인 필요 | 현재 mode에 따라 승인 필요 | 값 비노출 | 현재 mode에 따라 승인 필요 | 승인 대기 | 실행 mode가 아니라 side-effect의 approval 상태다. |

`never_autonomous`는 기존 API와 저장된 GoalPlan의 backward-compatible 입력으로 당분간 인식할 수 있지만, 새로운 정책 모델에서는 다음처럼 해석한다.

- 영구적으로 금지된 작업은 canonical policy `always_blocked`로 분류한다.
- 단순히 현재 mode에서 승인 대기인 작업은 `approval_required`로 분류한다.
- 명시적 사용자 권한과 설정된 capability가 있으면 `unrestricted`에서 자동 실행할 수 있는 작업은 `always_blocked`로 분류하지 않는다.
- private key 원문/secret 출력, approval 우회, 검증기·실행 파일 변조, workspace 경계 탈출 등은 `unrestricted`에서도 `always_blocked`다.

### mode, capability, approval의 관계

실행 허용은 다음 세 입력의 교집합으로 결정한다.

1. **mode**: `safe`, `supervised`, `authorized_external`, `unrestricted` 중 호출자가 요청한 실행 수준. 누락되거나 잘못된 값은 `safe`로 처리한다.
2. **capability**: workspace write, external call, credential use, publish, deploy, database mutation 등 실제 side-effect별로 설정된 권한과 범위.
3. **approval state**: `not_requested`, `approval_required`, `approved`, `denied` 등 해당 작업의 승인 상태.

공통 resolver는 먼저 위험 분류와 `always_blocked`를 판정하고, workspace/scope/무결성 검사를 수행한 뒤 mode와 capability를 결합한다. 따라서 `unrestricted`는 approval을 자동 충족할 수 있지만, 경로 traversal, dangerous object key, protected path, 실행 파일·검증기 변조, credential 원문 노출 보호를 약화시키지 않는다. CLI와 MCP는 같은 resolver 결과를 사용하고, extension runtime도 동일한 mode vocabulary와 결과 필드를 사용해야 한다.

### 명시적 unrestricted opt-in

`unrestricted`는 다음 조건을 모두 만족할 때만 활성화한다.

- CLI flag/config 또는 MCP argument로 mode가 명시되었다.
- 호출 주체가 unrestricted capability에 해당하는 명시적 권한을 보유한다.
- workspace root와 허용 범위가 검증되었다.
- 작업이 `always_blocked`가 아니다.
- resolver가 계산한 side-effect capability가 설정으로 허용되었다.

기본값, 누락된 mode, legacy `autonomous` 입력, 단순 `auto_accept` flag만으로는 unrestricted가 활성화되지 않는다. legacy 동작은 별도 compatibility adapter를 통해 기존 계약을 유지하되, 새 unrestricted 권한을 암묵적으로 부여하지 않는다.

### 민감정보 및 무결성 보호

credential 값, private key 원문, authorization header, password, token 및 provider 원문 출력은 로그, evidence, session state, CLI 출력, MCP 응답에 기록하지 않는다. 저장·반환 전 redaction을 적용하고, 필요한 경우 존재 여부·종류·검증 결과 같은 비밀값 없는 메타데이터만 남긴다.

다음 보호는 모든 mode에서 동일하게 유지한다.

- 상대 경로 검증, path traversal 거부, workspace 경계 확인
- dangerous object key(`__proto__`, `prototype`, `constructor`) 거부
- protected path, 실행 파일/스크립트, CI/hook, verification gate 변조 방지
- validation 실패 시 즉시 현재 phase를 중단하고 다음 phase로 진행하지 않음
- 승인·권한·외부 상태를 완료 evidence로 오인하지 않음. required verifier evidence가 필요함

### Phase 1 공통 Capability Contract

실행 권한은 mode 문자열만으로 판단하지 않고, `src/goal/capabilities.js`의 공통 contract로 표현한다. extension runtime은 동일한 source 파일을 sync하여 같은 vocabulary와 metadata를 사용한다.

지원 capability는 다음과 같다.

```text
read
inspect
verify
workspace_write
local_mutation
external_call
credential_use
publish
deploy
database_mutation
force_push
tag_overwrite
protected_path_write
```

각 capability metadata는 다음을 표현한다.

- `side_effect`: 작업이 외부 또는 workspace 상태를 변경하는지
- `default_approval`: 기본적으로 사용자 승인이 필요한지
- `default_execution_policy`: `safe`, `supervised`, `authorized_external`, `always_blocked` 중 기본 정책
- `unrestricted_allowed`: 명시적 unrestricted capability에서 허용 가능한지
- `always_blocked`: 어떤 mode에서도 거부되는지
- `verification_required`: 실행 후 검증 evidence가 필요한지

`workspace_write`, `local_mutation`, `external_call`, `credential_use`, `publish`, `deploy`, `database_mutation`, `force_push`, `tag_overwrite`는 기본적으로 `approval_required`이며 명시적 unrestricted 권한이 있을 때만 resolver가 자동 승인을 검토할 수 있다. `protected_path_write`는 `always_blocked`이며 unrestricted에서도 허용하지 않는다. private key 원문 노출, credential 값·authorization header·password·token 로그 출력, approval 우회는 항상 차단되는 operation으로 분류한다.

알 수 없는 capability, 중복 capability, 빈 capability 및 dangerous object key는 fail closed한다.

### Phase 2 공통 Execution Policy Resolver

CLI, MCP, GoalController와 Blocker alternative selection은 `src/goal/execution_policy.js`의 동일 resolver를 사용한다. resolver 입력은 mode, capability grant, explicit confirmation, auto-accept, source, actor이며, 출력은 유효 mode, 허용 여부, approval-required capability, denied capability, always-blocked capability, 비밀값 없는 audit context를 포함한다.

- mode 누락은 `safe`다.
- `safe`는 read/inspect/verify만 자동 허용하고 mutation/external capability는 차단한다.
- `supervised`는 workspace/local mutation을 명시적 confirmation 후 허용한다.
- `authorized_external`은 명시적 confirmation과 필요한 credential presence 후 외부 capability를 허용한다.
- `unrestricted`는 명시 mode, explicit confirmation, auto-accept 권한, capability grant가 모두 있어야 하며 approval-required capability를 자동 진행할 수 있다.
- `always_blocked`와 unknown capability는 모든 mode에서 거부한다.
- legacy `workspace`/`autonomous`는 compatibility alias로만 처리하며 unrestricted 권한을 암묵적으로 부여하지 않는다.

resolver 결과는 session state와 blocker decision에 기록되지만 credential 값, private key, authorization header, password, token은 기록하지 않는다. mode와 resolver가 허용하더라도 path traversal, workspace 경계 탈출, protected path, 실행 파일/검증기 변조 방지는 별도 무결성 계층에서 계속 적용한다.

### Phase 3 unrestricted 설정

설정은 다음 우선순위를 따른다.

```text
built-in defaults → global config → repository-local minitok.yml → environment → CLI/MCP request
```

기본 설정은 다음과 같다.

```yaml
goal:
  default_mode: safe
  unrestricted:
    enabled: false
    require_explicit_confirmation: true
    require_auto_accept: true
    capabilities: []
```

`unrestricted`는 설정 파일에서 `enabled: true`이고, 요청 capability가 allowlist에 포함되며, resolver가 요구하는 explicit confirmation과 auto-accept 조건을 만족할 때만 허용된다. 설정이 없거나 `enabled: false`이면 unrestricted는 거부된다. `protected_path_write` 등 always-blocked capability는 allowlist에 포함할 수 없으며 설정 validation이 실패한다.

설정 오류는 fail-closed한다. repository-local 설정은 global 설정을 덮어쓰며, 환경 변수와 CLI/MCP 요청은 설정 이후에 적용되지만 unrestricted를 암묵적으로 활성화하지 않는다. 설정을 출력하거나 policy denial을 반환할 때는 `redactGoalExecutionConfig` projection만 사용하며 provider credential, token, password, private key 원문은 반환하지 않는다.

### CLI/MCP/runtime parity

정책 구현 phase에서는 다음 parity를 검증한다.

- CLI Goal, MCP Goal, legacy `minitok_run`이 동일한 resolver를 호출한다.
- 응답에는 요청 mode, 유효 mode, approval state, capability decision, blocked reason을 비밀값 없이 일관된 필드로 포함한다.
- extension runtime은 source runtime과 같은 mode 목록, 기본값, 차단 사유, redaction 계약을 유지한다.
- 기존 CLI/MCP 필드와 오류 코드는 additive하게 보존하고, 기본 safe 동작을 변경하지 않는다.

### CLI unrestricted 명시 활성화

Goal CLI의 기본 실행은 계속 `safe`이다. unrestricted는 다음 조건을 명시적으로 전달해야 한다.

```text
minitok goal start "<objective>" \
  --mode unrestricted \
  --confirm-unrestricted \
  --capability workspace_write \
  --capability external_call \
  --capability publish \
  --auto-accept
```

`--capability`는 반복 입력할 수 있으며, 기존 `--capabilities a,b,c` 형식도 backward compatible하게 유지한다. `--confirm-unrestricted`가 없으면 unrestricted는 session을 만들기 전에 거부된다. `--auto-accept`는 unrestricted 요청에서만 유효하며, safe/supervised/authorized_external 요청에서는 거부된다. 설정의 unrestricted allowlist와 resolver 조건을 만족하지 못하면 CLI는 fail closed한다.

unrestricted를 사용하는 human-readable CLI 출력은 stderr에 경고를 표시하며 JSON stdout을 오염시키지 않는다. `--json` 응답은 다음 정책 필드를 additive하게 포함한다.

```text
execution_mode
requested_capabilities
granted_capabilities
denied_capabilities
policy_decision
audit_id
```

`goal continue`와 `goal resume`는 이전 session의 unrestricted 상태를 자동 상속하지 않는다. 이전 session이 unrestricted였던 경우에도 새 요청에서 `--mode unrestricted`, `--confirm-unrestricted`, 필요한 `--capability`와 `--auto-accept`를 다시 전달해야 한다. 그렇지 않으면 resume 전에 정책 거부 응답을 반환한다. 일반 safe session도 기본적으로 safe mode로 계속되며, 기존 unrestricted 상태를 암묵적으로 활성화하지 않는다.

## 7. MCP workflow

장기 목표에는 다음 도구를 사용한다.

```text
minitok_goal_start
minitok_goal_status
minitok_goal_continue
minitok_goal_resume
minitok_run_get
```

기존 MCP response fields는 유지되며 다음 필드가 additive하게 제공된다.

- current_state
- blocker
- alternatives
- recommended_action
- approval_required
- resume_action
- resume_command

단일 구체 task에는 기존 `minitok_run`을 사용한다. MCP scope와 approval은 provider selection과 별개이며, provider를 선택했다고 write 또는 auto-accept 권한이 부여되지 않는다.

## 8. 중단과 Resume

중단 사유는 session state와 events에 저장된다. resume 전 다음을 확인한다.

- GoalSpec이 여전히 유효한지
- workspace가 동일한지
- checkpoint 이후 tracked file이 변경되지 않았는지
- 변경되었다면 verifier를 먼저 수행했는지
- blocker 승인이나 operator 조치가 완료되었는지
- checkpoint 이후 변경된 경우 `resume_check.requires_verification`이 해제되었는지

tracked file이 checkpoint 이후 변경되면 resume 상태는 `verification_required`로 유지되며 task executor를 호출하지 않는다. 모든 required criterion에 대해 `passed`, `valid`, `executed`인 evaluator evidence가 확인된 후에만 resume gate가 해제된다.

MCP에서는 `resume_action` 또는 `minitok_goal_resume`를 사용한다. CLI에서는 `goal resume --goal-id ...`를 사용한다. 응답에는 `verification_required`와 `resume_check`를 포함할 수 있다. resume도 완료를 보장하지 않으며 evaluator evidence가 다시 필요하다.

## 9. Evidence 확인

확인 대상:

- Goal Session `state.json`
- append-only `events.jsonl`
- evaluator `verification_results`
- blocker report와 alternative history
- approval request와 resolution attempt
- final outcome

모든 저장·응답 evidence는 token, password, API key, secret, private key, authorization header를 redaction한다. 모델의 `done`, `completed`, review `APPROVE`만으로 완료를 주장하지 않는다.

CLI에서는 다음처럼 상태와 evidence를 확인한다.

```text
minitok goal status --repo <repository> --goal-id <goal_id> --json
minitok runs show <run_id> --repo <repository> --json
```

MCP에서는 `minitok_goal_status` 또는 `minitok_run_get` 응답의 `evidence`, `blocker`, `alternatives`, `approval_requests`, `resolution_attempts`, `final_outcome`을 확인한다. 원본 로그나 provider 출력이 필요하더라도 secret 값을 복구하거나 출력하지 않으며, redacted response와 session state를 evidence의 권위 있는 표현으로 취급한다.

## 10. Backward compatibility

기존 계약은 유지된다.

- GoalSpec schema와 validator
- `runGoal`, `runTask`, `runPipeline`
- legacy `next_task` response
- MCP `minitok_run`과 `minitok_run_get`
- 기존 approval scopes
- Repository ODD와 protected path 정책
- 기존 session state migration

Goal-aware 필드는 additive하게 저장·반환되며, 기존 호출자가 이를 제공하지 않으면 기존 동작을 사용한다.

## 11. 운영 원칙

- 무관한 작업은 자동 계획에 추가하지 않는다.
- optional follow-up은 자동 실행하지 않는다.
- 안전한 local 대안은 bounded policy 안에서만 자동 실행한다.
- 외부 side effect는 승인 전 실행하지 않는다.
- canonical `always_blocked` 작업은 모든 mode에서 차단한다. 기존 `never_autonomous` 입력은 이 의미를 backward-compatible하게 표현할 수 있다.
- 실패하면 원인과 최소 하나의 대안을 evidence로 남긴다.
- 모든 대안이 실패하면 사람에게 필요한 조치와 재개 조건을 제공한다.
- 목표를 넘어서 판단하지만 무제한으로 행동하지 않는다.

## 12. Phase 9 acceptance checklist

```text
npm test
npm run lint
npm run typecheck
npm run test:extension
npm run docs:check
node scripts/secret-scan.mjs
npm pack --dry-run --json
npm run check:mcp-registry
npm run readiness:all
```

위 명령 중 live provider, production, deploy, publish를 요구하는 별도 opt-in 명령은 승인 없이 실행하지 않는다. local/mock/unverified 결과는 구분해 기록한다.

### `never_autonomous`

다음은 승인 여부와 관계없이 자동 실행하지 않는다.

- secret 출력
- private key 추출
- destructive database 작업
- tag overwrite
- force push
- approval 우회

## 13. Blocker 처리 순서

1. 오류를 blocker category로 분류한다.
2. redacted evidence와 함께 원인을 기록한다.
3. 하나 이상의 대안을 생성한다.
4. 위험, 권한, 비용, 가역성, side effect를 평가한다.
5. 현재 policy에서 자동 실행 가능한 대안만 선택한다.
6. 실행 후 verifier를 수행한다.
7. 실패하면 동일 alternative와 동일 patch를 제외하고 다음 대안을 검토한다.
8. 후보가 없거나 승인이 필요하면 human escalation으로 종료한다.

자동 선택되더라도 verifier 통과 없이는 Goal 완료로 판정하지 않는다.

## 14. CLI workflow

```text
minitok goal start "Prepare a release" --repo <repository> --json
minitok goal status --goal-id <goal_id> --repo <repository> --json
minitok goal continue --goal-id <goal_id> --repo <repository> --json
minitok goal resume --goal-id <goal_id> --repo <repository> --json
```

상태 응답은 state/current_state, blocker, alternatives, recommended_action, approval_required, resume_action/resume_command, evidence, final_outcome을 포함할 수 있다.

`blocked`, `escalated`, `approval_required`, `clarification_required` 상태는 성공으로 숨기지 않는다.

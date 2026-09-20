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


## 6. MCP workflow

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

## 7. 중단과 Resume

중단 사유는 session state와 events에 저장된다. resume 전 다음을 확인한다.

- GoalSpec이 여전히 유효한지
- workspace가 동일한지
- checkpoint 이후 tracked file이 변경되지 않았는지
- 변경되었다면 verifier를 먼저 수행했는지
- blocker 승인이나 operator 조치가 완료되었는지
- checkpoint 이후 변경된 경우 `resume_check.requires_verification`이 해제되었는지

tracked file이 checkpoint 이후 변경되면 resume 상태는 `verification_required`로 유지되며 task executor를 호출하지 않는다. 모든 required criterion에 대해 `passed`, `valid`, `executed`인 evaluator evidence가 확인된 후에만 resume gate가 해제된다.

MCP에서는 `resume_action` 또는 `minitok_goal_resume`를 사용한다. CLI에서는 `goal resume --goal-id ...`를 사용한다. 응답에는 `verification_required`와 `resume_check`를 포함할 수 있다. resume도 완료를 보장하지 않으며 evaluator evidence가 다시 필요하다.

## 8. Evidence 확인

확인 대상:

- Goal Session `state.json`
- append-only `events.jsonl`
- evaluator `verification_results`
- blocker report와 alternative history
- approval request와 resolution attempt
- final outcome

모든 저장·응답 evidence는 token, password, API key, secret, private key, authorization header를 redaction한다. 모델의 `done`, `completed`, review `APPROVE`만으로 완료를 주장하지 않는다.

## 9. Backward compatibility

기존 계약은 유지된다.

- GoalSpec schema와 validator
- `runGoal`, `runTask`, `runPipeline`
- legacy `next_task` response
- MCP `minitok_run`과 `minitok_run_get`
- 기존 approval scopes
- Repository ODD와 protected path 정책
- 기존 session state migration

Goal-aware 필드는 additive하게 저장·반환되며, 기존 호출자가 이를 제공하지 않으면 기존 동작을 사용한다.

## 10. 운영 원칙

- 무관한 작업은 자동 계획에 추가하지 않는다.
- optional follow-up은 자동 실행하지 않는다.
- 안전한 local 대안은 bounded policy 안에서만 자동 실행한다.
- 외부 side effect는 승인 전 실행하지 않는다.
- `never_autonomous`는 항상 차단한다.
- 실패하면 원인과 최소 하나의 대안을 evidence로 남긴다.
- 모든 대안이 실패하면 사람에게 필요한 조치와 재개 조건을 제공한다.
- 목표를 넘어서 판단하지만 무제한으로 행동하지 않는다.

## 11. Phase 9 acceptance checklist

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

## 6. Blocker 처리 순서

1. 오류를 blocker category로 분류한다.
2. redacted evidence와 함께 원인을 기록한다.
3. 하나 이상의 대안을 생성한다.
4. 위험, 권한, 비용, 가역성, side effect를 평가한다.
5. 현재 policy에서 자동 실행 가능한 대안만 선택한다.
6. 실행 후 verifier를 수행한다.
7. 실패하면 동일 alternative와 동일 patch를 제외하고 다음 대안을 검토한다.
8. 후보가 없거나 승인이 필요하면 human escalation으로 종료한다.

자동 선택되더라도 verifier 통과 없이는 Goal 완료로 판정하지 않는다.

## 7. CLI workflow

```text
minitok goal start "Prepare a release" --repo <repository> --json
minitok goal status --goal-id <goal_id> --repo <repository> --json
minitok goal continue --goal-id <goal_id> --repo <repository> --json
minitok goal resume --goal-id <goal_id> --repo <repository> --json
```

상태 응답은 state/current_state, blocker, alternatives, recommended_action, approval_required, resume_action/resume_command, evidence, final_outcome을 포함할 수 있다.

`blocked`, `escalated`, `approval_required`, `clarification_required` 상태는 성공으로 숨기지 않는다.

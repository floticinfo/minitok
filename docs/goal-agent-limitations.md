# Goal Agent Limitations

## 보장하는 범위

- 모델 주장보다 deterministic evaluator와 evidence를 우선한다.
- 필수 criterion, valid evidence, repository scope가 모두 충족되지 않으면 completed가 되지 않는다.
- path traversal, protected path, unsafe verifier command, dangerous GoalSpec field를 거부한다.
- session lock, atomic persistence, corrupt state detection, checkpoint 변경 감지와 변경 후 fail-closed 재검증 gate를 제공한다.
- external access는 repository ODD에서 기본 차단한다.
- Phase 8 application adapter는 mock/injected driver 중심이며 redaction과 allowlist를 적용한다.

## 보장하지 않는 범위

- 모델이 제안한 코드의 의미적 정확성 전체
- 외부 서비스의 실제 가용성이나 정확성
- 실제 browser, production database, cloud deployment의 성공
- verifier 자체가 거짓이거나 악의적으로 작성된 경우의 모든 의미적 공격
- OS, filesystem, provider, network의 모든 장애
- token 사용량의 provider billing 정확성
- 모델 capability profile이 실제 모델의 모든 행동을 설명한다는 보장

## 주요 위험

가장 심각한 오류는 목표를 달성하지 않았는데 시스템이 completed를 반환하는 system false completion과 valid evidence 없이 완료하는 invalid-evidence completion이다. ODD 밖 action은 실제 실행 여부를 구분한다. 의도된 negative/security action이 차단된 것은 방어 성공이며 executed unsafe action이 아니다. benchmark는 실제 위반율과 negative detection/block rate를 별도 기록한다.

## Model 교체 및 관찰 capability 한계

모델 이름 대신 capability contract로 routing하지만, `declared_capabilities`는 실측이 아니다. 실제 benchmark/E2E record는 `observed_capabilities`, `observed_failures`, `confidence`, `last_measured_at`로 별도 기록한다. 관찰 수가 부족하면 `insufficient_observations`로 남기며 선언값을 관찰값으로 승격하지 않는다.

반복 structured-output 실패는 specification role, 반복 recovery 실패는 recovery role, tool/action proposal 불가 관찰은 work role, false completion은 completion authority role에서 제외할 수 있다. 이는 충분한 관찰과 보수적 임계값을 충족할 때만 적용되며, 대체 모델이 없으면 escalate한다. 모델 교체가 기존 GoalState, evaluator evidence, evidence references를 성공으로 바꾸지는 않는다.

## Goal Compiler 한계

Phase 10의 Goal Compiler는 자연어 목표를 임의로 성공 조건으로 바꾸지 않는다.

- 명시적 `npm test`, lint, typecheck, 파일 존재 verifier처럼 deterministic하게 관찰 가능한 목표만 `ready` GoalSpec으로 변환한다.
- 기능 추가, 버그 수정, 테스트 추가, API endpoint, 문서, refactoring, 파일/module 변경 목표는 성공 조건과 verifier가 확인될 때까지 `clarification_required`로 유지한다.
- deployment, browser, production database, cloud/release 같은 외부 실행이 필요한 목표는 `unsupported`로 명시한다.
- 모델 draft는 schema/verifier/path/dangerous-key 검증을 통과해야 하며 `done`/`completed` 필드는 완료 권한으로 사용되지 않는다.
- 실제 LLM provider가 목표의 누락 정보를 자동으로 보완하지 않는다. 구체적인 acceptance condition과 verifier를 사용자 또는 상위 호출자가 제공해야 한다.

## Out of scope

이번 Phase 10에서도 새로운 provider, browser/database runtime, deployment engine, external telemetry backend, autonomous write capability를 추가하지 않았다. 실제 환경 benchmark는 별도 승인된 opt-in phase가 필요하다.

## Unrestricted 운영 한계와 사용자 위험

`unrestricted`는 기본 비활성이고 사용자의 명시적 mode/confirmation/config allowlist가 필요한 opt-in 모드다. allowlist가 넓거나 목표가 부정확하면 workspace 변경, 외부 호출, publish/deploy, database mutation, force push, tag overwrite가 승인 대기 없이 실행될 수 있다. 운영자는 먼저 `safe` 또는 `supervised`로 verifier와 scope를 확인하고 최소 capability만 허용해야 한다.

`workspace_write`, `external_call`, `credential_use`, `publish`, `deploy`, `database_mutation`, `force_push`, `tag_overwrite`는 독립 capability다. 설정에 포함되지 않은 capability는 unrestricted에서도 거부된다. `always_blocked` (always-blocked) 작업은 어떤 mode에서도 실행하지 않으며, path traversal, workspace escape, dangerous object key, protected path/verifier tampering, private key 또는 secret logging이 여기에 포함된다.

resume은 저장된 unrestricted 정책을 자동 신뢰하지 않는다. CLI/MCP 호출자는 mode, confirmation, capability와 필요한 auto-accept 권한을 다시 제출해야 하며, checkpoint 이후 파일 변경이 있으면 read-only verification gate를 먼저 통과해야 한다.

모든 risk execution에는 preflight/final audit가 필요하다. 기본 audit fallback은 사용자 home의 `~/.minitok/audit.jsonl`이며, `auditPath`를 지정한 실행·테스트에서는 repository-local 파일을 사용할 수 있고 session state에도 redacted audit reference가 남는다. credential 값, private key 원문, authorization header, password, token, URL query/userinfo와 adapter raw result는 evidence·응답·로그에 남기지 않는다. redaction은 운영자가 비밀값을 입력하거나 외부 adapter가 별도 로그를 남기는 것을 방지하는 대체 수단이 아니다.

현재 general/unrestricted adapter 실행은 injected executor와 local/mock 계약을 검증하는 단계다. registry가 표현하는 adapter kind는 filesystem, shell, repository, test_runner, package_manager, local_http, process_health, browser, api, database_read_only, database_mutation, deployment, publish, scm이지만, descriptor 등록은 live connector나 production authorization을 뜻하지 않는다. 실제 production registry, cloud, database, browser, SCM 시스템의 가용성·권한·롤백·비용은 검증하지 않았다. production 연결은 별도 승인과 dry-run/integration 검증이 필요하다.

safe로 복귀하려면 새 CLI/MCP 요청에 `mode: safe`를 명시하고 unrestricted capability와 auto-accept를 제거한다. 이전 unrestricted session state만 읽어서는 재실행되지 않는다.

## 자동 Nunchi 통합의 한계

일반 CLI/MCP goal 입력은 자동으로 `prepareGoalExecution`과 `expandGoal`을 거쳐 GoalPlan과 inferred step을 만들지만, 이것이 모든 자연어 의도를 안전하게 이해한다는 뜻은 아니다.

- success criterion 또는 verifier가 없으면 `clarification_required`이며 임의 완료 기준을 생성하지 않는다.
- 모호하거나 deterministic하게 검증할 수 없는 목표는 clarification 또는 unsupported로 남는다.
- required inferred step은 원래 criterion과 연결되어야 하며, 무관한 작업은 자동 추가되지 않는다.
- optional follow-up은 완료 조건과 분리되어 deferred/제안으로 남을 수 있다.
- repository ODD 밖 step은 실행하지 않고 `out_of_scope_candidates`로 반환한다.

기본 mode는 `safe`이며 expansion capability도 기존 policy resolver를 통과해야 한다. unrestricted는 명시적인 opt-in이고 mode, confirmation, runtime permission, allowlist, audit/integrity gate를 모두 요구한다. continue/resume은 저장된 expansion을 재사용하지만 unrestricted policy를 자동 상속하지 않으며 checkpoint 변경 시 read-only verifier를 먼저 요구한다.

### Blocker와 recovery의 한계

inferred step에서 blocker가 발생하면 기존 BlockerReport, AlternativePlan, recovery 정책이 원인 분류, 대안 선택, approval/escalation, verifier와 evidence persistence를 수행한다. 그러나:

- network/외부 서비스가 실제로 복구된다는 보장은 없다.
- safe alternative는 제한된 local/read-only 범위의 자동 조치일 뿐이다.
- approval_required 대안은 operator 승인 없이는 executor를 호출하지 않는다.
- always-blocked, protected path, private key/secret logging, verifier tampering은 recovery로 우회하지 않는다.
- 동일 alternative와 동일 patch 반복은 차단되며 후보가 없으면 escalation된다.

### Session과 검증 증거

계획, inferred/optional step, blocker/alternative, recovery, verifier 결과와 redacted audit는 다음에 저장된다.

```text
<repository>/.minitok/goals/<goal_id>/goal.json
<repository>/.minitok/goals/<goal_id>/state.json
<repository>/.minitok/goals/<goal_id>/events.jsonl
<repository>/.minitok/goals/<goal_id>/evidence/
~/.minitok/audit.jsonl
```

local/mock/injected 테스트와 `stage2:parity`는 구현 계약과 보안 경계를 검증하지만 실제 production registry, cloud, database, browser, SCM 가용성·권한·롤백·비용을 증명하지 않는다. live production 검증은 별도 승인, dry-run, credential 운영 및 rollback 계획이 필요하다.


## Phase 11: General mode의 운영 한계

`unrestricted_general`은 기본 비활성이다. `minitok.yml`의 `goal.unrestricted_general.enabled: true`, 명시적 mode, `confirm_unrestricted_general` 또는 `--confirm-unrestricted-general`, `unrestricted_general_autonomous` runtime permission, auto-accept, general capability allowlist, `max_plan_depth`/`max_replan_count`/`max_assumption_count`, audit persistence와 integrity preflight를 모두 통과해야 한다. `unrestricted` 설정, 일반 `confirm_unrestricted`, `unrestricted_autonomous` permission 또는 `auto_accept`만으로 general mode가 켜지지 않는다.

### Mode 차이

- `safe`: read/inspect/verify/dry-run만 자동 실행한다.
- `supervised`: local mutation을 승인 후 실행한다.
- `authorized_external`: 승인된 external adapter와 credential presence를 사용한다.
- `unrestricted`: 정형 목표에서 명시된 allowlist 작업을 자동 실행한다.
- `unrestricted_general`: 자연어 intent, 누락 criteria, 관련 step, 도구, 대안과 replanning을 추론하되 모든 일반 mode gate를 다시 통과한다.
- `always_blocked`: 어떤 mode나 approval에서도 실행하지 않는다.

항상 차단되는 범위는 path traversal, workspace escape, dangerous object key, protected path와 verifier tampering, approval bypass, private key/credential/password/token 원문 노출과 secret logging이다.

### 해석과 잘못된 기준의 위험

general agent는 explicit requirement와 inferred requirement를 구분하고, inference의 rationale·confidence·dependency를 저장한다. 정보가 부족하면 assumption ledger와 provisional success criteria를 만들 수 있지만 이는 사용자 요구가 아니다. 모호한 목표, 관찰 불가능한 결과, 결정적 verifier가 없는 목표는 clarification/unsupported로 남겨야 한다. 모델이 만든 기준을 실제 완료 기준으로 승격하면 false completion과 scope expansion이 발생할 수 있으므로 evaluator evidence와 사용자 확인이 우선이다.

replanning은 blocker, 환경 관찰, assumption invalidation, verifier failure 때만 기존 목표와 검증된 step을 보존하면서 수행한다. 반복 patch와 동일 alternative는 금지하며, 대안이 없거나 외부 승인이 필요하면 escalation한다. 변경에는 rollback plan과 checkpoint가 필요하고 rollback 실패는 completed가 아니다. resume은 checkpoint 변경을 read-only verifier로 확인하고 이전 unrestricted 권한을 자동 상속하지 않는다.

### 완료와 검증의 한계

모델의 `done`, `completed`, `APPROVE`는 완료 권한이 아니다. required criterion 전체에 대해 실행된 valid verifier evidence와 evaluator 판정이 있어야 한다. verifier 미실행, timeout, 환경 불가, evidence 누락은 unknown/blocked다.

세션은 `<repository>/.minitok/goals/<goal_id>/` 아래에, 기본 audit는 `~/.minitok/audit.jsonl`에 redacted 형태로 남는다. credential 값, private key, authorization header, password, token, URL query/userinfo와 raw adapter response는 저장하지 않는다.

### Production 구분과 safe 복귀

benchmark와 mock/injected E2E는 local contract와 방어 경계만 검증한다. production publish/deploy/database/browser/SCM 성공, 가용성, 권한, 비용과 rollback은 별도 승인된 live integration에서 확인해야 한다.

위험 신호가 있으면 pause/cancel하고 새 CLI/MCP 요청에 `mode: safe`를 명시한다. `unrestricted_general` confirmation, runtime permission, side-effect capability와 `auto_accept`를 제거하고 read-only verifier를 실행한 다음 필요하면 supervised approval로 전환한다.

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

현재 unrestricted adapter는 injected/mock 계약을 검증하는 단계다. 실제 production registry, cloud, database, browser, SCM 시스템의 가용성·권한·롤백·비용은 검증하지 않았다. production 연결은 별도 승인과 dry-run/integration 검증이 필요하다.

safe로 복귀하려면 새 CLI/MCP 요청에 `mode: safe`를 명시하고 unrestricted capability와 auto-accept를 제거한다. 이전 unrestricted session state만 읽어서는 재실행되지 않는다.

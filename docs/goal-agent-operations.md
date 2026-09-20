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

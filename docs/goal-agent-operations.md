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

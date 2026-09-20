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

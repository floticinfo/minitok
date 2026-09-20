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

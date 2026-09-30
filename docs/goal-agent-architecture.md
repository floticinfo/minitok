# Goal Agent Architecture (Phase 9)

## 목적

Goal Agent는 모델이 제안한 task를 실행하는 기존 minitok pipeline 위에 명시적 목표, 결정적 검증, evidence, persistence, recovery를 추가한다. 모델의 `done`, `completed`, `APPROVE`는 메타데이터일 뿐 최종 완료 신호가 아니다.

## 실행 경로

```text
legacy task / goal input
→ Goal compiler
→ validated GoalSpec
→ GoalController
→ task executor / existing pipeline
→ GoalEvaluator
→ evidence + ODD scope
→ session state / terminal result
```

`minitok_run(task)`는 기존 pipeline 호환 API로 유지된다. 장기 goal MCP surface는 별도의 `minitok_goal_*` 도구와 Goal Session을 사용한다.

## 핵심 구성요소

- `src/goal/spec.js`: schema, default constraints, execution modes
- `src/goal/validator.js`: unknown field, dangerous key, path, verifier, ODD validation
- `src/goal/compiler.js`: 명시 goal과 legacy task 변환
- `src/goal/controller.js`: cycle, limit, task proposal, recovery, escalation, terminal state
- `src/goal/evaluator.js`: command/file/test/custom verifier 실행 및 완료 판정
- `src/goal/evidence.js`: stable evidence id와 secret redaction
- `src/goal/odd.js`: repository evidence와 allowed/protected scope
- `src/goal/session.js`: atomic state, checkpoint, lock, pause/resume, migration
- `src/goal/application.js`: Phase 8 mock-first application adapters
- `src/goal/benchmark.js`: Phase 9 deterministic benchmark metrics

## 완료 정의

필수 criterion 모두가 `passed`이고, 각 criterion의 evidence id가 존재하며 `valid === true`이고, repository scope가 유효해야 completed다. 하나라도 `unknown`, 실행되지 않음, timeout, invalid evidence, protected path 변경이면 completed가 아니다.

## 안전 경계

기본 ODD는 `allow_external: false`다. verifier command는 allowlist와 shell metacharacter 검사를 통과해야 하며, 파일 경로는 workspace 내부여야 한다. autonomous mode는 MCP permission `auto_accept` 없이는 거부된다. 변경 범위를 벗어나거나 protected path를 수정하면 blocked다.

## 모델 교체

모델 이름이 아니라 capability contract(`structured_output`, `tool_calling`, `repository_navigation`, `code_editing`, `error_recovery`, `long_horizon`)로 역할 적합성을 평가한다. 반복 실패 시 recovery policy가 더 강한 capability 모델을 선택하고, 후보가 없으면 escalate한다.

## Phase 10 운영 계약과 runtime parity

정책 resolver의 canonical mode는 `safe`, `supervised`, `authorized_external`, `unrestricted`, `always_blocked`다. legacy `never_autonomous`는 `always_blocked` compatibility alias로 normalize되며, 단순 승인 대기 작업은 `approval_required` 상태로 표현한다.

`src/goal/execution_policy.js`가 CLI와 MCP의 공통 resolver이고, `src/goal/risk_execution.js`가 allowlisted injected adapter와 integrity gate를 연결한다. `src/goal/execution_audit.js`는 preflight/final redacted audit와 fail-closed persistence를 담당한다. extension runtime은 대응하는 `extension/runtime/src/goal/` 및 `extension/runtime/src/mcp/` 구현을 유지하며 `npm run stage2:parity`와 runtime sync/parity 검증으로 drift를 확인한다.

unrestricted execution은 다음 교집합으로만 허용된다.

```text
explicit mode + confirmation + configured capability allowlist
+ required runtime permission + credential presence (when required)
+ workspace/integrity validation + persisted preflight audit
```

어느 하나라도 실패하면 adapter와 후속 executor를 호출하지 않는다. path traversal, workspace escape, dangerous key, protected path/verifier tampering, secret/private-key logging 및 `always_blocked` (always-blocked) operation은 mode와 무관하게 차단된다. audit에는 safe relative path와 URL protocol/hostname/port/pathname만 남기고 민감한 query/userinfo/raw result는 제거한다.

runtime parity는 기능을 production에 연결했다는 뜻이 아니다. 현재 adapter는 injected/mock 중심이며 실제 registry, cloud, database, browser, SCM production 동작은 별도 승인된 integration 단계의 대상이다.

### P2 verified external-operation contract

외부 side effect를 선언한 injected adapter는 `external_operation_contract`를 통해 다음을 모두 명시한다.

- `target_binding`과 required capabilities: target이 없거나 capability가 부족하면 executor 전에 fail-closed
- idempotency key, canonical request fingerprint, operation ledger: 동일 key의 duplicate 실행 금지
- mutation의 read-after-write verification과 expected/observed external-state fingerprint: drift나 verification unknown은 completion으로 승격하지 않음
- `timeout`, `partial_success`, `unknown` 상태 보존과 명시적 retry status allowlist

계약 adapter에는 injected `read_after_write_executor`가 필요하며 descriptor/public response에서는 executor를 제거한다. ledger, fingerprint, operation status만 redacted audit로 남기고 raw adapter result와 secret-like 값은 저장하지 않는다. P2 테스트는 deterministic mock/local adapter만 사용하며 live endpoint, production credential, external service를 호출하지 않는다.

### P3-P5 Camelstream live boundary

Camelstream은 별도 임의 endpoint가 아니라 공식 OpenAI-compatible preset으로만 연결한다.

```yaml
providers:
  camelstream:
    base_url: https://stream.camelai.com/v1
    api_key_env: CAMEL_API_KEY
    models:
      - id: auto
roles:
  plan:
    provider: camelstream
    model: auto
```

raw `api_key`는 설정에서 거부하며 `CAMEL_API_KEY`의 존재 여부만 gate에서 확인한다. 실제 값은 응답, audit, live evidence, 로그에 기록하지 않는다. Camelstream 요청은 `/v1/responses`와 registry-confirmed model `auto`로 제한한다.

실제 호출은 `supervised_live` mode, `--confirm-live`, `--allow-network`, `--allow-camelstream`, `CAMEL_API_KEY`가 모두 있어야 한다. 기본 canary budget은 요청 1회, 출력 1024 tokens, timeout 30초다. `npm run camelstream:live-smoke`는 이러한 gate가 없으면 네트워크 전에 blocked evidence만 기록한다.

live evidence는 deterministic P1/P2 artifact와 별도 schema인 `supervised_live_provider_smoke`를 사용하며 항상 `publishable_claim: false`다. 통과 결과도 production readiness, 품질, availability 또는 product superiority를 주장하지 않는다.

# Auth-Token 기반 Entitlement (로컬 JWT 검증) 설계

## 배경과 문제

Extension은 OAuth 로그인 후 `readExtensionSession()`이 반환하는 access_token으로 entitlement를
판정한다. 기존 `/api/entitlement/me` 구현은 두 가지 치명적 결함이 있었다.

1. **`jwt.decode()` 미검증** — 토큰 서명을 검증하지 않고 payload의 `customer_id`를 신뢰했다.
   누구든 임의의 `customer_id`를 담은 무서명 JWT를 만들어 `Authorization: Bearer`로 보내면
   그 계정의 entitlement를 열람할 수 있는 인증 우회 취약점이었다.
2. **`customer_id` 미발급/미저장** — `/activate`가 `store.create`에 `customerId`를 전달하지 않아
   조회할 레코드가 없어 `/me`가 항상 404를 반환하는 dead path였다.

초기에는 토큰이 **opaque**라고 가정해 auth 서버 introspection(경로 A)을 설계했으나,
`minitok-server-deploy` 조사 결과 실제 access_token은 **HMAC-SHA256(HS256)으로 서명된 JWT**임이
확인됐다. 프로덕션에는 `/v1/auth/introspect` 엔드포인트도 없다. 따라서 introspection은
근본적으로 불필요하며 동작하지도 않으므로, **로컬 JWT 검증**으로 전환했다.

## 결정: 로컬 JWT 검증

토큰이 JWT이므로 entitlement 서버는 **auth 서버와 공유한 비밀키로 토큰을 로컬에서 검증**한다.
네트워크 홉이 사라지고, 검증이 마이크로초 단위로 끝나며, auth 서버 다운 시에도 entitlement
판정이 계속된다.

```
Extension ──Bearer <auth JWT>──▶ entitlement  GET /api/entitlement/me
                                      │ verifyOAuthToken(token)
                                      │   jwtVerify(token, OAUTH_JWT_SECRET, {iss, aud})
                                      │   classifyCustomerTokenClaims(payload)  → customerId = sub
                                      ▼
                                store.findByCustomerId(customerId)
```

## customer 식별자: `sub` claim

- customer 식별자는 **`sub` claim(UUID 형식)** 이다. 별도의 `customer_id` claim은 존재하지 않는다.
- `classifyCustomerTokenClaims`가 `sub`를 UUID로 검증하고, 예약 claim(`installation_id` 등)이
  섞여 있으면 installation 토큰으로 간주해 거부한다. 이렇게 entitlement 자체 토큰(레거시
  라이선스 JWT)과 OAuth customer 토큰을 구분한다.

## 환경 변수

| 변수 | 용도 | 기본값 |
|---|---|---|
| `OAUTH_JWT_SECRET` | OAuth 토큰 검증 공유 비밀키. **프로덕션 필수** | `MINITOK_JWT_SECRET` → `minitok-oauth-dev-secret` |
| `OAUTH_JWT_ISSUER` | 검증할 `iss` claim | `minitok-server` |
| `OAUTH_JWT_AUDIENCE` | 검증할 `aud` claim | `minitok:customer` |

> **운영 전제:** entitlement 서버의 `OAUTH_JWT_SECRET`은 OAuth 서버(`minitok-server-deploy`)의
> `JWT_SECRET`과 **동일한 값**이어야 한다. 기본값은 개발용이므로 프로덕션에서 반드시 명시 설정한다.

## 보안 불변식

- 토큰은 반드시 `jwtVerify`로 **서명·issuer·audience·만료**를 검증한 뒤에만 신뢰한다. `jwt.decode`를
  인증 판단에 사용하지 않는다.
- `customerId`는 클라이언트가 보낸 값이 아니라 **검증된 토큰의 `sub`** 에서만 얻는다.
- 검증 실패(서명 불일치·iss/aud 불일치·만료·UUID 아님·예약 claim 존재)는 **fail-closed**: 401로 거부하고
  entitlement를 부여하지 않는다.
- 토큰 값 자체는 로그에 남기지 않는다.

## `customer_id` 레코드 바인딩 (문제 2 해결)

`/activate`는 라이선스 키 기반이라 OAuth 토큰이 없으므로, 바인딩은 **별도 1회 연결**로 수행한다.

- `POST /api/entitlement/bind` — 본문 `{ key, auth_token }`.
  1. `store.validateKey(key)`로 키 유효성 검증 (401/403/404 사유별 거부)
  2. `verifyOAuthToken(auth_token)`으로 `customerId` 획득 (검증 실패 시 401)
  3. `store.bindCustomerId(key, customerId)`로 레코드에 저장 → 이후 `GET /me`가 조회 가능
- 성공 응답: `{ bound: true, customer_id, entitlement }`

## 구현 범위

### 서버 (`server/`)
- `server/services/jwt.js` — 의존성 없는 HS256 `sign`/`verify`.
- `server/middleware/oauth-auth.js` — `verifyOAuthToken`, `classifyCustomerTokenClaims`.
- `server/routes/entitlement.js` — `GET /me`를 로컬 검증 기반으로 재작성, `POST /bind` 추가.
- `server/models/entitlement.js` — `findByCustomerId`, `bindCustomerId`.

### Extension (`extension/`)
- `extension/src/entitlement.ts` — `meEntitlementSession(authToken)`(GET /me) + `bindLicenseToAccount(key, authToken)`(POST /bind).
- `extension/src/sidebar.ts` — `bind-license` 명령 핸들러. 성공 시 `invalidateEntitlementCache()` + `refreshAuth()`로 리로드 없이 게이트 전환.
- `extension/src/sidebar.html` — not-entitled 상태에 "Link a license key" + "Get a plan" 버튼과 키 입력 패널(`bindPanel`).

## 테스트

- `tests/test-oauth-entitlement.js` — 위조 서명·payload 변조·iss/aud 불일치·만료·installation 토큰 거부
  등을 포함한 13개 계약 테스트. 특히 "서명 후 `sub`를 다른 customer로 교체"하는 공격을 고정한다.

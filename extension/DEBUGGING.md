# Extension F5 debug session and login-flow measurement

This note is the hands-on checklist for reproducing first-run login problems
in the Extension Development Host. It assumes the workspace folder is
`C:\Users\J1\minitok-client-release\extension`.

## 1. Prepare a clean "first run" state

First-run behaviour depends on three local state stores. Back them up, then
remove them so the extension behaves as if it was just installed:

```powershell
# Back up existing state (skip if none)
$backup = "$env:USERPROFILE\minitok-state-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item "$env:USERPROFILE\.minitok" "$backup\.minitok" -Recurse -ErrorAction SilentlyContinue

# Clear shared session + legacy CLI token (device-auth.ts)
Remove-Item "$env:USERPROFILE\.minitok\account\session.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.minitok\entitlement\customer-token.json" -Force -ErrorAction SilentlyContinue
```

VS Code SecretStorage (`minitok.secret.accountSession`) can only be cleared
from inside the extension: run **minitok: Sign out / switch account** once in
the Development Host, or accept that a leftover secret may short-circuit the
"signed out" state.

## 2. Start the debug session

1. `code C:\Users\J1\minitok-client-release\extension`
2. Press **F5** ("Run Extension" from `.vscode/launch.json`). The default
   build task runs `tsc` first, so `dist/` is never stale.
3. In the Extension Development Host window, open the minitok activity bar
   panel.

Breakpoints in `src/` map through the compiled output (`dist/src/*.js` with
inline sources is not enabled; breakpoints bind via `outFiles`). Good first
breakpoints:

- `src/sidebar.ts` — `refreshAuth()` (auth-status handler) and the
  `device-login` case
- `src/device-auth.ts` — `deviceLogin()` polling loop and `save()`
- `src/entitlement.ts` — `checkEntitlement()` settle paths

## 3. Observe the message flow

Open both log surfaces in the Development Host:

- **View → Output**, channel **minitok** — CLI output from `extension.ts`
- **Help → Toggle Developer Tools → Console** — webview `postMessage` traffic.
  To see what the sidebar receives, paste into the Console:

  ```js
  window.addEventListener('message', e => console.log('[webview<-host]', e.data));
  ```

  (Run this in the webview's own context: pick the sidebar iframe from the
  context dropdown at the top of the Console, e.g. `minitok-sidebar`.)

- **Host-side logging**: `console.log` / `console.warn` in `src/*.ts` appears
  in the *debug console of the original window* (the one where you pressed
  F5), not in the Development Host. Temporary `console.log('[sidebar] auth
  state', state)` lines in `refreshAuth()` are the fastest way to trace the
  login sequence without breakpoints.

## 4. Login scenarios to measure

For each scenario record: time from click to `auth-state` message, the
`state`/`authenticated`/`entitled` fields received, and whether the sidebar
visually matches.

| # | Scenario | What to watch |
|---|----------|---------------|
| 1 | Cold start, no session anywhere | `auth-status` must resolve to `signed-out`, not a billing/entitlement error |
| 2 | Browser device login, complete within 1 min | `deviceLogin()` poll; `save()` writes secret + shared file; sidebar flips to authenticated |
| 3 | Login, then immediately press **Run** | Entitlement cache: a fresh denial cached 10 s must not reject a user who just fixed their plan (`invalidateEntitlementCache()` after login) |
| 4 | Slow network (set `minitok.serverUrl` unreachable) | 15 s request timeout must surface a network error, not hang |
| 5 | CLI not installed / wrong `minitok.cliPath` | `checkEntitlement` fails via spawn error; sidebar must show actionable text, not "not entitled" |
| 6 | Logout, then log in as a different account | `logoutExtension()` deletes secret + shared file + legacy token; second login must not resurrect the first account |

## 5. Packaging sanity check (separate from debugging)

The Marketplace detail page renders the README/package.json captured at
publish time. After editing pricing copy, rebuild and package locally to
verify what would be published:

```powershell
npm run compile
npx vsce package --out artifacts\
# Inspect the staged copy:
npx vsce ls --no-dependencies
```

The extension has no runtime dependencies (`"dependencies"` is absent), so
`vsce package` must not bundle `node_modules`; `.vscodeignore` already
excludes `src/`, `test/`, and `runtime/node_modules` except the bundled
`undici` subset used by the embedded MCP runtime.

## 6. Restore state after testing

```powershell
Remove-Item "$env:USERPROFILE\.minitok\account\session.json" -Force -ErrorAction SilentlyContinue
Copy-Item "$backup\.minitok" "$env:USERPROFILE\.minitok" -Recurse -Force
```

$ErrorActionPreference = 'Continue'
$base = 'http://localhost:3000'
$passed = 0
$failed = 0

function Check($name, $condition, $detail) {
  if ($condition) { $script:passed++; Write-Output "PASS: $name" }
  else { $script:failed++; Write-Output "FAIL: $name -- $detail" }
}

Write-Output '=== 1. POST /api/entitlement/activate (key=test) ==='
$activate = Invoke-RestMethod -Uri "$base/api/entitlement/activate" -Method Post -ContentType 'application/json' -Body '{"key":"test"}'
$activate | ConvertTo-Json -Depth 4
Check 'activate returns JWT token' ($activate.token -and $activate.token.Split('.').Count -eq 3) "$($activate.token)"
Check 'activate returns level1 plan' ($activate.entitlement.plan -eq 'level1') "$($activate.entitlement.plan)"
Check 'activate marks active' ($activate.entitlement.active -eq $true) "$($activate.entitlement.active)"
$token = $activate.token
$headers = @{ Authorization = "Bearer $token" }

Write-Output ''
Write-Output '=== 2. GET /api/entitlement/status ==='
$status = Invoke-RestMethod -Uri "$base/api/entitlement/status" -Headers $headers
$status | ConvertTo-Json -Compress
Check 'status active' ($status.active -eq $true) "$($status.active)"
Check 'status installation_id matches' ($status.installation_id -eq $activate.entitlement.installation_id) "$($status.installation_id)"

Write-Output ''
Write-Output '=== 3. POST /api/entitlement/refresh ==='
$refresh = Invoke-RestMethod -Uri "$base/api/entitlement/refresh" -Method Post -Headers $headers
Check 'refresh returns new token' ($refresh.token -and $refresh.token -ne $token) 'token unchanged or missing'
Check 'refresh preserves installation' ($refresh.entitlement.installation_id -eq $activate.entitlement.installation_id) "$($refresh.entitlement.installation_id)"

Write-Output ''
Write-Output '=== 4. DELETE /api/entitlement ==='
$delete = Invoke-RestMethod -Uri "$base/api/entitlement" -Method Delete -Headers $headers
$delete | ConvertTo-Json -Compress
Check 'revoke confirmed' ($delete.revoked -eq $true) "$($delete.revoked)"

Write-Output ''
Write-Output '=== 5. status after revoke ==='
$after = Invoke-RestMethod -Uri "$base/api/entitlement/status" -Headers $headers
Check 'inactive after revoke' ($after.active -eq $false) "$($after.active)"

Write-Output ''
Write-Output '=== 6. activate with wrong key (expect 401) ==='
try {
  Invoke-RestMethod -Uri "$base/api/entitlement/activate" -Method Post -ContentType 'application/json' -Body '{"key":"wrong"}'
  Check 'wrong key rejected' $false 'request unexpectedly succeeded'
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Check 'wrong key rejected' ($code -eq 401) "HTTP $code $($_.ErrorDetails.Message)"
}

Write-Output ''
Write-Output '=== 7. status without token (expect 401) ==='
try {
  Invoke-RestMethod -Uri "$base/api/entitlement/status"
  Check 'missing token rejected' $false 'request unexpectedly succeeded'
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Check 'missing token rejected' ($code -eq 401) "HTTP $code $($_.ErrorDetails.Message)"
}

Write-Output ''
Write-Output '=== 8. status with garbage token (expect 401) ==='
try {
  Invoke-RestMethod -Uri "$base/api/entitlement/status" -Headers @{ Authorization = 'Bearer garbage' }
  Check 'garbage token rejected' $false 'request unexpectedly succeeded'
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Check 'garbage token rejected' ($code -eq 401) "HTTP $code $($_.ErrorDetails.Message)"
}

Write-Output ''
Write-Output '=== 9. re-activate revoked key (expect 403) ==='
try {
  Invoke-RestMethod -Uri "$base/api/entitlement/activate" -Method Post -ContentType 'application/json' -Body '{"key":"test"}'
  Check 'revoked key rejected' $false 'request unexpectedly succeeded'
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Check 'revoked key rejected' ($code -eq 403) "HTTP $code $($_.ErrorDetails.Message)"
}

Write-Output ''
Write-Output "RESULT: $passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }

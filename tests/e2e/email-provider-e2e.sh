#!/usr/bin/env sh
# E2E: tenant BYO email provider -> verify -> tenant-first send resolution -> revoke.
# TK-3608 (P13.E1). Runnable inside the gateway container (localhost:3000) or
# against a base URL. Asserts the credential is NEVER returned in any response.
#
#   docker exec -i projexcloud_gateway sh < tests/e2e/email-provider-e2e.sh
#   BASE=https://cloud.projexlight.com sh tests/e2e/email-provider-e2e.sh
set -u
BASE="${BASE:-http://localhost:3000}"
PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

R=$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')
EMAIL="e2e-emailprov-$R@example.com"
PHONE="+1555${R}"; PHONE=${PHONE:0:12}

echo "1) signup-tenant (tenant-scoped token)"
SIGNUP=$(curl -s -X POST "$BASE/api/auth/signup-tenant" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"DefaultTestPass123!\",\"company_name\":\"E2E Co\",\"region\":\"us-east-1\",\"given_name\":\"E2E\",\"family_name\":\"Test\",\"display_name\":\"E2E\",\"phone\":\"$PHONE\"}")
TOK=$(echo "$SIGNUP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOK" ] && ok "got tenant token" || { bad "signup-tenant: $SIGNUP"; exit 1; }

echo "2) configure email provider (sendgrid)"
CREATE=$(curl -s -X POST "$BASE/api/notifications/providers" -H "content-type: application/json" -H "Authorization: Bearer $TOK" \
  -d '{"kind":"sendgrid","from_address":"noreply@e2e.example.com","credential":"SG.e2e-secret-key-abcd1234","config":{}}')
BID=$(echo "$CREATE" | sed -n 's/.*"binding_id":"\([^"]*\)".*/\1/p')
[ -n "$BID" ] && ok "created binding $BID" || bad "create: $CREATE"
echo "$CREATE" | grep -q 'e2e-secret-key' && bad "SECRET LEAKED in create response" || ok "secret not returned"
echo "$CREATE" | grep -q '"last_4":"1234"' && ok "last_4 exposed for display" || bad "last_4 missing"

echo "3) list providers (metadata only)"
LIST=$(curl -s "$BASE/api/notifications/providers" -H "Authorization: Bearer $TOK")
echo "$LIST" | grep -q "$BID" && ok "binding listed" || bad "list: $LIST"
echo "$LIST" | grep -q 'e2e-secret-key' && bad "SECRET LEAKED in list" || ok "secret not in list"

echo "4) verify (test send; verified:false expected with a bad key, HTTP 200)"
VCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/notifications/providers/$BID/verify" \
  -H "content-type: application/json" -H "Authorization: Bearer $TOK" -d "{\"to\":\"$EMAIL\"}")
[ "$VCODE" = "200" ] && ok "verify returned 200" || bad "verify HTTP $VCODE"

echo "5) rotate credential"
RCODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/notifications/providers/$BID" \
  -H "content-type: application/json" -H "Authorization: Bearer $TOK" -d '{"credential":"SG.e2e-rotated-wxyz9876"}')
[ "$RCODE" = "200" ] && ok "rotate returned 200" || bad "rotate HTTP $RCODE"

echo "6) revoke -> status revoked"
REVOKE=$(curl -s -X DELETE "$BASE/api/notifications/providers/$BID" \
  -H "content-type: application/json" -H "Authorization: Bearer $TOK" -d '{"reason":"e2e revoke test"}')
echo "$REVOKE" | grep -q '"status":"revoked"' && ok "provider revoked" || bad "revoke: $REVOKE"

echo "----"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1

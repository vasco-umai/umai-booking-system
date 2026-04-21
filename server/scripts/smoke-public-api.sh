#!/usr/bin/env bash
# Smoke test for /api/public/*.
# Usage:
#   UMAI_KEY=umai_live_xxx ./smoke-public-api.sh [base_url]
# Default base_url: http://localhost:3001
#
# Exits 0 if every step returns the expected status code, non-zero otherwise.
set -euo pipefail

BASE="${1:-http://localhost:3001}"
KEY="${UMAI_KEY:-}"
if [[ -z "$KEY" ]]; then
  echo "ERROR: Set UMAI_KEY before running." >&2
  exit 1
fi

pass=0
fail=0

hit() {
  local label="$1" expected="$2" method="$3" path="$4"
  shift 4
  local tmp; tmp="$(mktemp)"
  local status
  status="$(curl -s -o "$tmp" -w '%{http_code}' -X "$method" "$BASE$path" "$@")"
  if [[ "$status" == "$expected" ]]; then
    echo "  ok   [$label] $method $path → $status"
    pass=$((pass+1))
  else
    echo "  FAIL [$label] $method $path → $status (expected $expected)"
    echo "       body: $(head -c 400 "$tmp")"
    fail=$((fail+1))
  fi
  cat "$tmp"; echo; rm -f "$tmp"
}

echo "── 1. Health (unauth) — expect 200"
hit "health" 200 GET /api/public/health

echo "── 2. No key — expect 401"
hit "no-key" 401 GET /api/public/availability/meeting-types

echo "── 3. List meeting types — expect 200"
hit "list-types" 200 GET /api/public/availability/meeting-types \
  -H "Authorization: Bearer $KEY" \
  | tee /tmp/umai_types.json >/dev/null
MTID="$(grep -oE '"id":[[:space:]]*[0-9]+' /tmp/umai_types.json | head -n1 | grep -oE '[0-9]+' || echo '')"
if [[ -z "$MTID" ]]; then
  echo "ERROR: no meeting types returned — seed data missing?" >&2
  exit 2
fi
echo "  using meeting_type_id=$MTID"

DATE="$(date -u -v+7d +%Y-%m-%d 2>/dev/null || date -u -d '+7 days' +%Y-%m-%d)"

echo "── 4. Availability — expect 200"
hit "availability" 200 GET "/api/public/availability?meeting_type_id=$MTID&date=$DATE&tz=Europe/Lisbon" \
  -H "Authorization: Bearer $KEY" \
  | tee /tmp/umai_slots.json >/dev/null

SLOT_START="$(grep -oE '"slot_start":"[^"]+"' /tmp/umai_slots.json | head -n1 | cut -d'"' -f4 || echo '')"
if [[ -z "$SLOT_START" ]]; then
  echo "  (no free slots on $DATE — booking tests skipped)"
  echo "── Summary: $pass ok, $fail fail"
  exit 0
fi
echo "  picked slot_start=$SLOT_START"

IDEM="$(uuidgen | tr '[:upper:]' '[:lower:]')"
BODY=$(cat <<JSON
{
  "meeting_type_id": $MTID,
  "slot_start": "$SLOT_START",
  "guest_name": "Smoke Test",
  "guest_email": "smoke+$IDEM@umai-test.internal",
  "guest_phone": "+351 900 000 000",
  "guest_tz": "Europe/Lisbon",
  "lang": "en"
}
JSON
)

echo "── 5. POST /bookings — expect 201"
hit "book-create" 201 POST /api/public/bookings \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: $IDEM" \
  -H "Content-Type: application/json" \
  -d "$BODY"

echo "── 6. Replay same Idempotency-Key — expect 201 with same booking_id"
hit "book-replay" 201 POST /api/public/bookings \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: $IDEM" \
  -H "Content-Type: application/json" \
  -d "$BODY"

echo "── 7. Reuse key with different body — expect 409"
BODY2="${BODY/Smoke Test/Smoke Test 2}"
hit "book-conflict" 409 POST /api/public/bookings \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: $IDEM" \
  -H "Content-Type: application/json" \
  -d "$BODY2"

echo "── 8. Missing Idempotency-Key — expect 400"
hit "book-no-idem" 400 POST /api/public/bookings \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY"

echo "── Summary: $pass ok, $fail fail"
[[ $fail -eq 0 ]]

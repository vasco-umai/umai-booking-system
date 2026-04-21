# UMAI Booking — Public API

Server-to-server API for trusted consumers (AI voice-calling agents, partner integrations). All heavy lifting — sales-rep assignment, Google Calendar sync, confirmation emails, conflict checks — happens inside our system. Consumers just call three endpoints.

**Base URL (prod):** `https://umai-booking.vercel.app/api/public`
**Base URL (local):** `http://localhost:3001/api/public`
**OpenAPI spec:** `GET /api/public/openapi.yaml`

---

## 1. Authentication

Every authenticated request must include:

```
Authorization: Bearer umai_live_XXXXXXXXXXXXXXXXXXXXX
```

Keys are issued per-team. A key scoped to team A cannot touch team B's data. Keys cannot be retrieved after issuance — if lost, a new one must be issued and the old one revoked.

**To get a key:** ask the UMAI AI team. Internal issuance:
```
node server/scripts/issue-api-key.js --team-slug <slug> --name "<consumer name>"
```
The full key is printed once; hand it off via 1Password, never Slack / email.

---

## 2. Endpoints

### `GET /availability/meeting-types`
List the meeting types available for your team. Call once at setup.

```bash
curl -H "Authorization: Bearer $KEY" \
  https://umai-booking.vercel.app/api/public/availability/meeting-types
```

Response:
```json
{
  "meeting_types": [
    {
      "id": 3,
      "name": "onboarding",
      "label": "Onboarding Call",
      "duration_minutes": 30,
      "buffer_minutes": 5,
      "min_advance_minutes": 60,
      "plans": ["mini", "pro"]
    }
  ]
}
```

### `GET /availability`
List free slots on a given date.

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://umai-booking.vercel.app/api/public/availability?meeting_type_id=3&date=2026-04-22&tz=Europe/Lisbon"
```

Response:
```json
{
  "date": "2026-04-22",
  "timezone": "Europe/Lisbon",
  "meeting_type_id": 3,
  "duration_minutes": 30,
  "slots": [
    { "slot_start": "2026-04-22T09:00:00.000Z", "slot_end": "2026-04-22T09:30:00.000Z" },
    { "slot_start": "2026-04-22T09:30:00.000Z", "slot_end": "2026-04-22T10:00:00.000Z" }
  ]
}
```

A slot is returned if **any** eligible rep is free. The rep is auto-assigned at booking time.

### `POST /bookings`
Create a confirmed booking. **Always send an `Idempotency-Key` header** (UUID).

```bash
curl -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "meeting_type_id": 3,
    "slot_start": "2026-04-22T09:00:00.000Z",
    "guest_name": "Maria Santos",
    "guest_email": "maria@restaurantx.com",
    "guest_phone": "+351 912 345 678",
    "guest_tz": "Europe/Lisbon",
    "lang": "pt"
  }' \
  https://umai-booking.vercel.app/api/public/bookings
```

Response (201):
```json
{
  "booking_id": 4271,
  "slot_start": "2026-04-22T09:00:00.000Z",
  "slot_end":   "2026-04-22T09:30:00.000Z",
  "status": "confirmed",
  "staff": { "name": "Leonardo", "email": "leonardo@letsumai.com" },
  "meeting_link": "https://meet.google.com/abc-defg-hij",
  "meeting_type": { "id": 3, "name": "onboarding", "label": "Onboarding Call" }
}
```

---

## 3. Idempotency

`POST /bookings` **requires** an `Idempotency-Key` header. Generate one UUID per booking attempt. If the request fails halfway (network drop, timeout) and you retry with the **same key and same body**, you get the original response back — no duplicate booking.

- Same key + same body, within 24h → original response replayed.
- Same key + **different** body → `409 IDEMPOTENCY_KEY_CONFLICT`. You're reusing a key for two different intents, which is a bug on your side.
- New key → treated as a new request.

Voice-agent best practice: generate the UUID at the **start** of the call-to-book flow and reuse it on every retry. Do not regenerate on retry.

---

## 4. Errors

All errors share the envelope:

```json
{
  "error": {
    "code": "SLOT_CONFLICT",
    "message": "Slot is no longer available.",
    "request_id": "5f4e9bc2-7f38-4f8d-b9c1-2a16f8d19b21"
  }
}
```

`request_id` is also returned in the `X-Request-Id` response header. Include it when reporting issues — it lets us grep the server logs.

**Common codes:**

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `MISSING_FIELDS` | A required field was omitted. |
| 400 | `INVALID_EMAIL` | `guest_email` is malformed. |
| 400 | `INVALID_DATE` | `date` / `slot_start` is malformed. |
| 400 | `UNSUPPORTED_TIMEZONE` | `tz` / `guest_tz` is not a valid IANA name. |
| 400 | `SLOT_IN_PAST` | `slot_start` is in the past. |
| 400 | `IDEMPOTENCY_KEY_MISSING` | `POST /bookings` was called without the header, or with a non-UUID value. |
| 401 | `API_KEY_MISSING` / `API_KEY_INVALID` | Auth failed. |
| 403 | `API_KEY_REVOKED` | Key was revoked. Contact UMAI. |
| 404 | `MEETING_TYPE_NOT_FOUND` | The `meeting_type_id` doesn't belong to your team. |
| 409 | `SLOT_CONFLICT` | Slot filled up or no rep available — refetch `/availability` and try again. |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | Same key reused with different body. Generate a fresh UUID. |
| 429 | `RATE_LIMITED` | Back off and retry. |
| 5xx | `INTERNAL_ERROR` | Our bug — include `request_id` in reports. |

---

## 5. Retell / Vapi / Bland setup

These platforms consume OpenAPI specs as function-call tools natively. Point them at:

```
https://umai-booking.vercel.app/api/public/openapi.yaml
```

Set a platform-level header:

```
Authorization: Bearer umai_live_XXXXXXXXXXXXXXXXXXXXX
```

The agent automatically discovers the three tools (`list_meeting_types`, `get_availability`, `create_booking`). For `create_booking`, have the platform generate an `Idempotency-Key` UUID at the start of each call and reuse it on retries.

**Suggested agent flow:**
1. Start-of-call: call `/availability/meeting-types`, cache the `id` of the type you want to book.
2. Ask the guest for their timezone; call `/availability` for the next day(s) they prefer.
3. Read a few slots out loud, let the guest pick one.
4. Ask for name, email, phone.
5. Call `POST /bookings` with the picked `slot_start` and guest info. Use the idempotency UUID generated at step 1.
6. Read the booking confirmation (and meeting link if present) back to the guest.

---

## 6. Versioning

This is v1. Breaking changes will ship at `/api/public/v2/...`. Additive fields in responses may appear at any time; consumers should tolerate unknown fields.

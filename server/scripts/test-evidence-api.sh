#!/usr/bin/env bash
# End-to-end smoke test for POST + GET /api/evidence against a running server.
# Prerequisites: server on :3001 with EVIDENCE_DEV_STORAGE=memory and CLIENT_SERVER_SECRET set.
#
# Usage:
#   cd server && npm run dev
#   ./scripts/test-evidence-api.sh http://localhost:3001 your-secret

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
SECRET="${2:-${CLIENT_SERVER_SECRET:-dev-secret}}"
AUTH="Authorization: Bearer ${SECRET}"

# Split curl body + trailing HTTP status (macOS head does not support -n -1).
split_http_response() {
  local raw="$1"
  HTTP_CODE=$(echo "$raw" | tail -n 1)
  HTTP_BODY=$(echo "$raw" | sed '$d')
}

echo "→ POST /api/evidence"
POST_RES=$(curl -sS -w "\n%{http_code}" -X POST "${BASE_URL}/api/evidence" \
  -H "Content-Type: application/json" \
  -H "${AUTH}" \
  -d '{
    "cameraId": "cam_010",
    "label": "Litter",
    "confidence": 0.83,
    "occurredAt": 1751470000000,
    "summary": "Smoke test litter event",
    "image": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q=="
  }')

split_http_response "$POST_RES"
echo "  HTTP ${HTTP_CODE}"
echo "  ${HTTP_BODY}"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "POST failed — is the server running with EVIDENCE_DEV_STORAGE=memory and CLIENT_SERVER_SECRET?"
  exit 1
fi

echo ""
echo "→ GET /api/evidence"
GET_RES=$(curl -sS -w "\n%{http_code}" "${BASE_URL}/api/evidence?cameraId=cam_010&limit=10" \
  -H "${AUTH}")

split_http_response "$GET_RES"
echo "  HTTP ${HTTP_CODE}"
echo "  ${HTTP_BODY}"

if [[ "$HTTP_CODE" != "200" ]]; then
  exit 1
fi

echo ""
echo "test-evidence-api: OK"

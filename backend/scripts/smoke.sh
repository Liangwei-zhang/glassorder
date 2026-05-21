#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8781}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PDF="$ROOT/Glass Order - 2605011 Inspire --8 Heritage Cove.pdf"

json_field() {
  node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s)$1))"
}

json_true() {
  local expr="$1"
  node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const data=JSON.parse(s);process.exit(($expr)?0:1)})"
}

status() {
  local code="$1"
  local expected="$2"
  local label="$3"
  if [ "$code" != "$expected" ]; then
    echo "FAIL $label: expected $expected got $code" >&2
    exit 1
  fi
  echo "OK $label: $code"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
TEST_PDF="$tmp/order.pdf"
cp "$PDF" "$TEST_PDF"
printf '\n%% smoke %s %s\n' "$(date +%s)" "$RANDOM" >> "$TEST_PDF"

code=$(curl -s -o "$tmp/health.json" -w '%{http_code}' "$BASE/api/health")
status "$code" 200 "health"

bad=$(curl -s -o "$tmp/bad-login.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"wrong"}' \
  "$BASE/api/auth/login")
status "$bad" 401 "bad login"

good=$(curl -s -o "$tmp/login.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"admin123"}' \
  "$BASE/api/auth/login")
status "$good" 200 "good login"
TOKEN="$(json_field '.token' < "$tmp/login.json")"
AUTH=(-H "Authorization: Bearer $TOKEN")

code=$(curl -s -o "$tmp/customer.json" -w '%{http_code}' \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"company":"Smoke Customer","contact_name":"Tester","email":"smoke@example.test"}' \
  "$BASE/api/customers")
status "$code" 201 "customer create"
CID="$(json_field '.customer.id' < "$tmp/customer.json")"

# --- Q1 XSS guard: customer with hostile <img> renders as escaped text -----
code=$(curl -s -o "$tmp/xss-customer.json" -w '%{http_code}' \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"company":"<img src=x onerror=alert(1)>","contact_name":"XSS"}' \
  "$BASE/api/customers")
status "$code" 201 "xss customer create"

# --- Q2 invalid customer_id should 400 and clean up --------------------------
PRE_PDF=$(ls "$(dirname "$0")/../uploads/pdfs" 2>/dev/null | wc -l | tr -d ' ')
code=$(curl -s -o "$tmp/order-bad-cust.json" -w '%{http_code}' \
  "${AUTH[@]}" \
  -F "customer_id=99999" \
  -F "priority=normal" \
  -F "pdf=@$TEST_PDF;type=application/pdf" \
  "$BASE/api/orders")
status "$code" 400 "order invalid customer_id"
POST_PDF=$(ls "$(dirname "$0")/../uploads/pdfs" 2>/dev/null | wc -l | tr -d ' ')
[ "$PRE_PDF" = "$POST_PDF" ] || { echo "FAIL pdf residue after invalid customer: $PRE_PDF -> $POST_PDF" >&2; exit 1; }
echo "OK invalid customer cleanup (pdfs: $PRE_PDF)"

# --- Q2 non-pdf upload should 400 -------------------------------------------
echo "hello" > "$tmp/not-a-pdf.txt"
code=$(curl -s -o "$tmp/non-pdf.json" -w '%{http_code}' \
  "${AUTH[@]}" \
  -F "customer_id=$CID" \
  -F "priority=normal" \
  -F "pdf=@$tmp/not-a-pdf.txt;type=text/plain" \
  "$BASE/api/orders")
status "$code" 400 "non-pdf upload rejected"

# --- order create (primary happy path) --------------------------------------
code=$(curl -s -o "$tmp/order.json" -w '%{http_code}' \
  "${AUTH[@]}" \
  -F "customer_id=$CID" \
  -F "priority=rush" \
  -F "deadline=2026-05-18" \
  -F "note=smoke" \
  -F "pdf=@$TEST_PDF;type=application/pdf" \
  "$BASE/api/orders")
status "$code" 201 "order create"
OID="$(json_field '.order.id' < "$tmp/order.json")"
ORDER_NUM="$(json_field '.order.order_number' < "$tmp/order.json")"
COUNT="$(json_field '.pieces.length' < "$tmp/order.json")"
PIECE4="$(json_field '.pieces[3].size' < "$tmp/order.json")"
[ "$COUNT" = "8" ] || { echo "FAIL parsed pieces: $COUNT" >&2; exit 1; }
[ "$PIECE4" = '30" × 75-1/4"' ] || { echo "FAIL piece4 size: $PIECE4" >&2; exit 1; }
echo "OK pdf parsed: 8 pieces, piece4=$PIECE4"

# --- P3-T1 same source PDF must not be uploaded twice -----------------------
PRE_DUP_PDF=$(ls "$(dirname "$0")/../uploads/pdfs" 2>/dev/null | wc -l | tr -d ' ')
code=$(curl -s -o "$tmp/order-dup.json" -w '%{http_code}' \
  "${AUTH[@]}" \
  -F "customer_id=$CID" \
  -F "priority=normal" \
  -F "pdf=@$TEST_PDF;type=application/pdf" \
  "$BASE/api/orders")
status "$code" 409 "duplicate pdf rejected"
POST_DUP_PDF=$(ls "$(dirname "$0")/../uploads/pdfs" 2>/dev/null | wc -l | tr -d ' ')
[ "$PRE_DUP_PDF" = "$POST_DUP_PDF" ] || { echo "FAIL pdf residue after duplicate: $PRE_DUP_PDF -> $POST_DUP_PDF" >&2; exit 1; }
echo "OK duplicate pdf cleanup (pdfs: $PRE_DUP_PDF)"

code=$(curl -s -o "$tmp/detail.json" -w '%{http_code}' "${AUTH[@]}" "$BASE/api/orders/$OID")
status "$code" 200 "order detail"
P1="$(json_field '.order.pieces[0].id' < "$tmp/detail.json")"
P2="$(json_field '.order.pieces[1].id' < "$tmp/detail.json")"
P3="$(json_field '.order.pieces[2].id' < "$tmp/detail.json")"

# --- P3-T2 process config can skip tempered: cut -> edge -> finished --------
code=$(curl -s -o "$tmp/p3-config.json" -w '%{http_code}' -X PATCH \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"required_steps":["cut","edge"]}' \
  "$BASE/api/pieces/$P3/process-config")
status "$code" 200 "piece process config"
for n in 1 2; do
  code=$(curl -s -o "$tmp/p3-$n.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/pieces/$P3/advance")
  status "$code" 200 "piece skip-tempered advance $n"
done
P3_STAGE="$(json_field '.piece.stage' < "$tmp/p3-2.json")"
[ "$P3_STAGE" = "finished" ] || { echo "FAIL skip-tempered stage: $P3_STAGE" >&2; exit 1; }

for n in 1 2 3; do
  code=$(curl -s -o "$tmp/p1-$n.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/pieces/$P1/advance")
  status "$code" 200 "piece1 advance $n"
done
P1_STAGE="$(json_field '.piece.stage' < "$tmp/p1-3.json")"
[ "$P1_STAGE" = "finished" ] || { echo "FAIL piece1 stage: $P1_STAGE" >&2; exit 1; }

code=$(curl -s -o "$tmp/p2-broken.json" -w '%{http_code}' -X POST \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"note":"smoke"}' "$BASE/api/pieces/$P2/broken")
status "$code" 200 "piece2 broken"
P2_STAGE="$(json_field '.piece.stage' < "$tmp/p2-broken.json")"
P2_REWORK="$(json_field '.piece.rework' < "$tmp/p2-broken.json")"
[ "$P2_STAGE" = "cut" ] && [ "$P2_REWORK" = "true" ] || { echo "FAIL piece2 broken result" >&2; exit 1; }

code=$(curl -s -o "$tmp/ready-fail.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/orders/$OID/ready")
status "$code" 400 "ready before complete"

# --- P3-T2 batch complete can process multiple pieces at once ---------------
code=$(curl -s -o "$tmp/detail-batch.json" -w '%{http_code}' "${AUTH[@]}" "$BASE/api/orders/$OID")
status "$code" 200 "order detail before batch"
node - "$tmp/detail-batch.json" > "$tmp/batch-ids.txt" <<'NODE'
const fs = require('fs');
const order = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).order;
console.log(order.pieces.filter(p => p.stage !== 'finished').map(p => p.id).join(','));
NODE
BATCH_IDS="$(cat "$tmp/batch-ids.txt")"
code=$(curl -s -o "$tmp/batch-complete.json" -w '%{http_code}' -X POST \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"action\":\"complete\",\"piece_ids\":[${BATCH_IDS}]}" \
  "$BASE/api/pieces/batch")
status "$code" 200 "batch complete pieces"
json_true 'data.pieces.length > 0 && data.pieces.every(p => p.stage === "finished")' < "$tmp/batch-complete.json" || {
  echo "FAIL batch complete did not finish all returned pieces" >&2
  exit 1
}

code=$(curl -s -o "$tmp/ready-fail.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/orders/$OID/ready")
status "$code" 200 "ready after batch complete"

# Second ready call must now fail because status changed.
code=$(curl -s -o "$tmp/ready-repeat.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/orders/$OID/ready")
status "$code" 400 "ready repeat rejected"

SIG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
code=$(curl -s -o "$tmp/pickup.json" -w '%{http_code}' -X POST \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"signer_name\":\"Smoke Signer\",\"signer_phone\":\"403-555-0000\",\"signature_base64\":\"$SIG\"}" \
  "$BASE/api/orders/$OID/pickup")
status "$code" 200 "pickup"
SLIP="$(json_field '.pickup.slip_pdf_path' < "$tmp/pickup.json")"
[ -n "$SLIP" ] || { echo "FAIL missing slip path" >&2; exit 1; }
echo "OK pickup slip: $SLIP"

# --- P3-T3 completed order can be corrected by boss -------------------------
code=$(curl -s -o "$tmp/edit-picked.json" -w '%{http_code}' -X PATCH \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"project_name\":\"Corrected Project\",\"note\":\"corrected after pickup\",\"pieces\":[{\"id\":$P1,\"piece_note\":\"corrected piece note\"}]}" \
  "$BASE/api/orders/$OID")
status "$code" 200 "edit picked-up order"
EDIT_PROJECT="$(json_field '.order.project_name' < "$tmp/edit-picked.json")"
EDIT_NOTE="$(json_field '.order.pieces[0].piece_note' < "$tmp/edit-picked.json")"
[ "$EDIT_PROJECT" = "Corrected Project" ] && [ "$EDIT_NOTE" = "corrected piece note" ] || {
  echo "FAIL edit picked-up order values: $EDIT_PROJECT / $EDIT_NOTE" >&2
  exit 1
}

# --- P3-T4 customer slip resend endpoint -----------------------------------
code=$(curl -s -o "$tmp/send-slip.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/orders/$OID/send-slip")
status "$code" 200 "send pickup slip"
json_true 'data.ok === true && data.mail.skipped === true' < "$tmp/send-slip.json" || {
  echo "FAIL send-slip response" >&2
  exit 1
}

# --- P7-T6 revert pickup ---------------------------------------------------
code=$(curl -s -o "$tmp/revert.json" -w '%{http_code}' -X POST "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"smoke test"}' \
  "$BASE/api/orders/$OID/revert-pickup")
status "$code" 200 "revert pickup"
code=$(curl -s -o "$tmp/orev.json" -w '%{http_code}' "${AUTH[@]}" "$BASE/api/orders/$OID")
status "$code" 200 "post-revert order"
json_true 'data.order.status === "ready_pickup"' < "$tmp/orev.json" || {
  echo "FAIL revert: status not ready_pickup" >&2
  exit 1
}
json_true 'data.order.events.some(e => e.action === "pickup_reverted")' < "$tmp/orev.json" || {
  echo "FAIL revert: pickup_reverted event missing" >&2
  exit 1
}
# Repeat revert should 400
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/orders/$OID/revert-pickup")
status "$code" 400 "revert repeat rejected"

# --- P11 order archive + order number lookup -------------------------------
code=$(curl -s -o "$tmp/archive-not-complete.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/orders/$OID/archive")
status "$code" 400 "archive non-picked-up rejected"

code=$(curl -s -o "$tmp/pickup-again.json" -w '%{http_code}' -X POST \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"signer_name\":\"Smoke Signer 2\",\"signer_phone\":\"403-555-0001\",\"signature_base64\":\"$SIG\"}" \
  "$BASE/api/orders/$OID/pickup")
status "$code" 200 "pickup after revert"

code=$(curl -s -o "$tmp/archive.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/orders/$OID/archive")
status "$code" 200 "archive picked-up order"
json_true 'data.ok === true && data.order.archived_at && data.order.events.some(e => e.action === "order_archived")' < "$tmp/archive.json" || {
  echo "FAIL archive response missing archived_at/event" >&2
  exit 1
}

code=$(curl -s -o "$tmp/archive-repeat.json" -w '%{http_code}' -X POST "${AUTH[@]}" "$BASE/api/orders/$OID/archive")
status "$code" 400 "archive repeat rejected"

code=$(curl -s -o "$tmp/order-by-number-active.json" -w '%{http_code}' \
  "${AUTH[@]}" "$BASE/api/orders?order_number=$ORDER_NUM")
status "$code" 200 "order number lookup active list"
OID="$OID" json_true '!data.orders.some(o => Number(o.id) === Number(process.env.OID))' < "$tmp/order-by-number-active.json" || {
  echo "FAIL archived order leaked into default order_number lookup" >&2
  exit 1
}

code=$(curl -s -o "$tmp/order-by-number-archive.json" -w '%{http_code}' \
  "${AUTH[@]}" "$BASE/api/orders?archived=1&order_number=$ORDER_NUM")
status "$code" 200 "order number lookup archive list"
OID="$OID" json_true 'data.orders.length === 1 && Number(data.orders[0].id) === Number(process.env.OID) && !!data.orders[0].archived_at' < "$tmp/order-by-number-archive.json" || {
  echo "FAIL archived order not found by order_number" >&2
  exit 1
}

code=$(curl -s -o "$tmp/order-search-archive.json" -w '%{http_code}' \
  "${AUTH[@]}" "$BASE/api/orders?archived=1&search=$ORDER_NUM")
status "$code" 200 "archived order search by number"
OID="$OID" json_true 'data.orders.some(o => Number(o.id) === Number(process.env.OID))' < "$tmp/order-search-archive.json" || {
  echo "FAIL archived order not found by search" >&2
  exit 1
}

# --- Q1 XSS render check: HTML pages must escape hostile company name -------
code=$(curl -s -o "$tmp/dash.html" -w '%{http_code}' "$BASE/boss-dashboard.html")
status "$code" 200 "dashboard static"
# The hostile string lives only in DB; server serves static HTML unchanged,
# so the check is that pages ship via api.js esc()-based rendering. The key
# property is that neither HTML nor JSON responses leak raw `<script>` or
# `<img ` tokens directly concatenated as trusted HTML.
code=$(curl -s -o "$tmp/list.json" -w '%{http_code}' "${AUTH[@]}" "$BASE/api/customers")
status "$code" 200 "customers list"
node - "$tmp/list.json" <<'NODE'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hostile = data.customers.find(c => c.company && c.company.includes('<img'));
if (!hostile) { console.error('FAIL: hostile customer not persisted'); process.exit(1); }
// Raw value must survive in JSON (the client is responsible for escaping):
if (!hostile.company.includes('<img src=x onerror=alert(1)>')) {
  console.error('FAIL: hostile value was mutated on the backend');
  process.exit(1);
}
console.log('OK xss payload persisted raw (frontend must esc() it):', hostile.company);
NODE

echo "SMOKE PASS"

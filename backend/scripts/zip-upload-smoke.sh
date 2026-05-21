#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8781}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ZIP="$ROOT/glassorder-20260517T053732Z-3-001.zip"

json_field() {
  node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s)$1))"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unzip -q "$ZIP" -d "$tmp"

login_code=$(curl -s -o "$tmp/login.json" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"admin123"}' \
  "$BASE/api/auth/login")
[ "$login_code" = "200" ] || { echo "FAIL login: $login_code" >&2; exit 1; }
TOKEN="$(json_field '.token' < "$tmp/login.json")"
AUTH=(-H "Authorization: Bearer $TOKEN")

customer_code=$(curl -s -o "$tmp/customer.json" -w '%{http_code}' \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"company":"ZIP Upload Smoke","contact_name":"QA","email":"zip-smoke@example.test"}' \
  "$BASE/api/customers")
[ "$customer_code" = "201" ] || { echo "FAIL customer: $customer_code" >&2; exit 1; }
CID="$(json_field '.customer.id' < "$tmp/customer.json")"

ok=0
dup=0
fail=0
seen_hashes="$tmp/seen_hashes"
: > "$seen_hashes"

while IFS= read -r -d '' pdf; do
  hash="$(sha256sum "$pdf" | awk '{print $1}')"
  code=$(curl -s -o "$tmp/upload.json" -w '%{http_code}' \
    "${AUTH[@]}" \
    -F "customer_id=$CID" \
    -F "priority=normal" \
    -F "pdf=@$pdf;type=application/pdf" \
    "$BASE/api/orders")
  if grep -qx "$hash" "$seen_hashes"; then
    if [ "$code" = "409" ]; then
      dup=$((dup + 1))
      echo "OK duplicate rejected: $(basename "$pdf")"
    else
      echo "FAIL duplicate $(basename "$pdf"): expected 409 got $code" >&2
      fail=$((fail + 1))
    fi
  else
    if [ "$code" = "201" ]; then
      ok=$((ok + 1))
      echo "OK uploaded: $(basename "$pdf")"
      echo "$hash" >> "$seen_hashes"
    elif [ "$code" = "409" ]; then
      dup=$((dup + 1))
      echo "OK already existed: $(basename "$pdf")"
      echo "$hash" >> "$seen_hashes"
    else
      echo "FAIL upload $(basename "$pdf"): $code" >&2
      cat "$tmp/upload.json" >&2 || true
      fail=$((fail + 1))
    fi
  fi
done < <(find "$tmp" -type f -name '*.pdf' -print0 | sort -z)

total=$((ok + dup + fail))
[ "$total" -gt 0 ] || { echo "FAIL no PDFs found in zip" >&2; exit 1; }
[ "$fail" = "0" ] || { echo "FAIL zip upload smoke: ok=$ok dup=$dup fail=$fail" >&2; exit 1; }
echo "ZIP SMOKE PASS ok=$ok duplicate_or_existing=$dup total=$total"

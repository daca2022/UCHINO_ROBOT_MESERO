#!/bin/bash
# smoke_session_isolation.sh
# Verifica que sesiones distintas no se contaminan entre sí.
# Exit 0 = PASS, !=0 = FAIL.

set -e
ORCH_URL="${ORCH_URL:-http://localhost:8100}"
BACKEND_URL="${BACKEND_URL:-http://localhost:3005}"
DB_CMD="docker exec chipi_postgres psql -U chipi -d robot_mesero -t -A -c"

declare -a TESTS=(
    "iso-smoke-A|dame una chicha por favor|6|Chicha Morada"
    "iso-smoke-B|dame un ceviche por favor|9|Ceviche"
    "iso-smoke-C|dame un lomo saltado por favor|9|Lomo Saltado"
    "iso-smoke-D|dame dos tallarines por favor|4|Tallarines"
)

PASS=0
FAIL=0
declare -a FAILED

for entry in "${TESTS[@]}"; do
    IFS='|' read -r sess text mesa expected_product <<< "$entry"
    echo "--- Test: $sess mesa=$mesa product=$expected_product ---"

    response=$(curl -s -m 90 -X POST "$ORCH_URL/orchestrate" \
        -H "Content-Type: application/json" \
        -d "{\"text\":\"$text\",\"session_id\":\"$sess\",\"metadata\":{\"turn_id\":\"t1\",\"mesa\":\"$mesa\",\"client_id\":\"cli-$sess\"}}" 2>&1) || true

    if [ -z "$response" ]; then
        echo "  FAIL: empty response (orchestrator timeout)"
        FAIL=$((FAIL+1))
        FAILED+=("$sess: empty response")
        continue
    fi

    mesa_in_response=$(echo "$response" | python3 -c "import sys,json
d=json.load(sys.stdin)
for a in d.get('actions',[]):
    if a.get('name') == 'registrar_pedido':
        print(a.get('args',{}).get('mesa',''))
        break
" 2>/dev/null || echo "")

    product_in_response=$(echo "$response" | python3 -c "import sys,json
d=json.load(sys.stdin)
for a in d.get('actions',[]):
    if a.get('name') == 'registrar_pedido':
        for p in a.get('args',{}).get('platos',[]):
            print(p.get('nombre',''))
            break
        b = a.get('args',{}).get('bebida')
        if b:
            print(b)
        break
" 2>/dev/null || echo "")

    if [ "$mesa_in_response" = "$mesa" ]; then
        echo "  mesa OK ($mesa_in_response)"
    else
        echo "  FAIL: mesa expected=$mesa got=$mesa_in_response"
        FAIL=$((FAIL+1))
        FAILED+=("$sess: mesa mismatch")
    fi

    if echo "$product_in_response" | grep -q "$expected_product"; then
        echo "  product OK ($product_in_response)"
        PASS=$((PASS+1))
    else
        echo "  FAIL: expected product '$expected_product' got '$product_in_response'"
        FAIL=$((FAIL+1))
        FAILED+=("$sess: product mismatch")
    fi
done

echo ""
echo "=== Resumen session_isolation ==="
echo "PASS: $PASS / $((PASS+FAIL))"
if [ $FAIL -gt 0 ]; then
    echo "FAILED:"
    for f in "${FAILED[@]}"; do
        echo "  - $f"
    done
    exit 1
fi
exit 0

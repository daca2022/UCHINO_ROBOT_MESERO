#!/bin/bash
# smoke_text_order.sh
# Verifica que el pedido se crea correctamente con el producto y mesa correctos.

set -e
ORCH_URL="${ORCH_URL:-http://localhost:8100}"
BACKEND_URL="${BACKEND_URL:-http://localhost:3005}"

SESS="iso-text-$$"
MESA="5"
TEXT="dame un ceviche por favor"

echo "=== Test: text order crea pedido draft con mesa=$MESA ==="
response=$(curl -s -m 90 -X POST "$ORCH_URL/orchestrate" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"$TEXT\",\"session_id\":\"$SESS\",\"metadata\":{\"turn_id\":\"t1\",\"mesa\":\"$MESA\",\"client_id\":\"cli-$SESS\"}}")

pedido_id=$(echo "$response" | python3 -c "import sys,json
d=json.load(sys.stdin)
for a in d.get('actions',[]):
    if a.get('name') == 'registrar_pedido':
        ped = a.get('result',{}).get('pedido',{})
        print(ped.get('id',''))
        break
" 2>/dev/null || echo "")

if [ -z "$pedido_id" ]; then
    echo "FAIL: no pedido created"
    exit 1
fi
echo "Pedido creado: $pedido_id"

mesa_bd=$(docker exec chipi_postgres psql -U chipi -d robot_mesero -t -A -c "SELECT mesa FROM pedidos WHERE id = '$pedido_id';" 2>/dev/null || echo "")
status_bd=$(docker exec chipi_postgres psql -U chipi -d robot_mesero -t -A -c "SELECT status FROM pedidos WHERE id = '$pedido_id';" 2>/dev/null || echo "")
mode_bd=$(docker exec chipi_postgres psql -U chipi -d robot_mesero -t -A -c "SELECT mode FROM pedidos WHERE id = '$pedido_id';" 2>/dev/null || echo "")
product_bd=$(docker exec chipi_postgres psql -U chipi -d robot_mesero -t -A -c "SELECT platos->0->>'nombre' FROM pedidos WHERE id = '$pedido_id';" 2>/dev/null || echo "")

echo "BD mesa=$mesa_bd status=$status_bd mode=$mode_bd product=$product_bd"

if [ "$mesa_bd" != "$MESA" ]; then
    echo "FAIL: mesa BD=$mesa_bd expected=$MESA"
    exit 1
fi

if [ "$status_bd" != "draft" ]; then
    echo "FAIL: status BD=$status_bd expected=draft (no sent_to_kitchen sin confirmación)"
    exit 1
fi

if [ "$mode_bd" != "voice" ]; then
    echo "FAIL: mode BD=$mode_bd expected=voice"
    exit 1
fi

if [ "$product_bd" != "Ceviche" ]; then
    echo "FAIL: product BD=$product_bd expected=Ceviche"
    exit 1
fi

echo "PASS: text_order OK"
exit 0

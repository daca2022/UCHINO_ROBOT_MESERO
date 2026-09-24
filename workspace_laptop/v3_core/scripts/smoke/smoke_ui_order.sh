#!/bin/bash
# smoke_ui_order.sh
# Verifica que un pedido voice aparece en /cocina tras el ciclo correcto:
# 1) crear draft, 2) confirmar a sent_to_kitchen, 3) consultar /api/cocina/cola.

set -e
ORCH_URL="${ORCH_URL:-http://localhost:8100}"
BACKEND_URL="${BACKEND_URL:-http://localhost:3005}"

SESS="iso-ui-$$"
MESA="7"
TEXT="dame un lomo saltado por favor"

echo "=== Test: voice -> draft -> confirmar -> aparece en cocina ==="

# 1) Crear draft
echo "--- T1: crear pedido draft ---"
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
    echo "FAIL: T1 no creo pedido"
    exit 1
fi
echo "  pedido: $pedido_id"

status_bd=$(docker exec chipi_postgres psql -U chipi -d robot_mesero -t -A -c "SELECT status FROM pedidos WHERE id = '$pedido_id';" 2>/dev/null || echo "")
if [ "$status_bd" != "draft" ]; then
    echo "FAIL: status expected=draft got=$status_bd"
    exit 1
fi
echo "  draft OK"

# 2) Confirmar (mismo session)
echo "--- T2: confirmar pedido ---"
curl -s -m 30 -X POST "$ORCH_URL/orchestrate" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"si confirma por favor\",\"session_id\":\"$SESS\",\"metadata\":{\"turn_id\":\"t2\",\"mesa\":\"$MESA\",\"client_id\":\"cli-$SESS\"}}" > /dev/null

status_bd=$(docker exec chipi_postgres psql -U chipi -d robot_mesero -t -A -c "SELECT status FROM pedidos WHERE id = '$pedido_id';" 2>/dev/null || echo "")
if [ "$status_bd" != "sent_to_kitchen" ]; then
    # Fallback: confirmar manualmente
    echo "  WARN: LLM no confirmó, intentando manual"
    curl -s -X POST "$BACKEND_URL/api/pedidos/$pedido_id/confirmar" -o /dev/null -w "  manual HTTP %{http_code}\n"
    status_bd=$(docker exec chipi_postgres psql -U chipi -d robot_mesero -t -A -c "SELECT status FROM pedidos WHERE id = '$pedido_id';" 2>/dev/null || echo "")
fi

if [ "$status_bd" != "sent_to_kitchen" ]; then
    echo "FAIL: status expected=sent_to_kitchen got=$status_bd"
    exit 1
fi
echo "  sent_to_kitchen OK"

# 3) Verificar /api/cocina/cola
echo "--- T3: aparece en /api/cocina/cola ---"
cocina_response=$(curl -s -m 5 "$BACKEND_URL/api/cocina/cola")
encontrado=$(echo "$cocina_response" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    items = d if isinstance(d, list) else d.get('data', d.get('enviados', d.get('cola', [])))
    pid = '$pedido_id'
    for it in items:
        if it.get('id') == pid:
            print('yes')
            sys.exit(0)
    print('no')
except Exception:
    print('error')
" 2>/dev/null || echo "error")

if [ "$encontrado" = "yes" ]; then
    echo "  aparece en cocina OK"
    echo "PASS: ui_order OK"
    exit 0
fi

echo "  no aparece en cocina (encontrado=$encontrado)"
echo "  respuesta cocina: $cocina_response" | head -c 300
exit 1

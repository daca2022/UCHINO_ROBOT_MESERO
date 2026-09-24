# Uchino Frontend UI

## Cómo levantar el sistema (comandos exactos)

### Paso 1: Docker (bases de datos)

```bash
cd ~/chipi_workspace_pln/v3_core
docker compose -f docker/docker-compose.infra.yml up -d
```

Verifica: `docker ps | grep chipi_` (deben salir 4 contenedores)

### Paso 2: Backend (Node.js)

```bash
tmux new-session -d -s backend 'cd /home/david/chipi_workspace_pln/v3_core/backend_api && node src/server.mjs'
```

Verifica: `curl http://localhost:3005/api/status`
Debe devolver: `{"status":"ok"...}`

Para ver los logs del backend:
```bash
tmux attach -t backend
# Para salir sin matar: Ctrl+B, luego D
```

### Paso 3: Frontend (Vite)

```bash
tmux new-session -d -s frontend 'cd /home/david/chipi_workspace_pln/v3_core/frontend_ui && npm run dev'
```

Verifica: `curl http://localhost:5173/robot.html`
Debe devolver: `200`

Para ver los logs del frontend:
```bash
tmux attach -t frontend
# Para salir sin matar: Ctrl+B, luego D
```

### Paso 4: Abrir en navegador

- http://localhost:5173/robot.html — Pantalla táctil del robot (cliente)
- http://localhost:5173/cocina.html — KDS Cocina
- http://localhost:5173/admin.html — Dashboard Admin

### Pestaña "Carta" en Admin

La página Admin tiene una pestaña **"🍽️ Carta"** donde el mesero/administrador puede:
1. Seleccionar la mesa (input editable)
2. Navegar por categorías: Platos, Bebidas, Postres
3. Agregar items al carrito (click en cada plato)
4. Ajustar cantidades (+/−) o eliminar items
5. Confirmar el pedido — se envía al backend igual que desde el robot
6. El pedido aparece automáticamente en la Cocina KDS

### Para la tablet (red local)

```bash
cd /home/david/chipi_workspace_pln/v3_core/frontend_ui
npx vite --host --port 5173
```

En la tablet: `http://IP_DE_TU_LAPTOP:5173/robot.html`

### Si algo falla

**Ver qué está corriendo:**
```bash
tmux ls
```

**Backend no responde:**
```bash
# Matar y reiniciar
tmux kill-session -t backend
tmux new-session -d -s backend 'cd /home/david/chipi_workspace_pln/v3_core/backend_api && node src/server.mjs'
```

**Frontend no responde:**
```bash
# Matar y reiniciar
tmux kill-session -t frontend
tmux new-session -d -s frontend 'cd /home/david/chipi_workspace_pln/v3_core/frontend_ui && npm run dev'
```

**Página vacía:** El backend debe estar en `:3005` ANTES de iniciar el frontend.

**Error de puerto ocupado:**
```bash
# Si dice "EADDRINUSE :::3005"
lsof -ti:3005 | xargs kill -9

# Si dice "EADDRINUSE :::5173"
lsof -ti:5173 | xargs kill -9
```

### Comandos útiles

| Ver logs backend | `tmux attach -t backend` |
| Ver logs frontend | `tmux attach -t frontend` |
| Matar backend | `tmux kill-session -t backend` |
| Matar frontend | `tmux kill-session -t frontend` |
| Ver todo activo | `curl http://localhost:3005/api/status` |
| Ver sesiones tmux | `tmux ls` |

## Estado actual del sistema

```bash
curl http://localhost:3005/api/status
```

Responde con:
- `status`: ok / error
- `databases`: postgresql, redis, chromadb (true/false)
- `llm`: primary, fallback (true/false)
- `ros2`: available, state
- `recorrido`: available, estado

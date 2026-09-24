#!/usr/bin/env python3
"""Integration tests verifying function calls persist data to in-memory stores.

These tests validate graceful degradation: when PostgreSQL and ChromaDB are
unavailable, all CRUD operations fall back to in-memory dict/list stores.
"""

import pytest
from memory.function_handlers import FunctionCallHandler
from memory.handler_router import HandlerRouter


class TestPersistenceIntegration:
    """Integration tests for function call → storage persistence."""

    @pytest.fixture
    def handler(self):
        """Handler with in-memory fallback (no DB, no ChromaDB)."""
        return FunctionCallHandler(db_session=None, chroma_client=None)

    @pytest.fixture
    def router(self, handler):
        return HandlerRouter(handler)

    # ── Test 1: registrar_pedido persists in _pedidos dict ─────────────────

    @pytest.mark.asyncio
    async def test_registrar_pedido_persists_in_memory(self, handler):
        """registrar_pedido stores pedido in _pedidos dict when no DB."""
        result = await handler.registrar_pedido({
            "mesa": "M3",
            "platos": [
                {"nombre": "café pasado", "cantidad": 2, "precio": 10.0},
                {"nombre": "sánguche de pollo", "cantidad": 1, "precio": 12.0},
            ],
            "total": 22.0,
        })

        assert result["success"] is True
        assert "pedido_id" in result
        pedido_id = result["pedido_id"]
        assert pedido_id is not None

        # Verify persistence in internal store
        assert pedido_id in handler._pedidos
        stored = handler._pedidos[pedido_id]
        assert stored["mesa"] == "M3"
        assert len(stored["platos"]) == 2
        assert stored["total"] == 22.0
        assert stored["estado"] == "provisional"

    # ── Test 2: confirmar_pedido updates in-memory state ───────────────────

    @pytest.mark.asyncio
    async def test_confirmar_pedido_updates_in_memory_status(self, handler):
        """confirmar_pedido marks pedido as 'confirmado' in _pedidos dict."""
        reg_result = await handler.registrar_pedido({
            "mesa": "M1",
            "platos": [{"nombre": "café", "cantidad": 1, "precio": 5.0}],
            "total": 5.0,
        })
        pedido_id = reg_result["pedido_id"]

        # Confirm via handler (uses _last_pedido_id internally)
        result = await handler.confirmar_pedido({})
        assert result["success"] is True
        assert "confirmado" in result["message"].lower()

        # Verify in-memory persistence
        assert handler._pedidos[pedido_id]["estado"] == "confirmado"

    # ── Test 3: cancelar_pedido updates in-memory state ────────────────────

    @pytest.mark.asyncio
    async def test_cancelar_pedido_updates_in_memory_status(self, handler):
        """cancelar_pedido marks pedido as 'cancelado' in _pedidos dict."""
        reg_result = await handler.registrar_pedido({
            "mesa": "M2",
            "platos": [{"nombre": "jugo de naranja", "cantidad": 1, "precio": 8.0}],
            "total": 8.0,
        })
        pedido_id = reg_result["pedido_id"]

        result = await handler.cancelar_pedido({})
        assert result["success"] is True
        assert "cancelado" in result["message"].lower()

        # Verify in-memory persistence
        assert handler._pedidos[pedido_id]["estado"] == "cancelado"

    # ── Test 4: guardar_memoria persists in _memory_store list ─────────────

    @pytest.mark.asyncio
    async def test_guardar_memoria_persists_in_memory(self, handler):
        """guardar_memoria appends entry to _memory_store when no DB/ChromaDB."""
        result = await handler.guardar_memoria({
            "categoria": "preferencia",
            "clave": "cliente_cafe_favorito",
            "valor": "café pasado sin azúcar",
        })

        assert result["success"] is True
        assert result["categoria"] == "preferencia"
        assert result["clave"] == "cliente_cafe_favorito"

        # Verify persistence in internal store
        assert len(handler._memory_store) == 1
        entry = handler._memory_store[0]
        assert entry["categoria"] == "preferencia"
        assert entry["clave"] == "cliente_cafe_favorito"
        assert entry["valor"] == "café pasado sin azúcar"
        assert "timestamp" in entry

    @pytest.mark.asyncio
    async def test_guardar_memoria_multiple_entries(self, handler):
        """Multiple guardar_memoria calls accumulate in _memory_store."""
        await handler.guardar_memoria({
            "categoria": "hecho", "clave": "horario", "valor": "8am",
        })
        await handler.guardar_memoria({
            "categoria": "preferencia", "clave": "postre", "valor": "tiramisú",
        })

        assert len(handler._memory_store) == 2
        assert handler._memory_store[0]["valor"] == "8am"
        assert handler._memory_store[1]["valor"] == "tiramisú"

    # ── Test 5: Full flow via HandlerRouter ────────────────────────────────

    @pytest.mark.asyncio
    async def test_full_flow_order_confirm_remember(self, handler, router):
        """Full flow: order → confirm → save memory — all persist and succeed."""
        # 1. Register order via router
        order_call = {
            "name": "registrar_pedido",
            "args": {
                "mesa": "M5",
                "platos": [{"nombre": "lomo saltado", "cantidad": 1, "precio": 18.0}],
                "total": 18.0,
            },
        }
        order_result = await router.route(order_call)
        assert order_result["success"] is True
        pedido_id = order_result["pedido_id"]

        # Verify router-persisted data in handler's internal store
        assert pedido_id in handler._pedidos
        assert handler._pedidos[pedido_id]["estado"] == "provisional"

        # 2. Confirm order via router
        confirm_call = {"name": "confirmar_pedido", "args": {}}
        confirm_result = await router.route(confirm_call)
        assert confirm_result["success"] is True

        # Verify status change persisted
        assert handler._pedidos[pedido_id]["estado"] == "confirmado"

        # 3. Remember preference via router
        memory_call = {
            "name": "guardar_memoria",
            "args": {
                "categoria": "preferencia",
                "clave": "mesa5_favorito",
                "valor": "lomo saltado",
            },
        }
        memory_result = await router.route(memory_call)
        assert memory_result["success"] is True

        # Verify memory persisted in store
        assert len(handler._memory_store) == 1
        assert handler._memory_store[0]["clave"] == "mesa5_favorito"

    # ── Test 6: Unknown function via router ────────────────────────────────

    @pytest.mark.asyncio
    async def test_unknown_function_returns_error(self, router):
        """Unknown function routed through HandlerRouter returns error."""
        result = await router.route({"name": "funcion_que_no_existe", "args": {}})
        assert result["success"] is False
        assert "desconocida" in result.get("error", "").lower()

    # ── Test 7: confirmar without prior registro returns error ─────────────

    @pytest.mark.asyncio
    async def test_confirmar_sin_pedido_previo_returns_error(self, handler):
        """confirmar_pedido with no prior registration returns error."""
        result = await handler.confirmar_pedido({})
        assert result["success"] is False
        assert "no hay pedido" in result["error"].lower()

    # ── Test 8: cancelar without prior registro returns error ──────────────

    @pytest.mark.asyncio
    async def test_cancelar_sin_pedido_previo_returns_error(self, handler):
        """cancelar_pedido with no prior registration returns error."""
        result = await handler.cancelar_pedido({})
        assert result["success"] is False
        assert "no hay pedido" in result["error"].lower()

#!/usr/bin/env python3
"""TDD test suite for Qwen function call handlers."""

import pytest
from memory.function_handlers import FunctionCallHandler
from memory.handler_router import HandlerRouter


@pytest.fixture
def handler():
    return FunctionCallHandler(db_session=None, chroma_client=None)


@pytest.fixture
def router(handler):
    return HandlerRouter(handler)


@pytest.mark.asyncio
async def test_registrar_pedido_creates_pedido(handler):
    params = {
        "mesa": "Mesa 1",
        "platos": [
            {"nombre": "Café con leche", "cantidad": 2, "precio": 3.5},
            {"nombre": "Croissant", "cantidad": 1, "precio": 2.0},
        ],
        "bebida": "Agua",
        "total": 9.0,
    }
    result = await handler.registrar_pedido(params)
    assert result["success"] is True
    assert "pedido_id" in result
    assert result["message"] == "Pedido registrado"


@pytest.mark.asyncio
async def test_registrar_pedido_requires_platos(handler):
    params = {"mesa": "Mesa 1"}
    result = await handler.registrar_pedido(params)
    assert result["success"] is False
    assert "platos" in result["error"].lower() or "requerido" in result["error"].lower()


@pytest.mark.asyncio
async def test_registrar_pedido_requires_non_empty_platos(handler):
    params = {"mesa": "Mesa 1", "platos": []}
    result = await handler.registrar_pedido(params)
    assert result["success"] is False


@pytest.mark.asyncio
async def test_confirmar_pedido_marks_confirmed(handler):
    reg = await handler.registrar_pedido({
        "mesa": "Mesa 2",
        "platos": [{"nombre": "Tostadas", "cantidad": 1, "precio": 4.0}],
    })
    result = await handler.confirmar_pedido({})
    assert result["success"] is True
    assert "confirmado" in result["message"].lower()


@pytest.mark.asyncio
async def test_cancelar_pedido_marks_cancelled(handler):
    reg = await handler.registrar_pedido({
        "mesa": "Mesa 3",
        "platos": [{"nombre": "Jugo", "cantidad": 1, "precio": 3.0}],
    })
    result = await handler.cancelar_pedido({})
    assert result["success"] is True
    assert "cancelado" in result["message"].lower()


@pytest.mark.asyncio
async def test_guardar_memoria_preferencia(handler):
    params = {
        "categoria": "preferencia",
        "clave": "cliente_001_cafe",
        "valor": "Le gusta el café sin azúcar",
    }
    result = await handler.guardar_memoria(params)
    assert result["success"] is True
    assert result["categoria"] == "preferencia"
    assert result["clave"] == "cliente_001_cafe"
    assert len(handler._memory_store) == 1
    assert handler._memory_store[0]["valor"] == "Le gusta el café sin azúcar"


@pytest.mark.asyncio
async def test_guardar_memoria_hecho(handler):
    params = {
        "categoria": "hecho",
        "clave": "horario_apertura",
        "valor": "El café abre a las 7am",
    }
    result = await handler.guardar_memoria(params)
    assert result["success"] is True
    assert result["categoria"] == "hecho"


@pytest.mark.asyncio
async def test_guardar_memoria_requires_clave_valor(handler):
    result = await handler.guardar_memoria({"categoria": "hecho", "clave": "", "valor": "x"})
    assert result["success"] is False

    result2 = await handler.guardar_memoria({"categoria": "hecho", "clave": "x", "valor": ""})
    assert result2["success"] is False


@pytest.mark.asyncio
async def test_expresar_emocion_valid(handler):
    result = await handler.expresar_emocion({"emocion": "feliz", "mensaje": "¡Hola!"})
    assert result["success"] is True
    assert result["emocion"] == "feliz"
    assert result["mensaje"] == "¡Hola!"


@pytest.mark.asyncio
async def test_expresar_emocion_invalid(handler):
    result = await handler.expresar_emocion({"emocion": "enojado"})
    assert result["success"] is False
    assert "inválida" in result["error"].lower() or "invalid" in result["error"].lower()


@pytest.mark.asyncio
async def test_expresar_emocion_defaults_to_pensando(handler):
    result = await handler.expresar_emocion({})
    assert result["success"] is True
    assert result["emocion"] == "pensando"


@pytest.mark.asyncio
async def test_ir_a_lugar_valid(handler):
    for lugar in ["MESA", "COCINA", "UTENSILIOS", "BEBIDAS", "CAJA", "BASE"]:
        result = await handler.ir_a_lugar({"lugar": lugar})
        assert result["success"] is True, f"Failed for {lugar}"
        assert result["lugar"] == lugar


@pytest.mark.asyncio
async def test_ir_a_lugar_invalid(handler):
    result = await handler.ir_a_lugar({"lugar": "BANO"})
    assert result["success"] is False
    assert "inválido" in result["error"].lower() or "invalid" in result["error"].lower()


@pytest.mark.asyncio
async def test_router_dispatches_registrar_pedido(router):
    call = {
        "name": "registrar_pedido",
        "args": {
            "mesa": "Mesa R",
            "platos": [{"nombre": "Pan", "cantidad": 1, "precio": 1.0}],
        },
    }
    result = await router.route(call)
    assert result["success"] is True
    assert "pedido_id" in result


@pytest.mark.asyncio
async def test_router_dispatches_guardar_memoria(router):
    call = {
        "name": "guardar_memoria",
        "args": {
            "categoria": "cliente",
            "clave": "nombre",
            "valor": "Juan",
        },
    }
    result = await router.route(call)
    assert result["success"] is True


@pytest.mark.asyncio
async def test_router_returns_error_for_unknown_function(router):
    result = await router.route({"name": "funcion_inventada", "args": {}})
    assert result["success"] is False
    assert "desconocida" in result["error"].lower() or "unknown" in result["error"].lower()


@pytest.mark.asyncio
async def test_router_catches_handler_exception(router, handler, monkeypatch):
    async def boom(_):
        raise RuntimeError("boom")
    monkeypatch.setattr(handler, "confirmar_pedido", boom)

    result = await router.route({"name": "confirmar_pedido", "args": {}})
    assert result["success"] is False
    assert "boom" in result["error"]

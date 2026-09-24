import pytest
from unittest.mock import patch, AsyncMock, MagicMock

requires_api = pytest.mark.skip(reason="Requires real Qwen API keys")


def _mock_httpx_client(response):
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=response)
    return mock_client


class TestQwenTextPipeline:
    @pytest.mark.asyncio
    async def test_text_pipeline_sends_message_and_receives_response(self):
        from dialogue.llm_client import LlmClient

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "text": "¡Buenos días! ¿Un cafecito? Claro pe, ¿algo más se le antoja?",
            "functionCalls": [],
            "provider": "qwen-flash-dashscope"
        }

        with patch("dialogue.llm_client.httpx.AsyncClient", return_value=_mock_httpx_client(mock_response)):
            client = LlmClient(base_url="http://localhost:3003/api/llm")
            result = await client.send_message("Hola, quiero un café")

            assert result["text"] != ""
            assert "café" in result["text"].lower() or "cafe" in result["text"].lower()
            assert isinstance(result["functionCalls"], list)
            assert result["provider"] == "qwen-flash-dashscope"

    @pytest.mark.asyncio
    async def test_text_pipeline_returns_function_calls(self):
        from dialogue.llm_client import LlmClient

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "text": "¡Al toque! Un lomo saltado y una Inca Kola.",
            "functionCalls": [{
                "name": "registrar_pedido",
                "args": {
                    "mesa": "M3",
                    "platos": [
                        {"nombre": "Lomo Saltado", "cantidad": 1, "precio": 18.0},
                        {"nombre": "Inca Kola", "cantidad": 1, "precio": 5.0}
                    ],
                    "total": 23.0
                }
            }],
            "provider": "qwen-flash-openrouter"
        }

        with patch("dialogue.llm_client.httpx.AsyncClient", return_value=_mock_httpx_client(mock_response)):
            client = LlmClient()
            result = await client.send_message("Quiero un lomo saltado y una Inca Kola")

            assert len(result["functionCalls"]) > 0
            assert result["functionCalls"][0]["name"] == "registrar_pedido"
            assert result["functionCalls"][0]["args"]["mesa"] == "M3"

    @pytest.mark.asyncio
    async def test_dialogue_state_transition(self):
        from dialogue.llm_client import LlmClient

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "response": "¡Bienvenido! ¿Qué se le antoja hoy?",
            "newState": "taking_order",
            "emotion": "feliz",
            "functionCalls": []
        }

        with patch("dialogue.llm_client.httpx.AsyncClient", return_value=_mock_httpx_client(mock_response)):
            client = LlmClient()
            result = await client.send_dialogue(state="greeting", input_text="Hola")

            assert result["newState"] == "taking_order"
            assert result["emotion"] == "feliz"
            assert result["response"] != ""

    @pytest.mark.asyncio
    async def test_function_call_handling(self):
        from dialogue.llm_client import LlmClient

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "success": True,
            "result": {"pedido_id": "test-123"},
            "name": "registrar_pedido"
        }

        with patch("dialogue.llm_client.httpx.AsyncClient", return_value=_mock_httpx_client(mock_response)):
            client = LlmClient()
            result = await client.handle_function_call({
                "name": "registrar_pedido",
                "args": {"mesa": "M3", "platos": [{"nombre": "café", "cantidad": 1, "precio": 5}]}
            })

            assert result["success"] is True
            assert result["result"]["pedido_id"] == "test-123"
            assert result["name"] == "registrar_pedido"


class TestQwenFallbackSmoke:
    @pytest.mark.asyncio
    async def test_fallback_when_dashscope_down_openrouter_responds(self):
        from dialogue.llm_client import LlmClient
        import httpx

        openrouter_response = MagicMock()
        openrouter_response.status_code = 200
        openrouter_response.json.return_value = {
            "text": "¡Hola! Soy el fallback de OpenRouter.",
            "functionCalls": [],
            "provider": "qwen-flash-openrouter"
        }

        call_count = 0
        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise httpx.ConnectError("Connection refused by DashScope")
            return _mock_httpx_client(openrouter_response)

        with patch("dialogue.llm_client.httpx.AsyncClient", side_effect=side_effect):
            client = LlmClient(base_url="http://localhost:3003/api/llm", max_retries=1)
            result = await client.send_message("Hola", provider="openrouter")

            assert result["text"] != ""
            assert result["provider"] == "qwen-flash-openrouter"
            assert call_count == 2


class TestQwenFunctionCallPersistence:
    @pytest.mark.asyncio
    async def test_function_call_result_persists_in_memory(self):
        from memory.function_handlers import FunctionCallHandler

        handler = FunctionCallHandler(db_session=None, chroma_client=None)
        result = await handler.registrar_pedido({
            "mesa": "M3",
            "platos": [
                {"nombre": "Lomo Saltado", "cantidad": 1, "precio": 18.0}
            ],
            "total": 18.0
        })

        assert result["success"] is True
        assert "pedido_id" in result
        assert handler._last_pedido_id is not None
        assert handler._last_pedido_id in handler._pedidos

        pedido = handler._pedidos[handler._last_pedido_id]
        assert pedido["mesa"] == "M3"
        assert pedido["estado"] == "provisional"

"""
Tests for LlmClient — HTTP bridge to Node.js LLM orchestrator.

TDD RED phase: all tests written to fail initially.
"""

import pytest
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock
import httpx


@pytest.fixture
def client():
    """Create a fresh LlmClient for each test."""
    from dialogue.llm_client import LlmClient
    return LlmClient(base_url="http://localhost:3005/api/llm")


@pytest.fixture
def mock_session():
    """Mock httpx.AsyncClient session with successful response."""
    mock = AsyncMock()
    mock.__aenter__ = AsyncMock(return_value=mock)
    mock.__aexit__ = AsyncMock(return_value=None)
    mock.post = AsyncMock()
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json = MagicMock(return_value={
        "text": "Hola, ¿qué deseas pedir?",
        "functionCalls": [],
        "provider": "qwen-flash",
    })
    mock.post.return_value = mock_response
    return mock


# ---------------------------------------------------------------------------
# Test 1: send_message sends correct POST request with text and history
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_send_message_sends_correct_post(client, mock_session):
    """send_message debe enviar un POST a /chat con el payload correcto."""
    with patch("httpx.AsyncClient", return_value=mock_session):
        await client.send_message(
            text="Quiero un café",
            history=[{"role": "user", "content": "Hola"}],
            provider="qwen-flash",
        )

    call_args = mock_session.post.call_args
    url = call_args[0][0]
    payload = call_args[1]["json"]

    assert "/chat" in url
    assert payload["message"] == "Quiero un café"
    assert payload["history"] == [{"role": "user", "content": "Hola"}]
    assert payload["provider"] == "qwen-flash"


# ---------------------------------------------------------------------------
# Test 2: send_message returns structured dict
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_send_message_returns_structured_dict(client, mock_session):
    """send_message retorna {text, functionCalls, provider}."""
    mock_session.post.return_value.json = MagicMock(return_value={
        "text": "Tu pedido está listo",
        "functionCalls": [{"name": "registrar_pedido"}],
        "provider": "qwen-flash",
    })

    with patch("httpx.AsyncClient", return_value=mock_session):
        result = await client.send_message(text="Un espresso")

    assert result == {
        "text": "Tu pedido está listo",
        "functionCalls": [{"name": "registrar_pedido"}],
        "provider": "qwen-flash",
    }


# ---------------------------------------------------------------------------
# Test 3: send_dialogue sends state + input via POST
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_send_dialogue_sends_state_and_input(client, mock_session):
    """send_dialogue envía state + input al endpoint /dialogue."""
    mock_session.post.return_value.json = MagicMock(return_value={
        "response": "¿Qué desea pedir?",
        "newState": "taking_order",
        "emotion": "friendly",
        "functionCalls": [],
    })

    with patch("httpx.AsyncClient", return_value=mock_session):
        result = await client.send_dialogue(
            state="greeting",
            input_text="Quiero pedir algo",
            session_id="abc-123",
        )

    call_args = mock_session.post.call_args
    url = call_args[0][0]
    payload = call_args[1]["json"]

    assert "/dialogue" in url
    assert payload["state"] == "greeting"
    assert payload["input"] == "Quiero pedir algo"
    assert payload["sessionId"] == "abc-123"

    assert result["response"] == "¿Qué desea pedir?"
    assert result["newState"] == "taking_order"
    assert result["emotion"] == "friendly"


# ---------------------------------------------------------------------------
# Test 4: handle_function_call sends function call result via POST
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_handle_function_call_sends_post(client, mock_session):
    """handle_function_call envía el resultado de una function call al bridge."""
    mock_session.post.return_value.json = MagicMock(return_value={
        "success": True,
        "result": {"pedido_id": 42},
    })

    call_data = {
        "name": "registrar_pedido",
        "args": {"item": "café con leche", "cantidad": 1},
        "sessionId": "ses-456",
    }

    with patch("httpx.AsyncClient", return_value=mock_session):
        result = await client.handle_function_call(call_data)

    call_args = mock_session.post.call_args
    url = call_args[0][0]
    payload = call_args[1]["json"]

    assert "/function-call" in url
    assert payload["name"] == "registrar_pedido"
    assert payload["args"] == {"item": "café con leche", "cantidad": 1}
    assert payload["sessionId"] == "ses-456"

    assert result == {
        "success": True,
        "result": {"pedido_id": 42},
        "name": "registrar_pedido",
    }


# ---------------------------------------------------------------------------
# Test 5: connection refused → raises ConnectionError with helpful message
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_connection_refused_raises_connection_error(client):
    """Conexión rechazada lanza ConnectionError con mensaje útil en español."""
    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError(
            "[Errno 111] Connection refused"
        ))
        mock_client_class.return_value = mock_client

        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            with pytest.raises(ConnectionError) as exc_info:
                await client.send_message(text="hola")

    error_msg = str(exc_info.value)
    assert "conectar" in error_msg.lower()
    assert "3003" in error_msg


# ---------------------------------------------------------------------------
# Test 6: timeout → raises TimeoutError after configured timeout
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_timeout_raises_timeout_error(client):
    """Timeout lanza TimeoutError con mensaje descriptivo."""
    client.timeout = 2  # short timeout for test

    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.post = AsyncMock(side_effect=asyncio.TimeoutError())
        mock_client_class.return_value = mock_client

        with patch("asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(TimeoutError) as exc_info:
                await client.send_message(text="hola")

    assert "2" in str(exc_info.value) or "timeout" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# Test 7: base_url and timeout are configurable
# ---------------------------------------------------------------------------
def test_configurable_base_url_and_timeout():
    """El cliente acepta base_url, timeout y max_retries configurables."""
    from dialogue.llm_client import LlmClient

    c = LlmClient(base_url="http://192.168.1.50:8080/api/llm", timeout=10, max_retries=3)
    assert c.base_url == "http://192.168.1.50:8080/api/llm"
    assert c.timeout == 10
    assert c.max_retries == 3


# ---------------------------------------------------------------------------
# Test 8: HTTP error (non-200) raises with status code
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_http_error_raises_exception(client):
    """Respuesta HTTP no 200 lanza Exception con el código de estado."""
    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = AsyncMock(return_value="Internal Server Error")
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_class.return_value = mock_client

        with patch("asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(Exception) as exc_info:
                await client.send_message(text="hola")

    assert "500" in str(exc_info.value)

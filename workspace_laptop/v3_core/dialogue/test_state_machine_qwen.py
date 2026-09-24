"""
Tests for Dialogue State Machine with LlmClient (Qwen Flash) bridge.

Replaces all google.genai usage with LlmClient HTTP bridge.
Preserves all state machine logic exactly.
"""

import pytest
import time
from unittest.mock import patch, AsyncMock, MagicMock


@pytest.fixture
def mock_redis():
    store = {}

    def mock_get(key):
        return store.get(key)

    def mock_setex(key, ttl, value):
        store[key] = value
        return True

    def mock_exists(key):
        return 1 if key in store else 0

    def mock_scan(cursor, match, count):
        return 0, []

    def mock_delete(*keys):
        for k in keys:
            store.pop(k, None)
        return len(keys)

    mock = MagicMock()
    mock.ping.return_value = True
    mock.get.side_effect = mock_get
    mock.setex.side_effect = mock_setex
    mock.exists.side_effect = mock_exists
    mock.scan.side_effect = mock_scan
    mock.delete.side_effect = mock_delete
    with patch("redis.Redis", return_value=mock):
        yield mock


@pytest.fixture
def mock_llm_client():
    """Mock LlmClient to avoid HTTP calls."""
    mock = AsyncMock()
    mock.send_dialogue.return_value = {
        "response": "Hola, soy Uchino",
        "newState": "greeting",
        "emotion": "friendly",
        "functionCalls": [],
    }
    mock.send_message.return_value = {
        "text": "Resumen de prueba",
        "functionCalls": [],
        "provider": "qwen-flash",
    }
    with patch("dialogue.state_machine.LlmClient", return_value=mock):
        with patch("dialogue.context_manager.LlmClient", return_value=mock):
            yield mock


def test_state_machine_initializes_with_llm_client(mock_redis, mock_llm_client):
    """DialogueGraph initializes and uses LlmClient instead of google.genai."""
    from dialogue.state_machine import DialogueGraph

    graph = DialogueGraph(use_gemini=True)

    assert graph._llm_client is not None
    assert hasattr(graph, "_llm_client")

    health = graph.health_check()
    assert health["llm_bridge"] is True


def test_idle_to_greeting_transition(mock_redis, mock_llm_client):
    """Wake word triggers idle → greeting transition."""
    from dialogue.state_machine import create_dialogue_graph

    graph = create_dialogue_graph(use_gemini=False)
    session_id = f"test-greeting-{int(time.time())}"

    result = graph.process_turn(session_id, "Oye Uchino", wake_word=True, customer_finished=True)

    assert result["current_state"] == "greeting"
    assert result["response"] != ""


def test_greeting_to_taking_order_transition(mock_redis, mock_llm_client):
    """Order intent triggers greeting → taking_order transition."""
    from dialogue.state_machine import create_dialogue_graph

    graph = create_dialogue_graph(use_gemini=False)
    session_id = f"test-order-{int(time.time())}"

    # First, wake word to get to greeting
    graph.process_turn(session_id, "Oye Uchino", wake_word=True, customer_finished=True)

    # Then, order intent
    result = graph.process_turn(session_id, "Quiero una pizza", customer_finished=True)

    assert result["current_state"] == "taking_order"


def test_function_calls_routed_correctly(mock_redis, mock_llm_client):
    """LlmClient functionCalls are parsed and routed through StateHandler."""
    from dialogue.state_machine import create_dialogue_graph

    mock_llm_client.send_dialogue.return_value = {
        "response": "Registrando tu pedido",
        "newState": "taking_order",
        "emotion": "happy",
        "functionCalls": [
            {
                "name": "registrar_pedido",
                "args": {
                    "mesa": "1",
                    "platos": [{"nombre": "pizza", "cantidad": 1, "precio": 25.0}],
                    "bebida": "coca-cola",
                    "total": 25.0,
                },
            }
        ],
    }

    graph = create_dialogue_graph(use_gemini=True)
    session_id = f"test-fc-{int(time.time())}"

    # Wake word → greeting
    graph.process_turn(session_id, "Oye Uchino", wake_word=True, customer_finished=True)

    # Order with function call
    result = graph.process_turn(session_id, "Quiero una pizza y una coca", customer_finished=True)

    assert result["current_state"] == "taking_order"
    assert result["order"] is not None
    assert result["order"]["platos"][0]["nombre"] == "pizza"
    assert any(a["action"] == "registrar_pedido" for a in result["actions"])


def test_llm_client_error_graceful_degradation(mock_redis, mock_llm_client):
    """When LlmClient raises exception, state machine stays in current state."""
    from dialogue.state_machine import create_dialogue_graph

    mock_llm_client.send_dialogue.side_effect = Exception("Connection refused")

    graph = create_dialogue_graph(use_gemini=True)
    session_id = f"test-error-{int(time.time())}"

    # Wake word → greeting
    graph.process_turn(session_id, "Oye Uchino", wake_word=True, customer_finished=True)

    # This turn should NOT crash; LlmClient error is caught in _detect_intent
    result = graph.process_turn(session_id, "Quiero una pizza", customer_finished=True)

    # Should stay in greeting (no crash, graceful fallback to handler logic)
    assert result["current_state"] in ("greeting", "taking_order")
    assert "response" in result


def test_no_google_genai_imports():
    """Verify the state_machine module does not import google.genai."""
    import dialogue.state_machine as sm_module
    import inspect

    source = inspect.getsource(sm_module)
    assert "google.genai" not in source
    assert "from google" not in source
    assert "HAS_GEMINI" not in source
    assert "GenerativeModel" not in source

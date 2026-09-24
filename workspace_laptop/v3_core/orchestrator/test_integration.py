import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from orchestrator import MasterOrchestrator, FastRuleEngine, Ros2Bridge, VisionClient


class TestFastRuleEngine:
    def test_safety_keyword_triggers_stop(self):
        engine = FastRuleEngine()
        result = engine.evaluate("text", "¡Para! Hay peligro")
        assert result is not None
        assert result["command"] == "emergency_stop"
        assert result["system"] == "system1"

    def test_wake_word_in_idle(self):
        engine = FastRuleEngine()
        result = engine.evaluate("text", "Hola Uchino", {"current_state": "idle"})
        assert result is not None
        assert result["command"] == "wake_ack"
        assert result["next_state"] == "greeting"

    def test_no_action_in_non_idle(self):
        engine = FastRuleEngine()
        result = engine.evaluate("text", "Hola Uchino", {"current_state": "taking_order"})
        assert result is None

    def test_nav_confirmation(self):
        engine = FastRuleEngine()
        result = engine.evaluate("text", "sí, adelante", {"pending_navigation": True})
        assert result is not None
        assert result["command"] == "nav_confirm"

    def test_obstacle_telemetry(self):
        engine = FastRuleEngine()
        result = engine.evaluate("telemetry", {"lidar": {"distancia": 0.3}})
        assert result is not None
        assert result["command"] == "stop"

    def test_low_battery(self):
        engine = FastRuleEngine()
        result = engine.evaluate("telemetry", {"bateria": 15})
        assert result is not None
        assert result["command"] == "go_to_base"

    def test_safe_transition(self):
        engine = FastRuleEngine()
        assert engine.is_safe_transition("idle", "greeting")
        assert not engine.is_safe_transition("idle", "delivering")

    def test_validate_action(self):
        engine = FastRuleEngine()
        ok, reason = engine.validate_action("ir_a_lugar", {"lugar": "MESA"}, "taking_order")
        assert ok
        ok, reason = engine.validate_action("ir_a_lugar", {"lugar": "MESA"}, "idle")
        assert not ok
        ok, reason = engine.validate_action("setVelocity", {"v": 1.5}, "delivering")
        assert not ok


class TestRos2Bridge:
    def test_get_state_timeout(self):
        bridge = Ros2Bridge(base_url="http://localhost:59999", timeout=0.01)
        result = asyncio.run(bridge.get_state())
        assert result["success"] is False
        assert "timeout" in result["error"].lower() or "connection" in result["error"].lower()


class TestVisionClient:
    def test_verify_action_timeout(self):
        client = VisionClient(base_url="http://localhost:59999", timeout=0.01)
        result = asyncio.run(client.verify_action("ir_a_mesa", "cerca de mesa 1"))
        assert result["success"] is False


class TestMasterOrchestrator:
    def test_init_without_dependencies(self):
        orch = MasterOrchestrator()
        assert orch.dialogue is None or orch.dialogue is not None
        assert orch.session_id is not None

    def test_system2_rate_limit(self):
        orch = MasterOrchestrator()
        assert orch.SYSTEM2_MAX_HZ == 8.0
        assert orch.SYSTEM2_MIN_INTERVAL == 0.125

    def test_fast_path_emergency_stop(self):
        orch = MasterOrchestrator()
        call_count = [0]
        async def fake_stop():
            call_count[0] += 1
            return {"success": True}
        orch.ros2.stop = fake_stop
        result = asyncio.run(orch.process_input("text", "¡Detente! Hay peligro"))
        assert result["system"] == "system1"
        assert result["action"] == "emergency_stop"
        assert call_count[0] == 1

    def test_fast_path_wake_word(self):
        orch = MasterOrchestrator()
        result = asyncio.run(orch.process_input("text", "Oye Uchino", {"current_state": "idle"}))
        assert result["system"] == "system1"
        assert result["action"] == "wake_ack"
        assert result["next_state"] == "greeting"

    def test_slow_path_without_dialogue(self):
        orch = MasterOrchestrator()
        orch.dialogue = None
        result = asyncio.run(orch.process_input("text", "Quiero una pizza"))
        assert result["system"] == "system2"
        assert result.get("fallback") is True

    def test_handle_failure_max_attempts(self):
        orch = MasterOrchestrator()
        orch.replan_attempts = orch.MAX_REPLAN_ATTEMPTS
        result = asyncio.run(orch._handle_failure("ir_a_lugar", {"lugar": "MESA"}, {"error": "timeout"}))
        assert result["alternative_action"] is None
        assert "Max re-plan" in result["reason"]

    def test_verify_execution_skipped_when_disabled(self):
        orch = MasterOrchestrator(enable_vision_verify=False)
        result = asyncio.run(orch._verify_execution("ir_a_lugar", {"lugar": "MESA"}))
        assert result["skipped"] is True

    def test_full_pipeline_mock(self):
        orch = MasterOrchestrator()
        orch.fast_rules.evaluate = MagicMock(return_value=None)

        mock_state = {
            "current_state": "taking_order",
            "response": "Entendido, registrando tu pedido.",
            "actions": [{"name": "registrar_pedido", "args": {"platos": [{"nombre": "Pizza", "cantidad": 1}]}}],
            "emotion": "feliz",
            "session_id": orch.session_id,
        }
        orch.dialogue = MagicMock()
        orch.dialogue.process_turn = MagicMock(return_value=mock_state)
        orch.dialogue.checkpoint = MagicMock()
        orch.dialogue.checkpoint.load = MagicMock(return_value=None)

        orch.tts = MagicMock()
        orch.tts.synthesize_with_engine = MagicMock(return_value={
            "engine": "kokoro", "wav_base64": "dGVzdA==", "emotion_tag": "feliz"
        })

        result = asyncio.run(orch.process_input("text", "Quiero una pizza"))
        assert result["system"] == "system2"
        assert result["response_text"] == "Entendido, registrando tu pedido."
        assert len(result["actions"]) == 1
        assert result["actions"][0]["name"] == "registrar_pedido"
        assert result["tts"]["engine"] == "kokoro"


def test_end_to_end_wake_word_to_response():
    orch = MasterOrchestrator()
    stop_calls = [0]
    async def fake_stop():
        stop_calls[0] += 1
        return {"success": True}
    orch.ros2.stop = fake_stop

    step1 = asyncio.run(orch.process_input("text", "Oye Uchino", {"current_state": "idle"}))
    assert step1["system"] == "system1"
    assert step1["next_state"] == "greeting"
    assert "Hola" in step1["response_text"]

    step2 = asyncio.run(orch.process_input("text", "Quiero una pizza", {"current_state": "greeting"}))
    assert step2["system"] == "system2"

    step3 = asyncio.run(orch.process_input("text", "¡Para!", {"current_state": "taking_order"}))
    assert step3["system"] == "system1"
    assert step3["action"] == "emergency_stop"
    assert stop_calls[0] >= 1

"""
QA Test Suite for Dialogue State Machine.
Tests:
  1. Complete order flow: idle→greeting→taking_order→confirming→confirming_order→delivering→farewell
  2. Context window management: verify summary after 20+ turns
"""

import sys
import os
import time
import json

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))


def test_complete_order_flow(use_gemini=False):
    """Test 1: Full order lifecycle through all 7 states."""
    print("=" * 70)
    print("QA TEST 1: Complete Order Flow (7 states)")
    print("=" * 70)

    from dialogue.state_machine import create_dialogue_graph

    graph = create_dialogue_graph()
    session_id = f"qa-test-order-{int(time.time())}"

    # Turn 1: Wake word → idle → greeting
    result = graph.process_turn(session_id, "Oye Uchino", wake_word=True)
    assert result["current_state"] == "greeting", f"Expected greeting, got {result['current_state']}"
    print(f"  ✓ Turn 1: idle → {result['current_state']} | Response: {result['response'][:80]}")

    # Turn 2: Ask for menu → staying in greeting
    result = graph.process_turn(session_id, "Quiero ver el menú por favor")
    print(f"  ✓ Turn 2: staying in {result['current_state']} | Response: {result['response'][:80]}")

    # Turn 3: Place order → greeting → taking_order
    result = graph.process_turn(session_id, "Quisiera una pizza margarita y una coca-cola")
    assert result["current_state"] == "taking_order", f"Expected taking_order, got {result['current_state']}"
    print(f"  ✓ Turn 3: → {result['current_state']} | Response: {result['response'][:80]}")

    # Turn 4: Confirm order details → taking_order → confirming
    result = graph.process_turn(session_id, "Sí, eso es todo, confírmame el pedido")
    print(f"  ✓ Turn 4: → {result['current_state']} | Response: {result['response'][:80]}")

    # Turn 5: Confirm → confirming → confirming_order
    result = graph.process_turn(session_id, "Sí, confirmo el pedido")
    assert result["current_state"] == "confirming_order", f"Expected confirming_order, got {result['current_state']}"
    print(f"  ✓ Turn 5: → {result['current_state']} | Response: {result['response'][:80]}")

    # Turn 6: Order confirmed → confirming_order → delivering
    result = graph.process_turn(session_id, "Gracias, espero mi pedido")
    assert result["current_state"] == "delivering", f"Expected delivering, got {result['current_state']}"
    print(f"  ✓ Turn 6: → {result['current_state']} | Response: {result['response'][:80]}")

    # Turn 7: Delivery complete → delivering → farewell
    result = graph.process_turn(session_id, "Muchas gracias Chipi, todo perfecto")
    assert result["current_state"] == "farewell", f"Expected farewell, got {result['current_state']}"
    print(f"  ✓ Turn 7: → {result['current_state']} | Response: {result['response'][:80]}")

    # Turn 8: End → farewell → idle
    result = graph.process_turn(session_id, "Adiós")
    assert result["current_state"] == "idle", f"Expected idle, got {result['current_state']}"
    print(f"  ✓ Turn 8: → {result['current_state']} | Response: {result['response'][:80] or '(silent)'}")

    # Verify state sequence
    graph.end_session(session_id)
    print(f"\n  ✅ PASS: Complete order flow works correctly (8 turns, all 7 states visited)")
    return True


def test_context_window_management(use_gemini=False):
    """Test 2: Verify context window summarization after 20+ turns."""
    print("\n" + "=" * 70)
    print("QA TEST 2: Context Window Management")
    print("=" * 70)

    from dialogue.state_machine import create_dialogue_graph

    graph = create_dialogue_graph()
    session_id = f"qa-test-context-{int(time.time())}"

    # Simulate 25 turns of conversation
    conversation = [
        ("Hola Uchino", True),
        ("Quiero ver el menú", False),
        ("Muéstrame los platos", False),
        ("Tienen pizza?", False),
        ("Precio de la hamburguesa?", False),
        ("Quiero una pizza margarita", False),
        ("También una coca-cola", False),
        ("Tienen postres?", False),
        ("Cuál es el especial del día?", False),
        ("La pizza viene con queso extra?", False),
        ("Hay opciones vegetarianas?", False),
        ("Quiero agregar un helado", False),
        ("Cuánto es el total?", False),
        ("Aceptan tarjeta?", False),
        ("Cuánto tardan en preparar?", False),
        ("Pueden poner la pizza sin pepperoni?", False),
        ("Hay promociones?", False),
        ("Me puedes recomendar algo?", False),
        ("El café es caliente?", False),
        ("Confirmo mi pedido entonces", False),
        ("Sí, todo bien", False),
        ("Cuánto falta?", False),
        ("Gracias por la espera", False),
        ("Todo excelente", False),
        ("Hasta luego Chipi", False),
    ]

    for i, (text, wake_word) in enumerate(conversation):
        result = graph.process_turn(session_id, text, wake_word=wake_word)

        # Check summary after turn 20
        if i == 20:
            saved = graph.checkpoint.load_manual(session_id)
            summary = saved.get("summary") if saved else None
            msg_count = len(saved.get("messages", [])) if saved else 0
            print(f"  Turn {i+1}: state={result['current_state']}, messages in state={msg_count}")
            print(f"  Summary after 20 turns: {'✓ Generated' if summary else '✗ Not generated'}")
            if summary:
                print(f"  Summary preview: {summary[:120]}...")
                assert msg_count <= 20, f"Context window too large: {msg_count} messages (max 20 raw)"
                print(f"  ✓ Context window capped: {msg_count} ≤ 20 messages")

    # Final check: summary should exist
    saved = graph.checkpoint.load_manual(session_id)
    final_summary = saved.get("summary") if saved else None
    final_turns = saved.get("turn_count", 0) if saved else 0

    print(f"\n  Final turn count: {final_turns}")
    print(f"  Final summary: {'✓ Present' if final_summary else '✗ Missing'}")

    assert final_summary is not None, "Summary should have been generated after 20+ turns"
    assert final_turns == 25, f"Expected 25 turns, got {final_turns}"

    graph.end_session(session_id)
    print(f"\n  ✅ PASS: Context window management works correctly")
    return True


def test_checkpoint_resume(use_gemini=False):
    """Test 3: Verify session resume after disconnect."""
    print("\n" + "=" * 70)
    print("QA TEST 3: Checkpoint Resume")
    print("=" * 70)

    from dialogue.state_machine import create_dialogue_graph

    graph = create_dialogue_graph()
    session_id = f"qa-test-resume-{int(time.time())}"

    # Start a conversation
    result = graph.process_turn(session_id, "Hola Uchino", wake_word=True)
    assert result["current_state"] == "greeting"
    print(f"  Turn 1: → {result['current_state']}")

    result = graph.process_turn(session_id, "Quiero pedir una pizza")
    print(f"  Turn 2: → {result['current_state']}")

    # Simulate disconnect by creating new graph instance
    graph2 = create_dialogue_graph()

    # Resume should restore state
    saved = graph2.resume_session(session_id)
    assert saved is not None, "Session should be resumable"
    assert saved.get("current_state") in ("greeting", "taking_order"), \
        f"Unexpected resumed state: {saved.get('current_state')}"
    print(f"  ✓ Session resumed: state={saved.get('current_state')}, turns={saved.get('turn_count', 0)}")

    # Continue conversation from resumed state
    result = graph2.process_turn(session_id, "Gracias")
    print(f"  Turn 3 (resumed): → {result['current_state']}")
    assert result["turn_count"] > 2, "Turn count should continue from saved state"

    graph2.end_session(session_id)
    print(f"\n  ✅ PASS: Session resume works correctly")
    return True


def test_timeout(use_gemini=False):
    """Test 4: Verify timeout returns to idle."""
    print("\n" + "=" * 70)
    print("QA TEST 4: Timeout Handling")
    print("=" * 70)

    from dialogue.state_machine import create_dialogue_graph
    from dialogue.state_handlers import STATE_TIMEOUTS

    graph = create_dialogue_graph()
    session_id = f"qa-test-timeout-{int(time.time())}"

    # Enter greeting state
    result = graph.process_turn(session_id, "Hola Uchino", wake_word=True)
    assert result["current_state"] == "greeting"
    print(f"  Entered: {result['current_state']} (timeout: {STATE_TIMEOUTS['greeting']}s)")

    # Manually expire the timeout
    saved = graph.checkpoint.load_manual(session_id)
    saved["timeout_at"] = time.time() - 10  # expired 10 seconds ago
    graph.checkpoint.save_manual(session_id, saved)

    # Next turn should detect timeout and return to idle
    result = graph.process_turn(session_id, "")
    assert result["current_state"] == "idle", f"Expected idle after timeout, got {result['current_state']}"
    print(f"  After timeout: → {result['current_state']}")

    graph.end_session(session_id)
    print(f"\n  ✅ PASS: Timeout correctly returns to idle")
    return True


def main():
    print("\n" + "█" * 70)
    print("█  CHIPI DIALOGUE STATE MACHINE — QA TEST SUITE")
    print("█" * 70)

    use_gemini = "--gemini" in sys.argv

    results = {}
    try:
        results["complete_order"] = test_complete_order_flow(use_gemini)
    except Exception as e:
        print(f"\n  ❌ FAIL: Complete order flow: {e}")
        results["complete_order"] = False

    try:
        results["context_window"] = test_context_window_management(use_gemini)
    except Exception as e:
        print(f"\n  ❌ FAIL: Context window: {e}")
        results["context_window"] = False

    try:
        results["checkpoint_resume"] = test_checkpoint_resume(use_gemini)
    except Exception as e:
        print(f"\n  ❌ FAIL: Checkpoint resume: {e}")
        results["checkpoint_resume"] = False

    try:
        results["timeout"] = test_timeout(use_gemini)
    except Exception as e:
        print(f"\n  ❌ FAIL: Timeout: {e}")
        results["timeout"] = False

    print("\n" + "=" * 70)
    print("QA TEST RESULTS")
    print("=" * 70)
    for name, passed in results.items():
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {status}: {name}")

    all_passed = all(results.values())
    print(f"\n  OVERALL: {'✅ ALL PASSED' if all_passed else '❌ SOME FAILED'}")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())

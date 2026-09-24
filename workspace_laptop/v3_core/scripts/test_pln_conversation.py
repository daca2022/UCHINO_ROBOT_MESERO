#!/usr/bin/env python3
"""
PLN standalone test: simulate wake word + multiple transcriptions.
Validates state machine, fast rules, LLM responses, memory retrieval.
"""
import asyncio
import sys
import time

sys.path.insert(0, '/home/david/chipi_workspace_pln/v3_core')
from pln.main import ChipiPLN
from pln.types import ChipiState


async def main():
    print("=" * 70)
    print("PLN STANDALONE TEST — Simulating wake word + conversation")
    print("=" * 70)
    print()

    pln = ChipiPLN()
    print(f"[INIT] State: {pln.state.name}")
    print(f"[INIT] Session: {pln.context.session_id}")
    print()

    # ── Test 1: Wake word → should send greeting, transition to LISTENING
    print("-" * 70)
    print("TEST 1: Wake word detection")
    print("-" * 70)
    await pln._on_wake_word()
    await asyncio.sleep(0.5)
    print(f"[AFTER WAKE] State: {pln.state.name}")
    print()

    # ── Test 2: Order request → should call LLM, extract order
    print("-" * 70)
    print("TEST 2: Order request ('quiero una pizza margarita y una coca cola')")
    print("-" * 70)
    print("⏳ Calling LLM (may take 5-15s)...")
    start = time.monotonic()
    await pln._on_transcription("quiero una pizza margarita y una coca cola")
    elapsed = time.monotonic() - start
    print(f"[LLM] Response time: {elapsed:.1f}s")
    print(f"[AFTER ORDER] State: {pln.state.name}")
    if pln.context.current_order:
        print(f"[ORDER] Items: {[i.nombre for i in pln.context.current_order]}")
        print(f"[ORDER] Total: S/.{sum(i.precio * i.cantidad for i in pln.context.current_order):.2f}")
    print()

    # ── Test 3: Another turn
    print("-" * 70)
    print("TEST 3: Add more items ('y de postre un tiramisú')")
    print("-" * 70)
    await pln._on_transcription("y de postre un tiramisú")
    print(f"[AFTER ADD] State: {pln.state.name}")
    if pln.context.current_order:
        print(f"[ORDER] Items: {[i.nombre for i in pln.context.current_order]}")
    print()

    # ── Test 4: Fast rule (greeting)
    print("-" * 70)
    print("TEST 4: Fast rule (greeting - 'hola')")
    print("-" * 70)
    fr = pln.dialogue.check_fast_rule("hola, buenos días")
    if fr:
        print(f"[FAST RULE] {fr.text}")
        print(f"[FAST RULE] is_fast_rule={fr.is_fast_rule}, state={fr.state.name}")
    else:
        print("[FAST RULE] No match (unexpected)")
    print()

    # ── Test 5: Fast rule (thanks)
    print("-" * 70)
    print("TEST 5: Fast rule (thanks - 'gracias')")
    print("-" * 70)
    fr = pln.dialogue.check_fast_rule("muchas gracias")
    if fr:
        print(f"[FAST RULE] {fr.text}")
    else:
        print("[FAST RULE] No match")
    print()

    # ── Test 6: Memory retrieval
    print("-" * 70)
    print("TEST 6: Memory retrieval (with a test clientId)")
    print("-" * 70)
    test_uuid = "cca64c42-1ce1-49df-b2fe-482ab2e3e5f6"
    pln.context.client_id = test_uuid
    mem = await pln.dialogue.get_client_memory(test_uuid)
    if mem:
        print(f"[MEMORY] Cliente: {mem.get('cliente', {}).get('nombre') or 'N/A'}")
        print(f"[MEMORY] Total pedidos: {mem.get('total_pedidos', 0)}")
        if mem.get('ultimos_pedidos'):
            print(f"[MEMORY] Last order: mesa {mem['ultimos_pedidos'][0]['mesa']} - {mem['ultimos_pedidos'][0]['platos']}")
    else:
        print("[MEMORY] No memory found")
    print()

    # ── Test 7: Confirm order
    print("-" * 70)
    print("TEST 7: Confirm order ('sí, confírmalo')")
    print("-" * 70)
    await pln._on_transcription("sí, confírmalo por favor")
    print(f"[AFTER CONFIRM] State: {pln.state.name}")
    print()

    print("=" * 70)
    print("ALL TESTS COMPLETED")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())

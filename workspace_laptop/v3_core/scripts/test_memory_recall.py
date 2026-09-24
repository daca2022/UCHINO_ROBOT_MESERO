#!/usr/bin/env python3
"""
Memory recall test: validate that Chipi remembers a client across conversations.
"""
import asyncio
import sys
import time

sys.path.insert(0, '/home/david/chipi_workspace_pln/v3_core')
from pln.main import ChipiPLN
from pln.types import ChipiState


async def main():
    print("=" * 70)
    print("MEMORY RECALL TEST — Does Chipi remember past orders?")
    print("=" * 70)

    client_id = open('/tmp/test_client_id.txt').read().strip()
    print(f"\nTest client_id: {client_id}")
    print(f"History: 4 orders (Café+Tiramisú, Hamburguesa, 2x Pizza+Coca-Cola)")
    print()

    # ── Conversation 1: First contact with returning client
    print("=" * 70)
    print("CONVERSATION 1: Returning client (should reference past orders)")
    print("=" * 70)

    pln = ChipiPLN()
    pln.context.client_id = client_id
    pln.context.mesa = "5"

    print("\n[TURN 1] Wake word + greeting")
    await pln._on_wake_word()
    await asyncio.sleep(0.5)
    print(f"  State: {pln.state.name}")
    print()

    print("[TURN 2] Client asks: '¿qué me recomiendas para comer?'")
    print("  ⏳ Calling LLM (memory should be injected)...")
    start = time.monotonic()
    await pln._on_transcription("qué me recomiendas para comer")
    elapsed = time.monotonic() - start
    print(f"  LLM: {elapsed:.1f}s")
    print(f"  State: {pln.state.name}")
    print()

    # ── Conversation 2: New instance, same client (simulates next visit)
    print("=" * 70)
    print("CONVERSATION 2: Brand new PLN instance, same client_id")
    print("(simulates next day — fresh process, same client history)")
    print("=" * 70)

    pln2 = ChipiPLN()
    pln2.context.client_id = client_id
    pln2.context.mesa = "5"

    print("\n[TURN 1] Wake word + greeting")
    await pln2._on_wake_word()
    await asyncio.sleep(0.5)
    print(f"  State: {pln2.state.name}")
    print()

    print("[TURN 2] Client says: 'quiero lo mismo de la última vez'")
    print("  ⏳ Calling LLM (memory should be injected)...")
    start = time.monotonic()
    await pln2._on_transcription("quiero lo mismo de la última vez")
    elapsed = time.monotonic() - start
    print(f"  LLM: {elapsed:.1f}s")
    print(f"  State: {pln2.state.name}")
    print()

    # ── Conversation 3: New client (control test — should NOT have history)
    print("=" * 70)
    print("CONVERSATION 3: CONTROL — new client, no history")
    print("=" * 70)

    new_client = "11111111-1111-1111-1111-111111111111"
    pln3 = ChipiPLN()
    pln3.context.client_id = new_client

    print("\n[TURN 1] Wake word")
    await pln3._on_wake_word()
    await asyncio.sleep(0.5)

    print("[TURN 2] New client asks: '¿qué me recomiendas para comer?'")
    print("  ⏳ Calling LLM (memory should be EMPTY)...")
    start = time.monotonic()
    await pln3._on_transcription("qué me recomiendas para comer")
    elapsed = time.monotonic() - start
    print(f"  LLM: {elapsed:.1f}s")
    print(f"  State: {pln3.state.name}")
    print()

    print("=" * 70)
    print("ALL CONVERSATIONS COMPLETED")
    print("Compare LLM responses above to verify memory is being used.")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())

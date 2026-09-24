#!/usr/bin/env python3
"""Simple test to verify pipeline connection."""
import asyncio
import json
import sys

try:
    import websockets
except ImportError:
    print("[error] websockets not installed")
    sys.exit(1)


async def test_connection():
    url = "ws://localhost:8001/asr"
    print(f"[*] Connecting to {url}")
    
    try:
        async with websockets.connect(url) as ws:
            print("[✓] Connected!")
            
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"[✓] Received: {message[:200]}")
            except asyncio.TimeoutError:
                print("[!] No message in 5s")
            
            print("[*] Sending test bytes...")
            test_audio = b'\x00' * 32000  # 1 second of silence
            await ws.send(test_audio)
            print("[✓] Sent 32000 bytes")
            
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"[✓] Received after send: {message[:200]}")
            except asyncio.TimeoutError:
                print("[!] No response after 5s")
                
    except Exception as e:
        print(f"[error] {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_connection())

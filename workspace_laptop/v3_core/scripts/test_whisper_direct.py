#!/usr/bin/env python3
"""
Test WhisperLiveKit DIRECTLY on port 8002.
Sends mic audio and shows transcription results.
"""
import asyncio
import json
import struct
import sys
import numpy as np

try:
    import pyaudio
except ImportError:
    print("[error] pyaudio not installed. Run: pip install pyaudio")
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("[error] websockets not installed. Run: pip install websockets")
    sys.exit(1)


WHISPER_URL = "ws://localhost:8001/asr"
SAMPLE_RATE = 16000
CHUNK_DURATION_MS = 1000  # Send 1-second chunks
CHUNK_SIZE = int(SAMPLE_RATE * CHUNK_DURATION_MS / 1000)  # 16000 samples


async def test_whisper():
    print(f"[*] Connecting to Pipeline at {WHISPER_URL}")
    
    try:
        print("[*] Attempting WebSocket connection...")
        async with websockets.connect(WHISPER_URL) as ws:
            print("[✓] Connected to Pipeline!")
            print("[*] Waiting for config/status message...")
            
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"[✓] Received message: {message[:200]}")
            except asyncio.TimeoutError:
                print("[!] No message received within 5 seconds")
                return
            
            pa = pyaudio.PyAudio()
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=SAMPLE_RATE,
                input=True,
                frames_per_buffer=CHUNK_SIZE
            )
            
            print("[*] Listening... (speak into mic, press Ctrl+C to stop)")
            print("-" * 60)
            
            send_task = asyncio.create_task(send_audio(ws, stream))
            recv_task = asyncio.create_task(receive_results(ws))
            
            try:
                await asyncio.gather(send_task, recv_task)
            except KeyboardInterrupt:
                print("\n[*] Stopping...")
                send_task.cancel()
                recv_task.cancel()
                
    except Exception as e:
        print(f"[error] {e}")
        import traceback
        traceback.print_exc()


async def send_audio(ws, stream):
    try:
        while True:
            data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
            await ws.send(data)
            await asyncio.sleep(CHUNK_DURATION_MS / 1000)
    except asyncio.CancelledError:
        pass


async def receive_results(ws):
    try:
        while True:
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=2.0)
                if isinstance(message, bytes):
                    continue
                try:
                    data = json.loads(message)
                    if "text" in data and data["text"].strip():
                        print(f"[transcription] {data['text']}")
                    elif "status" in data:
                        print(f"[status] {data['status']}")
                    elif "lines" in data:
                        for line in data.get("lines", []):
                            if line.get("text", "").strip():
                                print(f"[line] {line['text']}")
                    else:
                        print(f"[data] {json.dumps(data, indent=2)[:200]}")
                except json.JSONDecodeError:
                    print(f"[raw] {message[:100]}")
            except asyncio.TimeoutError:
                continue
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(test_whisper())
    except KeyboardInterrupt:
        print("\n[*] Interrupted")

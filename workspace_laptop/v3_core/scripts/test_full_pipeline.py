#!/usr/bin/env python3
"""End-to-end test: mic → pipeline → WhisperLiveKit → transcription → PLN → LLM → TTS → speakers."""
import asyncio
import json
import sys
import numpy as np

try:
    import pyaudio
except ImportError:
    print("[error] pyaudio not installed")
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("[error] websockets not installed")
    sys.exit(1)


PIPELINE_URL = "ws://localhost:8001/asr"
BACKEND_URL = "http://localhost:3005"
SAMPLE_RATE = 16000
CHUNK_DURATION_MS = 1000
CHUNK_SIZE = int(SAMPLE_RATE * CHUNK_DURATION_MS / 1000)


async def test_full_pipeline():
    print("=" * 60)
    print("FULL PIPELINE TEST: mic → pipeline → STT → LLM → TTS")
    print("=" * 60)
    
    try:
        async with websockets.connect(PIPELINE_URL) as ws:
            print("[✓] Connected to pipeline")
            
            config_raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            config_msg = json.loads(config_raw)
            print(f"[✓] Received config: {config_msg.get('type', 'unknown')}")
            
            pa = pyaudio.PyAudio()
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=SAMPLE_RATE,
                input=True,
                frames_per_buffer=CHUNK_SIZE
            )
            
            print("[*] Speak into mic now! (10 seconds max)")
            print("-" * 60)
            
            start_time = asyncio.get_event_loop().time()
            audio_chunks = []
            
            while True:
                elapsed = asyncio.get_event_loop().time() - start_time
                if elapsed > 10:
                    print("\n[*] Time limit reached")
                    break
                
                data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                audio_chunks.append(data)
                await ws.send(data)
                
                try:
                    message = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    if isinstance(message, str):
                        payload = json.loads(message)
                        status = payload.get("status", "")
                        lines = payload.get("lines", [])
                        buffer_text = payload.get("buffer_transcription", "")
                        
                        if status:
                            print(f"[status] {status}")
                        if lines:
                            for line in lines:
                                if line.get("text", "").strip():
                                    print(f"[transcription] {line['text']}")
                        if buffer_text:
                            print(f"[buffer] {buffer_text}")
                except asyncio.TimeoutError:
                    pass
            
            stream.stop_stream()
            stream.close()
            pa.terminate()
            
            print("-" * 60)
            print("[*] Audio capture complete")
            print(f"[*] Total chunks sent: {len(audio_chunks)}")
            
    except Exception as e:
        print(f"[error] {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(test_full_pipeline())

#!/usr/bin/env python3
"""Wake word test with paplay background playback + mic capture."""
import asyncio
import json
import subprocess
import sys
import time

try:
    import websockets
except ImportError:
    print("[error] websockets not installed")
    sys.exit(1)

try:
    import pyaudio
except ImportError:
    print("[error] pyaudio not installed")
    sys.exit(1)


PIPELINE_URL = "ws://localhost:8001/asr"
AUDIO_FILE = "/tmp/hey_jarvis_en.wav"
SAMPLE_RATE = 16000
CHUNK_SIZE = 1280


async def test_wake_word():
    print("=" * 60)
    print("WAKE WORD TEST: paplay background + mic capture")
    print("=" * 60)
    
    pa = pyaudio.PyAudio()
    mic = pa.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=SAMPLE_RATE,
        input=True,
        frames_per_buffer=CHUNK_SIZE,
    )
    
    print(f"[*] Connecting to {PIPELINE_URL}...")
    async with websockets.connect(PIPELINE_URL) as ws:
        config = await asyncio.wait_for(ws.recv(), timeout=5.0)
        print(f"[✓] Connected: {json.loads(config).get('type')}")
        print()
        print("-" * 60)
        print("Playing 'Hey Jarvis' in loop. Mic listening for 20s...")
        print("-" * 60)
        
        play_proc = subprocess.Popen(
            ["bash", "-c", f"while true; do paplay {AUDIO_FILE}; sleep 0.5; done"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        
        wake_detected = False
        start = time.monotonic()
        frame_count = 0
        
        try:
            while time.monotonic() - start < 20.0 and not wake_detected:
                data = mic.read(CHUNK_SIZE, exception_on_overflow=False)
                frame_count += 1
                
                if frame_count % 25 == 0:
                    elapsed = time.monotonic() - start
                    print(f"  [{elapsed:.1f}s] frame {frame_count}, listening...")
                
                await ws.send(data)
                
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.02)
                    if isinstance(msg, str):
                        payload = json.loads(msg)
                        if payload.get("status") == "wake_word":
                            print()
                            print(f"[✓✓✓] WAKE WORD DETECTED at frame {frame_count}!")
                            wake_detected = True
                            break
                        ww = payload.get("wake_word", {})
                        if ww.get("activated"):
                            print()
                            print(f"[✓✓✓] WAKE WORD ACTIVATED at frame {frame_count}!")
                            wake_detected = True
                            break
                except asyncio.TimeoutError:
                    pass
        finally:
            play_proc.terminate()
            play_proc.wait()
        
        elapsed = time.monotonic() - start
        print()
        if wake_detected:
            print(f"[✓] Detected after {elapsed:.1f}s")
        else:
            print(f"[✗] Not detected in {elapsed:.1f}s")
    
    mic.stop_stream()
    mic.close()
    pa.terminate()
    return wake_detected


if __name__ == "__main__":
    result = asyncio.run(test_wake_word())
    sys.exit(0 if result else 1)

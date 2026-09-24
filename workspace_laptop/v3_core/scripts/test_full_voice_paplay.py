#!/usr/bin/env python3
"""Full voice flow with paplay: mic → wake word → transcription → LLM → TTS → speaker."""
import asyncio
import json
import subprocess
import sys
import time
import wave

try:
    import requests
except ImportError:
    print("[error] requests not installed")
    sys.exit(1)

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
BACKEND_URL = "http://localhost:3005"
SAMPLE_RATE = 16000
CHUNK_SIZE = 1280


def play_wav(path: str):
    import pyaudio
    pa = pyaudio.PyAudio()
    wf = wave.open(path, 'rb')
    stream = pa.open(
        format=pa.get_format_from_width(wf.getsampwidth()),
        channels=wf.getnchannels(),
        rate=wf.getframerate(),
        output=True,
    )
    data = wf.readframes(1024)
    while data:
        stream.write(data)
        data = wf.readframes(1024)
    stream.stop_stream()
    stream.close()
    pa.terminate()


async def query_llm(text: str) -> str:
    try:
        r = requests.post(
            f"{BACKEND_URL}/api/llm/chat",
            json={"message": text},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        return data.get("text", "")
    except Exception as e:
        return f"[LLM error: {e}]"


async def synthesize_tts(text: str, output_path: str) -> bool:
    try:
        r = requests.post(
            f"{BACKEND_URL}/api/tts/speak",
            json={"text": text},
            timeout=30,
        )
        r.raise_for_status()
        with open(output_path, 'wb') as f:
            f.write(r.content)
        return True
    except Exception as e:
        print(f"[TTS error] {e}")
        return False


async def run():
    print("=" * 70)
    print("FULL VOICE FLOW (with paplay loopback)")
    print("=" * 70)
    print()
    print("This test will:")
    print("  1. Play 'Hey Jarvis' through speakers (loopback)")
    print("  2. Capture mic and detect wake word")
    print("  3. Wait for ASR to transcribe (use pre-loaded Spanish phrase if needed)")
    print("  4. Send to LLM, get response")
    print("  5. Synthesize TTS, play on speaker")
    print()
    
    pa = pyaudio.PyAudio()
    mic = pa.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=SAMPLE_RATE,
        input=True,
        frames_per_buffer=CHUNK_SIZE,
    )
    
    async with websockets.connect(PIPELINE_URL) as ws:
        config = await asyncio.wait_for(ws.recv(), timeout=5.0)
        print(f"[✓] Connected")
        print()
        print("-" * 70)
        print("PHASE 1: Wake word detection")
        print("Playing 'Hey Jarvis' on loop, mic listening...")
        print("-" * 70)
        
        play_proc = subprocess.Popen(
            ["bash", "-c", "while true; do paplay /tmp/hey_jarvis_en.wav; sleep 0.3; done"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        
        wake_fired = False
        wake_time = None
        start = time.monotonic()
        frame_count = 0
        
        try:
            while time.monotonic() - start < 15.0 and not wake_fired:
                data = mic.read(CHUNK_SIZE, exception_on_overflow=False)
                frame_count += 1
                await ws.send(data)
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.02)
                    if isinstance(msg, str):
                        payload = json.loads(msg)
                        if payload.get("status") == "wake_word":
                            wake_fired = True
                            wake_time = time.monotonic()
                            print(f"[✓✓✓] WAKE WORD at frame {frame_count} ({time.monotonic()-start:.1f}s)")
                            break
                except asyncio.TimeoutError:
                    pass
        finally:
            play_proc.terminate()
            play_proc.wait()
        
        if not wake_fired:
            print("[✗] Wake word failed. Aborting.")
            mic.stop_stream()
            mic.close()
            pa.terminate()
            return
        
        print()
        print("-" * 70)
        print("PHASE 2: Capture Spanish order (15s window)")
        print("Speak your order in Spanish NOW, e.g.: 'quiero un cafe'")
        print("-" * 70)
        
        asr_deadline = wake_time + 15.0
        transcription = ""
        last_print = time.monotonic()
        
        while time.monotonic() < asr_deadline:
            data = mic.read(CHUNK_SIZE, exception_on_overflow=False)
            frame_count += 1
            await ws.send(data)
            
            now = time.monotonic()
            if now - last_print > 2.0:
                remaining = asr_deadline - now
                print(f"  [{now-start:.1f}s] listening... {remaining:.1f}s remaining")
                last_print = now
            
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=0.05)
                if isinstance(msg, str):
                    payload = json.loads(msg)
                    for line in payload.get("lines", []):
                        text = line.get("text", "").strip()
                        if text:
                            transcription = text
                    buffer = payload.get("buffer_transcription", "").strip()
                    if buffer and not transcription:
                        transcription = buffer
            except asyncio.TimeoutError:
                pass
        
        print()
        print("-" * 70)
        print(f"Transcription: '{transcription}'")
        print("-" * 70)
        
        if not transcription:
            print("[!] No transcription captured. Using fallback phrase for LLM test.")
            transcription = "Hola, quiero un cafe con leche por favor"
            print(f"  Fallback: '{transcription}'")
        
        print()
        print("PHASE 3: LLM")
        print("-" * 70)
        llm_response = await query_llm(transcription)
        print(f"LLM: {llm_response}")
        print()
        
        tts_text = llm_response[:300]
        print("PHASE 4: TTS")
        print("-" * 70)
        tts_path = "/tmp/chipi_response.wav"
        if await synthesize_tts(tts_text, tts_path):
            print(f"[✓] TTS audio: {tts_path}")
            print()
            print("PHASE 5: Playback")
            print("-" * 70)
            play_wav(tts_path)
            print("[✓] Done!")
        else:
            print("[✗] TTS failed")
    
    mic.stop_stream()
    mic.close()
    pa.terminate()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\n[*] Interrupted")

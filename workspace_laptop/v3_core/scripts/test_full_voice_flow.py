#!/usr/bin/env python3
"""
Full voice flow test: mic → wake word → transcription → LLM → TTS → speaker.
Records mic audio, sends to pipeline, watches for wake word + transcription.
After transcription, queries LLM and synthesizes TTS, plays result on speaker.
"""
import asyncio
import base64
import json
import sys
import time

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


async def play_wav(path: str):
    import wave
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
    """Call backend LLM endpoint."""
    try:
        r = requests.post(
            f"{BACKEND_URL}/api/llm/chat",
            json={"message": text},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        return data.get("text") or data.get("response") or str(data)
    except Exception as e:
        return f"[LLM error: {e}]"


async def synthesize_tts(text: str, output_path: str) -> bool:
    """Call backend TTS endpoint."""
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


async def run_test():
    print("=" * 70)
    print("FULL VOICE FLOW TEST")
    print("=" * 70)
    print()
    print("Instructions:")
    print("  1. Wait for the test to start")
    print("  2. Say 'Hey Jarvis' clearly in English (wake word)")
    print("  3. After ~1 second, say your order in Spanish, e.g.:")
    print("     'Quiero un cafe con leche' or 'Me puedes traer un jugo'")
    print("  4. The system will:")
    print("     - Detect wake word")
    print("     - Transcribe your Spanish speech")
    print("     - Send to LLM")
    print("     - Generate TTS response")
    print("     - Play it through the speakers")
    print()
    print("=" * 70)
    print()
    
    pa = pyaudio.PyAudio()
    mic = pa.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=SAMPLE_RATE,
        input=True,
        frames_per_buffer=CHUNK_SIZE,
    )
    
    print("[*] Connecting to pipeline at :8001...")
    async with websockets.connect(PIPELINE_URL) as ws:
        config = await asyncio.wait_for(ws.recv(), timeout=5.0)
        print(f"[✓] Connected. Config: {json.loads(config).get('type')}")
        print()
        print("-" * 70)
        print("LISTENING — Say 'Hey Jarvis' now...")
        print("-" * 70)
        
        wake_fired = False
        wake_time = None
        transcription = ""
        asr_deadline = None
        
        start = time.monotonic()
        frame_count = 0
        last_status_print = start
        
        while time.monotonic() - start < 30.0:
            data = mic.read(CHUNK_SIZE, exception_on_overflow=False)
            frame_count += 1
            
            await ws.send(data)
            
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=0.05)
                if isinstance(msg, str):
                    payload = json.loads(msg)
                    status = payload.get("status", "")
                    
                    now = time.monotonic()
                    if now - last_status_print > 2.0:
                        print(f"  [{now-start:.1f}s] frame {frame_count}, status={status or 'transcription'}")
                        last_status_print = now
                    
                    if status == "wake_word":
                        wake_fired = True
                        wake_time = time.monotonic()
                        asr_deadline = wake_time + 15.0
                        print()
                        print(f"[✓✓✓] WAKE WORD DETECTED at frame {frame_count}!")
                        print(f"  ASR is now ACTIVE for 15 seconds — SPEAK YOUR ORDER NOW")
                        print()
                        last_status_print = time.monotonic()
                    
                    if wake_fired:
                        # Collect transcription
                        lines = payload.get("lines", [])
                        buffer_text = payload.get("buffer_transcription", "")
                        for line in lines:
                            text = line.get("text", "").strip()
                            if text:
                                transcription = text  # use last committed line
                        if buffer_text and not transcription:
                            transcription = buffer_text
                        
                        # Check if ASR window expired
                        if time.monotonic() > asr_deadline and transcription:
                            break
            except asyncio.TimeoutError:
                pass
        
        print()
        print("-" * 70)
        print(f"[DEBUG] wake_fired={wake_fired}, frames={frame_count}, duration={time.monotonic()-start:.1f}s")
        print(f"[DEBUG] transcription: '{transcription}'")
        print("-" * 70)
        print()
        
        if not wake_fired:
            print("[✗] Wake word was NEVER detected. Aborting LLM/TTS phase.")
            print("    Try speaking louder, or closer to the mic, or with clearer English pronunciation.")
        elif not transcription:
            print("[!] Wake word fired but no transcription was captured.")
            print("    Maybe you didn't say anything after the wake word?")
            print("    Or the audio was too quiet for WhisperLiveKit to transcribe.")
        else:
            print(f"[✓] Got transcription: '{transcription}'")
            print()
            print("-" * 70)
            print("Sending to LLM...")
            print("-" * 70)
            llm_response = await query_llm(transcription)
            print(f"[LLM response]: {llm_response}")
            print()
            
            # Truncate for TTS
            tts_text = llm_response[:300] if len(llm_response) > 300 else llm_response
            
            print("-" * 70)
            print("Synthesizing TTS...")
            print("-" * 70)
            tts_path = "/tmp/chipi_response.wav"
            if await synthesize_tts(tts_text, tts_path):
                print(f"[✓] TTS saved to {tts_path}")
                print()
                print("-" * 70)
                print("Playing response on speaker...")
                print("-" * 70)
                await play_wav(tts_path)
                print("[✓] Done!")
            else:
                print("[✗] TTS failed")
    
    mic.stop_stream()
    mic.close()
    pa.terminate()


if __name__ == "__main__":
    try:
        asyncio.run(run_test())
    except KeyboardInterrupt:
        print("\n[*] Interrupted by user")

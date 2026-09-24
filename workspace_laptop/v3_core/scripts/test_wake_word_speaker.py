#!/usr/bin/env python3
"""
Test wake word with speaker playback + mic capture.
Plays 'Hey Jarvis' audio through speakers while capturing mic and sending to pipeline.
"""
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
CHUNK_SIZE = 1280  # 80ms at 16kHz int16 (2 bytes per sample = 2560 bytes)


async def test_wake_word_with_speaker():
    print("=" * 60)
    print("WAKE WORD TEST: speaker playback + mic capture")
    print("=" * 60)
    print(f"Audio file: {AUDIO_FILE}")
    print(f"Pipeline: {PIPELINE_URL}")
    print()
    
    pa = pyaudio.PyAudio()
    
    print("[*] Opening mic stream...")
    mic = pa.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=SAMPLE_RATE,
        input=True,
        frames_per_buffer=CHUNK_SIZE,
    )
    
    print("[*] Opening speaker stream for playback...")
    import wave
    wf = wave.open(AUDIO_FILE, 'rb')
    spk = pa.open(
        format=pa.get_format_from_width(wf.getsampwidth()),
        channels=wf.getnchannels(),
        rate=wf.getframerate(),
        output=True,
    )
    
    print("[*] Connecting to pipeline...")
    async with websockets.connect(PIPELINE_URL) as ws:
        print("[✓] Connected")
        config = await asyncio.wait_for(ws.recv(), timeout=5.0)
        print(f"[✓] Config: {json.loads(config).get('type')}")
        print()
        print("-" * 60)
        print("SPEAK 'Hey Jarvis' now (or audio will play automatically)")
        print("Will loop for 15 seconds, watching for wake word detection...")
        print("-" * 60)
        print()
        
        wake_detected = False
        start_time = time.monotonic()
        frame_count = 0
        
        # Background task: play audio on speaker in loop
        async def play_audio_loop():
            while time.monotonic() - start_time < 15.0 and not wake_detected:
                wf.rewind()
                data = wf.readframes(1024)
                while data and not wake_detected:
                    spk.write(data)
                    data = wf.readframes(1024)
                    await asyncio.sleep(0)
        
        play_task = asyncio.create_task(play_audio_loop())
        
        # Main loop: capture mic and send to pipeline
        while time.monotonic() - start_time < 15.0 and not wake_detected:
            try:
                data = mic.read(CHUNK_SIZE, exception_on_overflow=False)
                frame_count += 1
                
                if frame_count % 12 == 0:  # every ~1s
                    elapsed = time.monotonic() - start_time
                    print(f"  [{elapsed:.1f}s] frame {frame_count}, listening...")
                
                await ws.send(data)
                
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.05)
                    if isinstance(msg, str):
                        payload = json.loads(msg)
                        status = payload.get("status", "")
                        if status == "wake_word":
                            print()
                            print(f"[✓✓✓] WAKE WORD DETECTED! detail={payload.get('detail')}")
                            wake_detected = True
                            break
                        elif status:
                            pass  # ignore "listening" status
                        
                        # Also check wake_word.activated in transcription messages
                        ww_info = payload.get("wake_word", {})
                        if ww_info.get("activated"):
                            print()
                            print(f"[✓✓✓] WAKE WORD ACTIVATED via transcription! state={ww_info.get('state')}")
                            wake_detected = True
                            break
                except asyncio.TimeoutError:
                    pass
                    
            except Exception as e:
                print(f"[error] {e}")
                break
        
        play_task.cancel()
        try:
            await play_task
        except asyncio.CancelledError:
            pass
        
        elapsed = time.monotonic() - start_time
        print()
        print("-" * 60)
        if wake_detected:
            print(f"[✓] WAKE WORD DETECTED after {elapsed:.1f}s ({frame_count} frames)")
        else:
            print(f"[✗] No wake word detected in {elapsed:.1f}s ({frame_count} frames)")
        print("-" * 60)
    
    mic.stop_stream()
    mic.close()
    spk.stop_stream()
    spk.close()
    wf.close()
    pa.terminate()
    
    return wake_detected


if __name__ == "__main__":
    result = asyncio.run(test_wake_word_with_speaker())
    sys.exit(0 if result else 1)

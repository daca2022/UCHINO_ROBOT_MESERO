#!/usr/bin/env python3
"""
Simulates what the browser sends: PCM16 mono audio via binary protocol to /ws/robot.
Validates the end-to-end flow from browser→backend→pipeline→WhisperLiveKit→LLM→TTS→response.
"""
import asyncio
import json
import struct
import sys
import websockets
import pyaudio
import wave

WS_URL = "ws://localhost:3005/ws/robot"
SAMPLE_RATE = 16000
MAGIC = 0xA5
TYPE_MONO = 0x01
HEADER = 6


def build_packet(seq: int, pcm_bytes: bytes) -> bytes:
    return struct.pack(">BBHH", MAGIC, TYPE_MONO, seq & 0xFFFF, len(pcm_bytes)) + pcm_bytes


async def play_audio_chunks(ws, audio_path):
    with wave.open(audio_path, 'rb') as wf:
        sample_rate = wf.getframerate()
        audio = wf.readframes(wf.getnframes())
    pa = pyaudio.PyAudio()
    stream = pa.open(format=pyaudio.paInt16, channels=1, rate=sample_rate, output=True)
    chunk_size = 3200  # 100ms at 16kHz mono
    seq = 0
    for i in range(0, len(audio), chunk_size):
        chunk = audio[i:i+chunk_size]
        if len(chunk) < chunk_size:
            chunk = chunk + b'\x00' * (chunk_size - len(chunk))
        stream.write(chunk)
        await ws.send(build_packet(seq, chunk))
        seq += 1
        await asyncio.sleep(0.05)
    stream.stop_stream()
    stream.close()
    pa.terminate()
    for pad in range(20):
        await ws.send(build_packet(seq, b'\x00' * chunk_size))
        seq += 1
        await asyncio.sleep(0.05)
    return seq


async def main():
    print(f"[*] Connecting to {WS_URL}...")
    async with websockets.connect(WS_URL, max_size=2**24) as ws:
        print("[✓] Connected")
        audio_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/hey_jarvis_en.wav"
        print(f"[*] Sending audio: {audio_path}")
        seq_count = await play_audio_chunks(ws, audio_path)
        print(f"[*] Sent {seq_count} packets")
        print("[*] Listening for response (30s)...")
        try:
            response_chunks = []
            for _ in range(60):
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                if isinstance(msg, bytes):
                    if len(msg) < HEADER:
                        continue
                    magic, ptype, pseq, plen = struct.unpack(">BBHH", msg[:HEADER])
                    if magic != MAGIC:
                        continue
                    response_chunks.append(msg[HEADER:HEADER+plen])
                    print(f"  [response] chunk {len(response_chunks)}: type={ptype} len={plen}")
                else:
                    try:
                        data = json.loads(msg)
                        print(f"  [json] {data}")
                    except:
                        print(f"  [text] {msg[:200]}")
        except websockets.exceptions.ConnectionClosed:
            pass
        print(f"\n[*] Total response chunks: {len(response_chunks)}")
        if response_chunks:
            total_bytes = sum(len(c) for c in response_chunks)
            print(f"[*] Total audio bytes: {total_bytes}")
            print(f"[*] Duration: ~{total_bytes / (SAMPLE_RATE * 2):.1f}s")
            with wave.open('/tmp/chipi_browser_response.wav', 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(SAMPLE_RATE)
                wf.writeframes(b''.join(response_chunks))
            print("[✓] Saved to /tmp/chipi_browser_response.wav")


if __name__ == "__main__":
    asyncio.run(main())

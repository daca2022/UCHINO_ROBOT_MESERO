#!/usr/bin/env python3
"""Test if pyaudio can capture mic audio."""
import pyaudio
import numpy as np

SAMPLE_RATE = 16000
CHUNK_SIZE = 1600  # 100ms

pa = pyaudio.PyAudio()

print("Available audio devices:")
for i in range(pa.get_device_count()):
    info = pa.get_device_info_by_index(i)
    if info['maxInputChannels'] > 0:
        print(f"  [{i}] {info['name']} (inputs={info['maxInputChannels']})")

print("\nOpening default input device...")
try:
    stream = pa.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=SAMPLE_RATE,
        input=True,
        input_device_index=None,
        frames_per_buffer=CHUNK_SIZE
    )
    print("Stream opened successfully!")
    
    print("\nRecording 3 seconds of audio...")
    frames = []
    for i in range(30):
        data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
        frames.append(data)
        audio_np = np.frombuffer(data, dtype=np.int16)
        rms = np.sqrt(np.mean(audio_np.astype(np.float32)**2))
        print(f"  Chunk {i+1}: RMS={rms:.1f}")
    
    stream.stop_stream()
    stream.close()
    
    all_data = b''.join(frames)
    audio_np = np.frombuffer(all_data, dtype=np.int16)
    print(f"\nTotal samples: {len(audio_np)}")
    print(f"Overall RMS: {np.sqrt(np.mean(audio_np.astype(np.float32)**2)):.1f}")
    print(f"Max amplitude: {np.max(np.abs(audio_np))}")
    
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()

pa.terminate()

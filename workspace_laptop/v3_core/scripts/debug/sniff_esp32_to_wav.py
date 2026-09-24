#!/usr/bin/env python3
"""
sniff_esp32_to_wav.py

Conecta al backend :3011 y actúa como ESP32 fake. Recibe TTS y envía PCM.
Graba el PCM enviado y el TTS recibido como WAV.
"""

import socket
import struct
import sys
import time
import wave
import argparse

MAGIC = 0xA5
TYPE_PCM_MONO = 0x01
TYPE_PCM_STEREO = 0x02
TYPE_COMPASS = 0x03
TYPE_CONTROL = 0x04


def parse_frame(buf):
    if len(buf) < 6 or buf[0] != MAGIC:
        return None, b''
    ftype = buf[1]
    seq = struct.unpack('>H', buf[2:4])[0]
    plen = struct.unpack('>H', buf[4:6])[0]
    if len(buf) < 6 + plen:
        return None, buf
    return (ftype, seq, plen, bytes(buf[6:6 + plen])), buf[6 + plen:]


def make_frame(ftype, seq, payload):
    return bytes([MAGIC, ftype]) + struct.pack('>HH', seq, len(payload)) + payload


def fake_audio(duration, sr=16000, freq=440, channels=1, vol=0.05):
    import math
    n = int(sr * duration)
    out = bytearray()
    for i in range(n):
        s = int(vol * 32767 * math.sin(2 * math.pi * freq * i / sr))
        if channels == 2:
            out += struct.pack('<hh', s, s)
        else:
            out += struct.pack('<h', s)
    return bytes(out)


def human_voice_like(duration, sr=16000):
    import math, random
    n = int(sr * duration)
    out = bytearray()
    fundamental = 130
    for i in range(n):
        t = i / sr
        env = 0.5 + 0.5 * math.sin(2 * math.pi * 2 * t)
        if env < 0.05:
            env = 0
        s = sum(
            int(env * 3000 * math.sin(2 * math.pi * (fundamental * h) * t + random.uniform(-0.1, 0.1)))
            for h in [1, 2, 3, 4, 5]
        )
        s = max(-32767, min(32767, s))
        out += struct.pack('<h', s)
    return bytes(out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--duration', type=int, default=10)
    ap.add_argument('--out-raw', default='/tmp/esp32_pcm_stereo.wav')
    ap.add_argument('--out-mono', default='/tmp/esp32_pcm_mono.wav')
    ap.add_argument('--mode', choices=['tone', 'voice', 'silence'], default='voice')
    args = ap.parse_args()

    s = socket.socket()
    s.settimeout(5)
    s.connect(('127.0.0.1', 3011))
    print('[esp] conectado a 127.0.0.1:3011')

    if args.mode == 'tone':
        audio = fake_audio(args.duration, freq=440, channels=2, vol=0.05)
    elif args.mode == 'voice':
        audio = human_voice_like(args.duration)
    else:
        audio = bytes(32000 * args.duration)

    chunk = 1024
    pcm_mono = bytearray()
    pcm_stereo = bytearray()
    received = bytearray()
    pending = b''
    t0 = time.time()
    seq = 0
    pos = 0
    while time.time() - t0 < args.duration and pos < len(audio):
        n = min(chunk, len(audio) - pos)
        payload = audio[pos:pos + n]
        pos += n
        s.sendall(make_frame(TYPE_PCM_STEREO, seq, payload))
        seq += 1
        time.sleep(0.03)

        try:
            s.settimeout(0.05)
            data = s.recv(65536)
            if data:
                received += data
                pending += data
                while len(pending) >= 6:
                    f, pending = parse_frame(pending)
                    if f is None:
                        break
        except socket.timeout:
            pass
    print(f'[esp] sent {pos} bytes in {seq} frames')
    print(f'[esp] received {len(received)} bytes from backend')

    for i in range(0, len(received) - 1, 4):
        if i + 4 <= len(received):
            l = struct.unpack('<h', received[i:i + 2])[0]
            r = struct.unpack('<h', received[i + 2:i + 4])[0]
            pcm_stereo += struct.pack('<hh', l, r)
            pcm_mono += struct.pack('<h', l)

    if pcm_stereo:
        with wave.open(args.out_raw, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm_stereo)
        print(f'[esp] saved TTS to {args.out_raw}')
    if pcm_mono:
        with wave.open(args.out_mono, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm_mono)
        print(f'[esp] saved TTS to {args.out_mono}')
    s.close()

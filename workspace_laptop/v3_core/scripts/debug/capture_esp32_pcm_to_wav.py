#!/usr/bin/env python3
"""
capture_esp32_pcm_to_wav.py

Captura el PCM real que llega del ESP32 al backend por TCP :3011 y lo guarda
como WAV para inspección.

Usa: el ESP32 (o el script de prueba) envía frames con header 0xA5 0x01 (PCM mono)
o 0xA5 0x02 (PCM stereo), seq 2 bytes BE, len 2 bytes BE, payload PCM 16-bit LE.
"""

import socket
import struct
import sys
import time
import wave
import argparse
import threading


MAGIC = 0xA5
TYPE_PCM_MONO = 0x01
TYPE_PCM_STEREO = 0x02


def parse_frame(buf):
    if len(buf) < 6:
        return None, b''
    if buf[0] != MAGIC:
        return None, buf[1:]
    ftype = buf[1]
    seq = struct.unpack('>H', buf[2:4])[0]
    plen = struct.unpack('>H', buf[4:6])[0]
    if len(buf) < 6 + plen:
        return None, buf
    payload = bytes(buf[6:6 + plen])
    return (ftype, seq, plen, payload), buf[6 + plen:]


def tcp_client(host, port, duration, out_wav, listen_only):
    s = socket.socket()
    s.settimeout(5)
    s.connect((host, port))
    print(f'[client] Connected to {host}:{port}')

    captured = bytearray()
    pcm_mono = bytearray()
    pcm_stereo = bytearray()
    t0 = time.time()
    pending = b''
    total_frames = 0
    total_bytes = 0
    sample_rate = 16000
    channels = 1

    while time.time() - t0 < duration:
        try:
            data = s.recv(65536)
            if not data:
                print('[client] remote closed')
                break
        except socket.timeout:
            print('[client] recv timeout')
            break
        pending += data
        while len(pending) >= 6:
            frame, pending = parse_frame(pending)
            if frame is None:
                break
            ftype, seq, plen, payload = frame
            total_frames += 1
            total_bytes += len(payload)
            captured += payload
            if ftype == TYPE_PCM_MONO:
                pcm_mono += payload
                channels = 1
            elif ftype == TYPE_PCM_STEREO:
                pcm_stereo += payload
                channels = 2
            if total_frames % 50 == 0:
                print(f'[client] frames={total_frames} bytes={total_bytes} time={time.time() - t0:.1f}s')
    print(f'[client] Done. frames={total_frames} bytes={total_bytes} duration={time.time() - t0:.1f}s')
    print(f'[client] mono bytes={len(pcm_mono)} stereo bytes={len(pcm_stereo)}')

    if pcm_stereo and not pcm_mono:
        samples = []
        for i in range(0, len(pcm_stereo) - 1, 4):
            l = struct.unpack('<h', pcm_stereo[i:i + 2])[0]
            r = struct.unpack('<h', pcm_stereo[i + 2:i + 4])[0]
            samples.append((l, r))
        left = [s[0] for s in samples]
        right = [s[1] for s in samples]
        lrms = (sum(x * x for x in left) / max(1, len(left))) ** 0.5
        rrms = (sum(x * x for x in right) / max(1, len(right))) ** 0.5
        print(f'[client] stereo L RMS={lrms:.1f} R RMS={rrms:.1f} active={("L" if lrms > rrms else "R" if rrms > lrms else "BOTH")}')

        with wave.open(out_wav, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm_stereo)
        print(f'[client] saved stereo raw -> {out_wav}')

        chosen = left if lrms > rrms else right
        with wave.open(out_wav.replace('.wav', '_mono.wav'), 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(struct.pack('<' + 'h' * len(chosen), *chosen))
        print(f'[client] saved chosen channel -> {out_wav.replace(".wav", "_mono.wav")}')

    elif pcm_mono:
        with wave.open(out_wav, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm_mono)
        print(f'[client] saved mono -> {out_wav}')

    s.close()


def tcp_spy(host, port, duration, out_wav):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(1)
    print(f'[spy] listening on {host}:{port}')
    srv.settimeout(duration + 5)
    try:
        conn, addr = srv.accept()
    except socket.timeout:
        print('[spy] no client')
        return
    print(f'[spy] client {addr}')
    conn.settimeout(2)

    captured = bytearray()
    pcm_mono = bytearray()
    pcm_stereo = bytearray()
    t0 = time.time()
    pending = b''
    total_frames = 0
    sample_rate = 16000
    while time.time() - t0 < duration:
        try:
            data = conn.recv(65536)
            if not data:
                break
        except socket.timeout:
            break
        pending += data
        while len(pending) >= 6:
            frame, pending = parse_frame(pending)
            if frame is None:
                break
            ftype, seq, plen, payload = frame
            total_frames += 1
            captured += payload
            if ftype == TYPE_PCM_MONO:
                pcm_mono += payload
            elif ftype == TYPE_PCM_STEREO:
                pcm_stereo += payload
        if total_frames % 50 == 0:
            print(f'[spy] frames={total_frames} time={time.time() - t0:.1f}s')

    print(f'[spy] Done. frames={total_frames} bytes={len(captured)} duration={time.time() - t0:.1f}s')

    if pcm_stereo and not pcm_mono:
        samples = []
        for i in range(0, len(pcm_stereo) - 1, 4):
            l = struct.unpack('<h', pcm_stereo[i:i + 2])[0]
            r = struct.unpack('<h', pcm_stereo[i + 2:i + 4])[0]
            samples.append((l, r))
        left = [s[0] for s in samples]
        right = [s[1] for s in samples]
        lrms = (sum(x * x for x in left) / max(1, len(left))) ** 0.5
        rrms = (sum(x * x for x in right) / max(1, len(right))) ** 0.5
        print(f'[spy] stereo L RMS={lrms:.1f} R RMS={rrms:.1f} active={("L" if lrms > rrms else "R" if rrms > lrms else "BOTH")}')
        with wave.open(out_wav, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm_stereo)
        chosen = left if lrms > rrms else right
        with wave.open(out_wav.replace('.wav', '_mono.wav'), 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(struct.pack('<' + 'h' * len(chosen), *chosen))

    elif pcm_mono:
        with wave.open(out_wav, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm_mono)
        print(f'[spy] saved mono -> {out_wav}')

    conn.close()
    srv.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=['spy', 'client'], default='client')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=3011)
    ap.add_argument('--duration', type=int, default=10)
    ap.add_argument('--out', default='/tmp/esp32_capture.wav')
    args = ap.parse_args()

    if args.mode == 'spy':
        tcp_spy(args.host, args.port, args.duration, args.out)
    else:
        tcp_client(args.host, args.port, args.duration, args.out, False)

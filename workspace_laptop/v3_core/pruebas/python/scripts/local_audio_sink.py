#!/usr/bin/env python3
"""
Local audio sink for testing without ESP32.

Connects to Node-RED WebSocket output (same channel used by ESP32),
receives JSON messages with base64 PCM audio, and plays audio on laptop.
"""

import argparse
import asyncio
import base64
import json
import sys
from typing import Optional

import sounddevice as sd
import websockets


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Play Node-RED audio locally")
    parser.add_argument("--host", default="127.0.0.1", help="WebSocket host")
    parser.add_argument("--port", type=int, default=1880, help="WebSocket port")
    parser.add_argument("--path", default="/ws/esp32", help="WebSocket path")
    parser.add_argument("--samplerate", type=int, default=24000, help="PCM sample rate")
    parser.add_argument("--channels", type=int, default=1, help="PCM channels")
    parser.add_argument("--device", default=None, help="Output device index or name")
    parser.add_argument("--list-devices", action="store_true", help="List audio devices")
    return parser.parse_args()


def list_devices() -> None:
    print(sd.query_devices())


def open_stream(samplerate: int, channels: int, device: Optional[str]):
    return sd.RawOutputStream(
        samplerate=samplerate,
        channels=channels,
        dtype="int16",
        blocksize=0,
        device=device,
    )


async def run_client(args: argparse.Namespace) -> None:
    ws_url = f"ws://{args.host}:{args.port}{args.path}"
    print(f"Connecting to {ws_url}")

    with open_stream(args.samplerate, args.channels, args.device) as stream:
        print("Audio output stream started")

        while True:
            try:
                async with websockets.connect(ws_url, max_size=None, ping_interval=20) as ws:
                    print("WebSocket connected")
                    async for msg in ws:
                        if isinstance(msg, bytes):
                            # Flow currently sends text JSON, but support binary passthrough.
                            stream.write(msg)
                            continue

                        try:
                            payload = json.loads(msg)
                        except json.JSONDecodeError:
                            continue

                        msg_type = payload.get("tipo")
                        if msg_type == "audio":
                            b64 = payload.get("data")
                            if not b64:
                                continue
                            try:
                                pcm = base64.b64decode(b64)
                            except Exception:
                                continue
                            stream.write(pcm)
                        elif msg_type == "transcripcion_salida":
                            text = payload.get("texto", "")
                            if text:
                                print(f"Chipi: {text}")
                        elif msg_type == "error":
                            print(f"Flow error: {payload.get('mensaje', 'unknown')}")
            except Exception as exc:
                print(f"Reconnect in 2s ({exc})")
                await asyncio.sleep(2)


def main() -> int:
    args = parse_args()

    if args.list_devices:
        list_devices()
        return 0

    try:
        asyncio.run(run_client(args))
    except KeyboardInterrupt:
        print("Stopped")
        return 0
    except Exception as exc:
        print(f"Fatal error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

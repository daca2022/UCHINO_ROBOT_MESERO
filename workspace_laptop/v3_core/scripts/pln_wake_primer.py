#!/usr/bin/env python3
"""
Plays 'Hey Jarvis' once through speakers, then exits.
This primes the wake word detector in the shared pipeline.
The user then speaks their order — the running PLN's connection captures it.
"""
import subprocess
import sys
import time

AUDIO_FILE = "/tmp/hey_jarvis_en.wav"

if __name__ == "__main__":
    print(f"[*] Playing '{AUDIO_FILE}' once...")
    print(f"[*] After this, speak your order in Spanish within 15 seconds.")
    print(f"[*] The running PLN will capture and process it.\n")
    subprocess.run(["paplay", AUDIO_FILE])
    print(f"[✓] Done. Now speak your order!")

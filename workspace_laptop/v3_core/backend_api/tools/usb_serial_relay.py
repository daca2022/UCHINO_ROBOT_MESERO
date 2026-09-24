#!/usr/bin/env python3
"""
USB-Serial relay for ESP32 audio bridge.
Reads PCM frames from /dev/ttyACM0 (USB-Serial-JTAG) and forwards to TCP localhost:3012.
Handles mixed debug output + binary frames by scanning for 0xA5 magic byte.
"""
import serial
import socket
import struct
import sys
import time
import os
import select

SERIAL_PORT = os.environ.get('USB_SERIAL_PORT', '/dev/ttyACM0')
SERIAL_BAUD = int(os.environ.get('USB_SERIAL_BAUD', '2000000'))
TCP_HOST = os.environ.get('TCP_HOST', '127.0.0.1')
TCP_PORT = int(os.environ.get('TCP_PORT', '3012'))

MAGIC = 0xA5
HEADER_SIZE = 6  # magic(1) + type(1) + seq(2) + len(2)
MAX_PAYLOAD = 64000

def create_tcp_conn():
    while True:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.connect((TCP_HOST, TCP_PORT))
            s.setblocking(1)
            print(f"[relay] TCP connected to {TCP_HOST}:{TCP_PORT}")
            return s
        except ConnectionRefusedError:
            print("[relay] TCP connection refused, retrying in 2s...")
            time.sleep(2)
        except Exception as e:
            print(f"[relay] TCP error: {e}, retrying in 5s...")
            time.sleep(5)

def main():
    ser = None
    tcp = None
    
    while True:
        try:
            if ser is None:
                print(f"[relay] Opening {SERIAL_PORT} at {SERIAL_BAUD} baud...")
                ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=0.1)
                ser.setDTR(False)  # don't reset ESP32 on open
                ser.flushInput()
                print(f"[relay] Serial open: {ser.name}")
            
            if tcp is None:
                tcp = create_tcp_conn()
            
            # Read raw bytes from USB serial
            data = ser.read(ser.in_waiting or 1)
            if not data:
                time.sleep(0.001)
                continue
            
            # Scan for frames in the data stream
            buf = data
            offset = 0
            
            while offset < len(buf):
                # Find magic byte
                if buf[offset] != MAGIC:
                    # Skip non-magic bytes (debug output, etc.)
                    offset += 1
                    continue
                
                # Need at least header
                if offset + HEADER_SIZE > len(buf):
                    break
                
                # Parse header
                frame_type = buf[offset + 1]
                seq = struct.unpack('>H', buf[offset+2:offset+4])[0]
                payload_len = struct.unpack('>H', buf[offset+4:offset+6])[0]
                
                if payload_len > MAX_PAYLOAD:
                    # Invalid length, skip this byte
                    offset += 1
                    continue
                
                frame_len = HEADER_SIZE + payload_len
                
                if offset + frame_len > len(buf):
                    break  # incomplete frame, wait for more data
                
                # Complete frame found
                frame = buf[offset:offset + frame_len]
                
                # Forward to TCP
                try:
                    tcp.sendall(frame)
                except (BrokenPipeError, ConnectionResetError):
                    print("[relay] TCP disconnected, reconnecting...")
                    tcp.close()
                    tcp = None
                    continue
                
                offset += frame_len
            
        except serial.SerialException as e:
            print(f"[relay] Serial error: {e}")
            if ser:
                ser.close()
            ser = None
            time.sleep(2)
            
        except KeyboardInterrupt:
            print("\n[relay] Shutting down...")
            break
            
        except Exception as e:
            print(f"[relay] Error: {type(e).__name__}: {e}")
            time.sleep(1)
    
    if ser:
        ser.close()
    if tcp:
        tcp.close()

if __name__ == '__main__':
    main()

import socket
import sys

def main():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('0.0.0.0', 3012))
    s.listen(1)
    print("Listening on 3012...")
    while True:
        conn, addr = s.accept()
        print(f"Connected from {addr}")
        conn.settimeout(5.0)
        try:
            while True:
                data = conn.recv(1024)
                if not data:
                    print("Disconnected by remote")
                    break
                print(f"Received {len(data)} bytes: {data[:16].hex()}...")
        except Exception as e:
            print(f"Error: {e}")
        conn.close()

if __name__ == '__main__':
    main()

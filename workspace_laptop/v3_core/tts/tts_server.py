"""Persistent TTS server — Kokoro + optional Auron RVC.
Spawned by Node.js backend. Listens on localhost:3500.
Loads models once, keeps them alive for all requests."""
import json, os, sys, logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

_SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
sys.path.insert(0, os.path.join(_SCRIPT_DIR, '..'))
logging.basicConfig(level=logging.WARNING, format='%(levelname)s:%(name)s:%(message)s')
logger = logging.getLogger('tts_server')

from tts.tts_manager import TTSManager

_MGR = None

def get_manager():
    global _MGR
    if _MGR is None:
        device = 'cuda' if os.environ.get('TTS_DEVICE') == 'cuda' else None
        _MGR = TTSManager(auron_enabled=True)
        logger.info(f'TTSManager ready (auron_enabled=True, device={device or "auto"})')
    return _MGR


class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        logger.debug(fmt, *args)

    def _send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length > 0 else b'{}'
        try:
            args = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {'error': 'invalid json'})
            return

        if path == '/speak':
            text = (args.get('text') or '').strip()
            if not text:
                self._send_json(400, {'error': 'empty text'})
                return
            try:
                mgr = get_manager()
                mgr.auron_enabled = args.get('use_rvc', True)
                result = mgr.synthesize_with_engine(text, emotion=args.get('emotion'))
                if not result:
                    self._send_json(500, {'error': 'synthesis failed'})
                    return
                self._send_json(200, {'success': True, **result})
            except Exception as e:
                logger.error(f'speak error: {e}')
                self._send_json(500, {'error': str(e)})
        elif path == '/health':
            self._send_json(200, {'ok': True, 'manager': _MGR is not None})
        else:
            self._send_json(404, {'error': 'not found'})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/health':
            self._send_json(200, {'ok': True, 'manager': _MGR is not None})
        else:
            self._send_json(404, {'error': 'not found'})


def main():
    port = int(os.environ.get('TTS_PORT', 3500))
    server = HTTPServer(('127.0.0.1', port), TTSHandler)
    logger.info(f'TTS server on 127.0.0.1:{port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()

if __name__ == '__main__':
    main()

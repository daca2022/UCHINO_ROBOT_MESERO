"""CLI entry point for TTS synthesis (Kokoro + optional Auron RVC).
Called from Node.js backend as subprocess. Outputs JSON to stdout."""
import json, sys, os, logging
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

logging.basicConfig(level=logging.WARNING,
                    format='%(levelname)s:%(name)s:%(message)s')

from tts.tts_manager import TTSManager

def main():
    args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    text = args.get('text', '').strip()
    if not text:
        print(json.dumps({'error': 'empty text'}))
        return 1
    
    mgr = TTSManager(auron_enabled=args.get('use_rvc', False))
    result = mgr.synthesize_with_engine(
        text,
        emotion=args.get('emotion'),
    )
    if not result:
        print(json.dumps({'error': 'synthesis failed'}))
        return 1
    
    print(json.dumps(result))
    return 0

if __name__ == '__main__':
    sys.exit(main())

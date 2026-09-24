/**
 * SystemTTSService.mjs - Drop-in replacement for PiperTTSService
 * Uses espeak-ng + ffmpeg for clean 16kHz mono PCM output
 */
import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';

const ESPEAK_BIN = '/home/david/chipi_workspace_pln/archive/v2_openclaw/tools/piper_runtime/piper/espeak-ng';

export class SystemTTSService {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.disponible = true;
  }

  /**
   * Synthesize text and return raw 16kHz mono PCM as base64
   * (same interface as PiperTTSService.sintetizarBase64)
   */
  async sintetizarBase64(texto) {
    const tmpWav = '/tmp/tts_simple.wav';
    const tmpPcm = '/tmp/tts_simple.pcm';
    
    try {
      const safeText = texto.replace(/"/g, '\\"').replace(/\$/g, '');
      
      // 1. espeak-ng generates WAV at 22050Hz
      execSync(`"${ESPEAK_BIN}" -v es -s 150 -p 50 -w "${tmpWav}" "${safeText}"`, {
        timeout: 5000
      });
      
      // 2. ffmpeg converts to raw 16kHz mono PCM
      execSync(`ffmpeg -y -i "${tmpWav}" -ar 16000 -ac 1 -f s16le "${tmpPcm}" 2>/dev/null`, {
        timeout: 5000
      });
      
      // 3. Read raw PCM
      const pcmData = readFileSync(tmpPcm);
      
      // Cleanup
      try { unlinkSync(tmpWav); } catch {}
      try { unlinkSync(tmpPcm); } catch {}
      
      this.logger.log(`[SystemTTS] ${pcmData.length} bytes PCM, ${Math.round(pcmData.length / 32000 * 1000)}ms`);
      return pcmData.toString('base64');
    } catch (error) {
      this.logger.error('[SystemTTS] Error:', error.message);
      return null;
    }
  }
}

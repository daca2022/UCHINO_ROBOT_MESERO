/**
 * SystemTTSService.mjs - Drop-in replacement for PiperTTSService
 * Uses espeak-ng + ffmpeg for clean 16kHz mono PCM output
 */
import { execFileSync, spawnSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';

const ESPEAK_BIN = process.env.ESPEAK_BIN || 'espeak-ng';

function executableAvailable(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

export class SystemTTSService {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.disponible = executableAvailable(ESPEAK_BIN) && executableAvailable('ffmpeg');
  }

  /**
   * Synthesize text and return raw 16kHz mono PCM as base64
   * (same interface as PiperTTSService.sintetizarBase64)
   */
  async sintetizarBase64(texto) {
    const tmpWav = '/tmp/tts_simple.wav';
    const tmpPcm = '/tmp/tts_simple.pcm';
    
    try {
      execFileSync(ESPEAK_BIN, ['-v', 'es', '-s', '150', '-p', '50', '-w', tmpWav, texto], {
        timeout: 5000,
        stdio: 'ignore',
      });
      execFileSync('ffmpeg', ['-y', '-i', tmpWav, '-ar', '16000', '-ac', '1', '-f', 's16le', tmpPcm], {
        timeout: 5000,
        stdio: 'ignore',
      });
      const pcmData = readFileSync(tmpPcm);

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

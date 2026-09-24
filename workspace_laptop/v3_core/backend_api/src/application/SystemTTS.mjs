/**
 * SystemTTS.mjs - Simple TTS using espeak-ng + ffmpeg
 * Outputs clean 16kHz mono raw PCM directly (no WAV header, no resampling needed)
 */
import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';

const ESPEAK_BIN = '/home/david/chipi_workspace_pln/archive/v2_openclaw/tools/piper_runtime/piper/espeak-ng';

export async function sintetizarSimple(texto) {
  const tmpWav = '/tmp/tts_simple.wav';
  const tmpPcm = '/tmp/tts_simple.pcm';
  
  try {
    // 1. espeak-ng generates WAV at 22050Hz (its native rate)
    const safeText = texto.replace(/"/g, '\\"').replace(/\$/g, '');
    execSync(`"${ESPEAK_BIN}" -v es -s 150 -p 50 -w "${tmpWav}" "${safeText}"`, {
      timeout: 5000
    });
    
    // 2. ffmpeg converts to raw 16kHz mono PCM (high-quality resampling)
    execSync(`ffmpeg -y -i "${tmpWav}" -ar 16000 -ac 1 -f s16le "${tmpPcm}" 2>/dev/null`, {
      timeout: 5000
    });
    
    // 3. Read raw PCM bytes (no WAV header - just samples)
    const pcmData = readFileSync(tmpPcm);
    
    // Cleanup
    try { unlinkSync(tmpWav); } catch {}
    try { unlinkSync(tmpPcm); } catch {}
    
    console.log(`[SystemTTS] Generated ${pcmData.length} bytes PCM (16kHz mono, ${Math.round(pcmData.length / 32000 * 1000)}ms)`);
    return pcmData;
  } catch (error) {
    console.error('[SystemTTS] Error:', error.message);
    return null;
  }
}

export function getSystemTTSInfo() {
  return {
    name: 'SystemTTS',
    description: 'espeak-ng + ffmpeg - 16kHz mono raw PCM',
    rate: 16000,
    channels: 1,
    bits: 16
  };
}

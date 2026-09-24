/**
 * PiperTTS — Síntesis de voz offline con Piper TTS.
 * Adaptado de server/services/piper_tts.mjs para la arquitectura hexagonal.
 *
 * Spawnea el binario piper, escribe texto a stdin, captura WAV como base64.
 * Degradación elegante: si Piper no está disponible, `disponible = false`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, promises as fs, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, isAbsolute, dirname } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function existeArchivo(path, mode = constants.F_OK) {
    try {
        accessSync(path, mode);
        return true;
    } catch {
        return false;
    }
}

export class PiperTTSService {
    /**
     * @param {Object} opts
     * @param {string} [opts.bin]        Ruta al ejecutable piper
     * @param {string} [opts.model]      Ruta al modelo .onnx
     * @param {string} [opts.config]     Ruta al archivo .json del modelo
     * @param {number} [opts.outputRate] Tasa de muestreo de salida (Hz)
     * @param {Object} [opts.logger]     Logger con métodos log, warn, error
     */
    constructor(opts = {}) {
        // __dirname = backend_api/src/application/ → 3 niveles arriba = robot_mesero_final/
        this.projectRoot = resolve(__dirname, '..', '..', '..');

        this.bin = this._resolvePath(
            opts.bin || process.env.PIPER_BIN || './venv/bin/piper'
        );
        this.model = this._resolvePath(
            opts.model || process.env.PIPER_MODEL || './models/piper/es_ES-davefx-medium.onnx'
        );
        this.config = this._resolvePath(
            opts.config || process.env.PIPER_CONFIG || './models/piper/es_ES-davefx-medium.onnx.json'
        );
        this.outputRate = Number(
            opts.outputRate || process.env.PIPER_OUTPUT_RATE || 22050
        );
        this.logger = opts.logger || {
            log: (...a) => console.log('[PiperTTS]', ...a),
            warn: (...a) => console.warn('[PiperTTS]', ...a),
            error: (...a) => console.error('[PiperTTS]', ...a),
        };
        this.disponible = this._validar();
    }

    _buildSpawnEnv() {
        const env = { ...process.env };
        // Solo el binario nativo (ELF) necesita LD_LIBRARY_PATH y ESPEAK_DATA_PATH.
        // El wrapper Python (venv/bin/piper) no los necesita y pueden interferir.
        if (!this._isNativeBinary()) return env;

        const libDir = resolve(this.projectRoot, 'tools/piper_runtime/piper');
        if (!env.LD_LIBRARY_PATH || !env.LD_LIBRARY_PATH.includes(libDir)) {
            env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
                ? `${libDir}:${env.LD_LIBRARY_PATH}`
                : libDir;
        }
        if (!env.ESPEAK_DATA_PATH) {
            const candidates = [
                '/usr/lib/x86_64-linux-gnu/espeak-ng-data',
                '/usr/share/espeak-ng-data',
            ];
            for (const c of candidates) {
                if (existeArchivo(join(c, 'phontab'), constants.R_OK)) {
                    env.ESPEAK_DATA_PATH = c;
                    break;
                }
            }
        }
        return env;
    }

    _isNativeBinary() {
        let binPath = this.bin;
        // Si es un comando PATH, resolverlo con which
        if (!this.bin.includes('/') && !this.bin.includes('\\')) {
            const result = spawnSync('which', [this.bin], { encoding: 'utf8' });
            if (result.status !== 0) return false;
            binPath = result.stdout.trim();
        }
        try {
            const buf = readFileSync(binPath, { end: 4 });
            return buf.length >= 4 && buf[0] === 0x7f
                && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
        } catch {
            return false;
        }
    }
    _resolvePath(pathValue) {
        if (!pathValue) return pathValue;
        // Si es solo un nombre de comando (sin / ni \), se busca en PATH
        if (!pathValue.includes('/') && !pathValue.includes('\\')) return pathValue;
        return isAbsolute(pathValue) ? pathValue : resolve(this.projectRoot, pathValue);
    }

    _validar() {
        let binToCheck = this.bin;
        if (!this.bin.includes('/') && !this.bin.includes('\\')) {
            const result = spawnSync('which', [this.bin], { encoding: 'utf8' });
            binToCheck = result.status === 0 ? result.stdout.trim() : this.bin;
        }
        const okBin = existeArchivo(binToCheck, constants.X_OK);
        const okModel = existeArchivo(this.model, constants.R_OK);
        if (!okBin || !okModel) {
            this.logger.warn('Piper no disponible. Revisa PIPER_BIN y PIPER_MODEL.');
            if (!okBin) this.logger.warn(`  Binario ausente: ${this.bin}`);
            if (!okModel) this.logger.warn(`  Modelo ausente: ${this.model}`);
            return false;
        }
        if (this.config && !existeArchivo(this.config, constants.R_OK)) {
            this.logger.warn('No se encontró PIPER_CONFIG, se intentará sin config explícita.');
        }
        return true;
    }

    /**
     * Sintetiza texto a audio WAV codificado en base64.
     * @param {string} texto
     * @returns {Promise<string|null>} Audio base64 o null si no disponible/error
     */
    async sintetizarBase64(texto) {
        if (!this.disponible || !texto?.trim()) return null;

        const tempName = `piper-${Date.now()}-${randomUUID()}.wav`;
        const outFile = join(tmpdir(), tempName);

        const args = ['--model', this.model, '--output_file', outFile];
        if (this.config && existeArchivo(this.config, constants.R_OK)) {
            args.push('--config', this.config);
        }
        if (this.outputRate > 0) {
            args.push('--output_sample_rate', String(this.outputRate));
        }

        try {
            await this._runPiper(args, texto);
            const wav = await fs.readFile(outFile);
            return wav.toString('base64');
        } catch (e) {
            this.logger.error('Error sintetizando:', e.message);
            return null;
        } finally {
            try { await fs.unlink(outFile); } catch {}
        }
    }

    _runPiper(args, texto) {
        return new Promise((resolve, reject) => {
            const env = this._buildSpawnEnv();
            const proc = spawn(this.bin, args, { stdio: ['pipe', 'ignore', 'pipe'], env });
            let stderr = '';

            proc.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            proc.on('error', (err) => reject(err));
            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(stderr || `piper terminó con código ${code}`));
            });

            try {
                proc.stdin.write((texto || '').trim() + '\n');
                proc.stdin.end();
            } catch (err) {
                // EPIPE: el proceso terminó antes de poder escribir stdin
                // Dejamos que proc.on('close') maneje el resultado
                if (err.code !== 'EPIPE') reject(err);
            }
        });
    }
}

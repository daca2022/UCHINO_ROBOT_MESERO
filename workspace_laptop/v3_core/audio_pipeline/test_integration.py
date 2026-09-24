import argparse
import logging
import os
import subprocess
import sys
import tempfile
import time

import numpy as np
import soundfile as sf
import torch

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
DURATION = 10.0

def generate_speech(text: str, output_path: str):
    model = "/home/david/chipi_workspace_pln/v3_core/models/piper/es_ES-davefx-medium.onnx"
    config = "/home/david/chipi_workspace_pln/v3_core/models/piper/es_ES-davefx-medium.onnx.json"
    if not os.path.exists(model):
        raise FileNotFoundError(f"Piper model not found: {model}")
    cmd = [
        "piper",
        "--model", model,
        "--config", config,
        "--output_file", output_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stdout, stderr = proc.communicate(input=text)
    if proc.returncode != 0:
        raise RuntimeError(f"Piper failed: {stderr}")
    logger.info("Generated speech: %s", output_path)

def generate_cafe_noise(duration: float, sr: int) -> np.ndarray:
    n_samples = int(duration * sr)
    rng = np.random.default_rng(42)

    # Espresso machine: brown noise + low-frequency pulses
    white = rng.normal(0, 1, n_samples)
    brown = np.cumsum(white)
    brown = brown / np.max(np.abs(brown))
    brown = brown * 0.3

    # Periodic thump (espresso pump)
    t = np.arange(n_samples) / sr
    thump = np.sin(2 * np.pi * 3.5 * t) * (np.sin(2 * np.pi * 0.4 * t) > 0.7)
    thump = thump * 0.4

    # Voices chatter: band-passed noise
    chatter = rng.normal(0, 1, n_samples)
    # Simple moving average as crude low-pass
    window = np.ones(8) / 8
    chatter = np.convolve(chatter, window, mode="same")
    chatter = chatter / np.max(np.abs(chatter))
    chatter = chatter * 0.2

    noise = brown + thump + chatter
    noise = noise / np.max(np.abs(noise))
    return noise.astype(np.float32)

def mix_with_snr(clean: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    clean_power = np.mean(clean ** 2)
    noise_power = np.mean(noise ** 2)
    if noise_power == 0:
        return clean
    scale = np.sqrt(clean_power / (noise_power * (10 ** (snr_db / 10))))
    mixed = clean + noise * scale
    mixed = mixed / np.max(np.abs(mixed))
    return mixed.astype(np.float32)

def run_pipeline_test(noisy_path: str, clean_path: str):
    sys.path.insert(0, "/home/david/chipi_workspace_pln/v3_core")
    from audio_pipeline import DeepFilterNet3Suppressor, SERBranch

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    logger.info("Loading models...")
    df = DeepFilterNet3Suppressor()
    ser = SERBranch()
    logger.info("Models loaded")

    audio, sr = sf.read(noisy_path, dtype="float32")
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sr != SAMPLE_RATE:
        import torchaudio.functional as F
        t = torch.from_numpy(audio).unsqueeze(0)
        t = F.resample(t, sr, SAMPLE_RATE)
        audio = t.squeeze(0).numpy()

    logger.info("Running DeepFilterNet3 on %d samples...", len(audio))
    t0 = time.monotonic()
    clean = df.process(audio, SAMPLE_RATE)
    t1 = time.monotonic()
    logger.info("DeepFilterNet3 done in %.3fs (RTF=%.3f)", t1 - t0, (t1 - t0) / (len(audio) / SAMPLE_RATE))

    sf.write(clean_path, clean, SAMPLE_RATE)
    logger.info("Wrote cleaned audio to %s", clean_path)

    logger.info("Running SER on cleaned audio...")
    emotion = ser.process(clean, SAMPLE_RATE)
    logger.info("SER result: %s", emotion)

    vram_df = df.vram_mb
    vram_ser = ser.vram_mb
    vram_total = torch.cuda.memory_allocated() / 1e6
    vram_peak = torch.cuda.max_memory_allocated() / 1e6
    logger.info("VRAM DF: %.1f MB", vram_df)
    logger.info("VRAM SER: %.1f MB", vram_ser)
    logger.info("VRAM total allocated: %.1f MB", vram_total)
    logger.info("VRAM peak allocated: %.1f MB", vram_peak)

    return {
        "df_rtf": (t1 - t0) / (len(audio) / SAMPLE_RATE),
        "vram_df_mb": vram_df,
        "vram_ser_mb": vram_ser,
        "vram_total_mb": vram_total,
        "vram_peak_mb": vram_peak,
        "emotion": emotion,
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", default="/tmp/chipi_audio_test")
    parser.add_argument("--snr", type=float, default=5.0)
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    speech_path = os.path.join(args.out_dir, "speech.wav")
    noisy_path = os.path.join(args.out_dir, "noisy_cafe.wav")
    clean_path = os.path.join(args.out_dir, "cleaned.wav")

    text = "Hola, soy Uchino, el robot mesero del restaurante UTEC. Me gustaría tomar su pedido de bebidas y postres."
    generate_speech(text, speech_path)

    speech, sr = sf.read(speech_path, dtype="float32")
    if speech.ndim > 1:
        speech = np.mean(speech, axis=1)
    if sr != SAMPLE_RATE:
        import torchaudio.functional as F
        t = torch.from_numpy(speech).unsqueeze(0)
        t = F.resample(t, sr, SAMPLE_RATE)
        speech = t.squeeze(0).numpy()

    # Pad or truncate to exact duration
    target_samples = int(DURATION * SAMPLE_RATE)
    if len(speech) < target_samples:
        speech = np.pad(speech, (0, target_samples - len(speech)))
    else:
        speech = speech[:target_samples]

    noise = generate_cafe_noise(DURATION, SAMPLE_RATE)
    noisy = mix_with_snr(speech, noise, args.snr)
    sf.write(noisy_path, noisy, SAMPLE_RATE)
    logger.info("Wrote noisy audio to %s (SNR=%.1f dB)", noisy_path, args.snr)

    result = run_pipeline_test(noisy_path, clean_path)
    logger.info("Integration test result: %s", result)

    peak_gb = result["vram_peak_mb"] / 1024
    if peak_gb > 7.5:
        logger.error("VRAM EXCEEDS BUDGET: %.2f GB > 7.5 GB", peak_gb)
        sys.exit(1)
    else:
        logger.info("VRAM within budget: %.2f GB <= 7.5 GB", peak_gb)

if __name__ == "__main__":
    main()

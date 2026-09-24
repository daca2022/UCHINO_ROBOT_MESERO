"""
DeepFilterNet3 Noise Suppression Wrapper
Monkeys-patch torchaudio.backend to work with torchaudio >= 2.11.
"""
import sys
from types import ModuleType
import logging

logger = logging.getLogger(__name__)

# ── Monkey-patch torchaudio.backend for DeepFilterNet3 compatibility ──
if "torchaudio.backend" not in sys.modules:
    fake_backend = ModuleType("torchaudio.backend")
    fake_common = ModuleType("torchaudio.backend.common")

    class _DummyAudioMetaData:
        def __init__(self, sample_rate=0, num_frames=0, num_channels=0, bits_per_sample=0, encoding=""):
            self.sample_rate = sample_rate
            self.num_frames = num_frames
            self.num_channels = num_channels
            self.bits_per_sample = bits_per_sample
            self.encoding = encoding

    fake_common.AudioMetaData = _DummyAudioMetaData
    fake_backend.common = fake_common
    sys.modules["torchaudio.backend"] = fake_backend
    sys.modules["torchaudio.backend.common"] = fake_common

import numpy as np
import torch
from df import enhance, init_df


class DeepFilterNet3Suppressor:
    """
    Wrapper around DeepFilterNet3 for real-time noise suppression.
    Expects float32 numpy arrays in range [-1, 1].
    """

    _instance = None
    _lock = False

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self, device: str = "cuda" if torch.cuda.is_available() else "cpu"):
        if self._lock:
            return
        self.device = device
        logger.info(f"[DeepFilterNet3] Initializing on {self.device} ...")
        self.model, self.df_state, _ = init_df()
        self.model = self.model.to(self.device)
        self.model.eval()
        self.sample_rate = self.df_state.sr()
        self._lock = True
        logger.info(f"[DeepFilterNet3] Ready (sr={self.sample_rate})")

    def process(self, audio: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
        """
        Suppress noise in a mono audio chunk.

        Args:
            audio: 1-D float32 numpy array in range [-1, 1].
            sample_rate: Input sample rate (will be resampled to DF sr if needed).

        Returns:
            Cleaned 1-D float32 numpy array at *input* sample_rate.
        """
        if audio.ndim != 1:
            raise ValueError("audio must be 1-D mono")

        # Resample to DF sample rate if needed
        needs_resample = sample_rate != self.sample_rate
        if needs_resample:
            import torchaudio.functional as F
            t = torch.from_numpy(audio).unsqueeze(0)
            t = F.resample(t, sample_rate, self.sample_rate)
            audio = t.squeeze(0).numpy()

        # DeepFilterNet3 expects shape (batch, channels, samples)
        tensor = torch.from_numpy(audio).unsqueeze(0)

        with torch.no_grad():
            enhanced = enhance(self.model, self.df_state, tensor)

        clean = enhanced.squeeze().cpu().numpy()

        # Resample back to original rate if needed
        if needs_resample:
            import torchaudio.functional as F
            t = torch.from_numpy(clean).unsqueeze(0)
            t = F.resample(t, self.sample_rate, sample_rate)
            clean = t.squeeze(0).numpy()

        return clean.astype(np.float32)

    def process_bytes(self, pcm16: bytes, sample_rate: int = 16000) -> bytes:
        """
        Convenience wrapper for raw PCM16 bytes.
        """
        arr = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
        clean = self.process(arr, sample_rate)
        clean_int16 = np.clip(clean * 32768.0, -32768, 32767).astype(np.int16)
        return clean_int16.tobytes()

    @property
    def vram_mb(self) -> float:
        if self.device == "cuda" and torch.cuda.is_available():
            return torch.cuda.memory_allocated() / 1e6
        return 0.0

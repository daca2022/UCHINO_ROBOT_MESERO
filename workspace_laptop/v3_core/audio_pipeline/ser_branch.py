"""
Speech Emotion Recognition (SER) parallel branch.
Uses Wav2Vec2-XLSR via SpeechBrain for multilingual emotion classification.
"""
import logging
from typing import Dict, Optional

import numpy as np
import torch

logger = logging.getLogger(__name__)


class SERBranch:
    """
    Parallel emotion recognition branch using Wav2Vec2-XLSR.
    Runs asynchronously on buffered audio segments.
    """

    _instance = None
    _lock = False

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(
        self,
        source: str = "speechbrain/emotion-recognition-wav2vec2-IEMOCAP",
        device: str = "cuda" if torch.cuda.is_available() else "cpu",
    ):
        if self._lock:
            return
        self.device = device
        self.source = source
        logger.info(f"[SER] Loading model from {source} on {device} ...")
        try:
            from speechbrain.inference import EncoderClassifier
            self.classifier = EncoderClassifier.from_hparams(
                source=source,
                run_opts={"device": device},
                savedir=f"~/.cache/speechbrain/{source.replace('/', '_')}",
            )
            self.classifier.eval()
            self.labels = self.classifier.hparams.label_encoder.decode_ndim(
                range(len(self.classifier.hparams.label_encoder))
            )
            logger.info(f"[SER] Loaded. Labels: {self.labels}")
        except Exception as e:
            logger.error(f"[SER] Failed to load model: {e}")
            self.classifier = None
            self.labels = []
        self._lock = True

    def process(self, audio: np.ndarray, sample_rate: int = 16000) -> Optional[Dict]:
        """
        Classify emotion from a mono audio segment.

        Args:
            audio: 1-D float32 numpy array in range [-1, 1].
            sample_rate: Sample rate of the audio.

        Returns:
            Dict with top emotion, scores, and probabilities, or None on failure.
        """
        if self.classifier is None:
            return None
        if audio.ndim != 1:
            raise ValueError("audio must be 1-D mono")
        if len(audio) < sample_rate * 0.5:
            # Too short for reliable classification
            return None

        tensor = torch.from_numpy(audio).unsqueeze(0).to(self.device)

        with torch.no_grad():
            try:
                # Use HF model directly (SpeechBrain 1.1+ removed encode_batch API)
                w2v2_model = self.classifier.mods.wav2vec2.model
                feats = w2v2_model(tensor).last_hidden_state
                pooled = self.classifier.mods.avg_pool(feats)
                logits = self.classifier.mods.output_mlp(pooled)
                probs = torch.softmax(logits, dim=-1).squeeze().cpu().numpy()
            except Exception as e:
                logger.warning(f"[SER] Inference failed: {e}")
                return None

        if probs.ndim == 0:
            return None

        top_idx = int(np.argmax(probs))
        result = {
            "emotion": self.labels[top_idx] if top_idx < len(self.labels) else str(top_idx),
            "confidence": float(probs[top_idx]),
            "scores": {
                (self.labels[i] if i < len(self.labels) else str(i)): float(probs[i])
                for i in range(len(probs))
            },
        }
        return result

    def process_bytes(self, pcm16: bytes, sample_rate: int = 16000) -> Optional[Dict]:
        """Convenience wrapper for raw PCM16 bytes."""
        arr = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
        return self.process(arr, sample_rate)

    @property
    def vram_mb(self) -> float:
        if self.device == "cuda" and torch.cuda.is_available():
            return torch.cuda.memory_allocated() / 1e6
        return 0.0

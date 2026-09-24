"""Auron RVC voice conversion module.
Post-processes Kokoro TTS output through Auron's trained voice model.
Pipeline: Kokoro (24kHz WAV) → resample 16kHz → Hubert features → F0 (harvest) → RVC generator → output WAV."""
import os, logging, time
import numpy as np
import torch
import pyworld as pw
import faiss

from tts.rvc_lib import hubert_loader
from tts.rvc_lib.models import SynthesizerTrnMs768NSFsid

logger = logging.getLogger(__name__)

AURON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'AuronV2')
HUBERT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'models', 'hubert')


class AuronVoice:
    def __init__(self, device=None, is_half=False):
        self.device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
        self.is_half = is_half and self.device != 'cpu'
        self._hubert = None
        self._generator = None
        self._index = None
        self._big_npy = None
        self.index_rate = 0.6
        self.tgt_sr = 40000
        self.f0_up_key = 0
        self.formant_shift = 0
        self.net_g = None
        
        pth_path = os.path.join(AURON_DIR, 'Auron.pth')
        index_path = os.path.join(AURON_DIR, 'added_IVF608_Flat_nprobe_1_Auron_v2.index')
        
        if os.path.exists(pth_path):
            self._load_generator(pth_path)
        else:
            logger.warning(f'Auron model not found at {pth_path}')
        
        if self.index_rate > 0 and os.path.exists(index_path):
            self._load_index(index_path)
        
        logger.info(f'AuronVoice initialized on {self.device}')
    
    def _load_generator(self, pth_path):
        _safe_load = torch.load
        def _patched_load(f, *a, **kw):
            kw.setdefault('weights_only', False)
            return _safe_load(f, *a, **kw)
        torch.load = _patched_load
        cpt = torch.load(pth_path, map_location='cpu')
        torch.load = _safe_load
        config = cpt['config']
        config[-3] = cpt['weight']['emb_g.weight'].shape[0]
        
        self.net_g = SynthesizerTrnMs768NSFsid(*config, is_half=False)
        self.net_g.load_state_dict(cpt['weight'], strict=False)
        self.net_g = self.net_g.float().to(self.device)
        self.net_g.eval()
        self.net_g.remove_weight_norm()
        del self.net_g.enc_q
        
        self.tgt_sr = config[-1]
        self.if_f0 = cpt.get('f0', 1)
        logger.info(f'Generator loaded: {self.tgt_sr}Hz, f0={self.if_f0}')
    
    def _load_index(self, index_path):
        self._index = faiss.read_index(index_path)
        self._big_npy = self._index.reconstruct_n(0, self._index.ntotal)
        logger.info(f'FAISS index loaded: {self._index.ntotal} vectors')
    
    def _ensure_hubert(self):
        if self._hubert is not None:
            return self._hubert
        self._hubert = hubert_loader.get_hubert_model(device=self.device, is_half=self.is_half)
        return self._hubert
    
    def _get_f0(self, audio, sr):
        f0, t = pw.harvest(audio.astype(np.float64), fs=sr, f0_floor=50, f0_ceil=1100, frame_period=5.12)
        f0 = pw.stonemask(audio.astype(np.float64), f0, t, sr)
        return f0.astype(np.float32)
    
    def _f0_to_coarse(self, f0):
        f0_mel_min = 1127 * np.log(1 + 50.0 / 700)
        f0_mel_max = 1127 * np.log(1 + 1100.0 / 700)
        f0 = np.clip(f0, 50, 1100)
        f0_mel = 1127 * np.log(1 + f0 / 700)
        f0_mel = np.clip(f0_mel, f0_mel_min, f0_mel_max)
        f0_coarse = np.round((f0_mel - f0_mel_min) * 254 / (f0_mel_max - f0_mel_min) + 1)
        f0_coarse = np.clip(f0_coarse, 1, 255).astype(np.int64)
        return f0_coarse, f0
    
    @staticmethod
    def _resample(audio, orig_sr, target_sr):
        if orig_sr == target_sr:
            return audio
        num = int(np.round(len(audio) * target_sr / orig_sr))
        x_old = np.linspace(0, 1, len(audio))
        x_new = np.linspace(0, 1, num)
        return np.interp(x_new, x_old, audio.astype(np.float64)).astype(np.float32)
    
    def convert(self, audio, sr):
        if not hasattr(self, 'net_g') or self.net_g is None:
            logger.warning('Auron generator not loaded, returning original audio')
            return audio
        
        model = self._ensure_hubert()
        t0 = time.time()
        
        audio_16k = self._resample(audio, sr, 16000)
        
        feats = hubert_loader.extract_features(model, audio_16k, device=self.device, output_layer=12, is_half=self.is_half)
        feats = torch.from_numpy(feats).unsqueeze(0).to(self.device)
        feats = torch.cat((feats, feats[:, -1:, :]), 1)
        t1 = time.time()
        
        if self._index is not None and self.index_rate > 0:
            npy = feats[0].cpu().numpy().astype('float32')
            score, ix = self._index.search(npy, k=8)
            if (ix >= 0).all():
                weight = np.square(1 / score)
                weight /= weight.sum(axis=1, keepdims=True)
                matched = np.sum(self._big_npy[ix] * np.expand_dims(weight, axis=2), axis=1)
                feats[0] = torch.from_numpy(matched).to(self.device) * self.index_rate + feats[0] * (1 - self.index_rate)
        t2 = time.time()
        
        factor = pow(2, self.formant_shift / 12)
        p_len = audio_16k.shape[0] // 160
        
        f0 = self._get_f0(audio_16k, 16000)
        f0 = f0[:p_len]
        if len(f0) < p_len:
            f0 = np.pad(f0, (0, p_len - len(f0)))
        
        f0_coarse, f0_cont = self._f0_to_coarse(f0)
        f0_coarse = torch.from_numpy(f0_coarse).to(self.device).long()
        f0_cont = torch.from_numpy(f0_cont).to(self.device).float()
        t3 = time.time()
        
        sid = torch.LongTensor([0]).to(self.device)
        p_len_t = torch.LongTensor([p_len]).to(self.device)
        skip_head = torch.LongTensor([0]).to(self.device)
        expected_out = int(len(audio) * self.tgt_sr / sr)
        dec_ratio = self.tgt_sr // 100
        n_res = int(np.ceil(expected_out / dec_ratio))
        return_length = torch.LongTensor([n_res]).to(self.device)
        return_length2 = torch.LongTensor([int(np.ceil(n_res * factor))]).to(self.device)
        
        feats = torch.nn.functional.interpolate(feats.permute(0, 2, 1), scale_factor=2).permute(0, 2, 1)
        feats = feats[:, :p_len, :]
        
        with torch.no_grad():
            audio_result, _, _ = self.net_g.infer(
                feats, p_len_t,
                f0_coarse.unsqueeze(0),
                f0_cont.unsqueeze(0),
                sid,
                skip_head, return_length, return_length2,
            )
        
        audio_result = audio_result.squeeze(0).squeeze(0).float().cpu().numpy()
        t4 = time.time()
        
        logger.debug(f'Auron: hubert={t1-t0:.3f}s index={t2-t1:.3f}s f0={t3-t2:.3f}s gen={t4-t3:.3f}s')
        
        if len(audio_result) > expected_out:
            audio_result = audio_result[:expected_out]
        elif len(audio_result) < expected_out:
            audio_result = np.pad(audio_result, (0, expected_out - len(audio_result)))
        
        if self.tgt_sr != sr:
            audio_result = self._resample(audio_result, self.tgt_sr, sr)
        
        return audio_result.astype(np.float32)

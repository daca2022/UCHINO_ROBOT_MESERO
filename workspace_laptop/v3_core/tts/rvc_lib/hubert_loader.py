"""Hubert model loader for RVC content feature extraction.
Requires monkey-patch from rvc_lib.__init__ to be applied first."""
import os
import torch
import torch.serialization
import fairseq
from fairseq.checkpoint_utils import load_model_ensemble_and_task

_HUBERT_CACHE = None

def get_hubert_model(device='cpu', is_half=False):
    global _HUBERT_CACHE
    if _HUBERT_CACHE is not None:
        return _HUBERT_CACHE
    
    model_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        'models', 'hubert', 'hubert_base.pt'
    )
    
    _safe_load = torch.load
    def _patched_load(f, *a, **kw):
        kw.setdefault('weights_only', False)
        return _safe_load(f, *a, **kw)
    torch.load = _patched_load
    
    models, _, _ = load_model_ensemble_and_task([model_path], suffix='')
    torch.load = _safe_load
    
    model = models[0]
    model = model.to(device)
    model = model.half() if is_half else model.float()
    model.eval()
    _HUBERT_CACHE = model
    return model


def extract_features(hubert_model, audio_16khz, device='cpu', output_layer=12, is_half=False):
    if isinstance(audio_16khz, torch.Tensor):
        feats = audio_16khz
    else:
        feats = torch.from_numpy(audio_16khz).float()
    
    if feats.dim() == 1:
        feats = feats.unsqueeze(0)
    feats = feats.to(device)
    if is_half:
        feats = feats.half()
    
    with torch.no_grad():
        padding_mask = torch.BoolTensor(feats.shape).to(device).fill_(False)
        inputs = {'source': feats, 'padding_mask': padding_mask, 'output_layer': output_layer}
        logits = hubert_model.extract_features(**inputs)
        features = logits[0]
    
    return features[0].cpu().numpy()

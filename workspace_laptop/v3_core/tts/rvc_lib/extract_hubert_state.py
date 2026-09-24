"""Extract clean Hubert state dict from fairseq checkpoint.

This runs BEFORE any fairseq/hydra import to monkey-patch Python 3.12 dataclass behavior.
Output: hubert_state.pt - a clean state dict loadable without fairseq.
"""
import dataclasses
import sys

original_get_field = dataclasses._get_field

def _patched_get_field(cls, name, type_, kw_only=False):
    try:
        return original_get_field(cls, name, type_, kw_only)
    except ValueError as e:
        if 'mutable default' in str(e):
            f_type = cls.__annotations__.get(name) if hasattr(cls, '__annotations__') else None
            if f_type is not None and type(f_type) is type:
                new_f = dataclasses.field(default_factory=lambda t=f_type: t())
            else:
                new_f = dataclasses.field(default_factory=lambda: None)
            new_f.name = name
            new_f.type = type_
            new_f._field_type = dataclasses._FIELD
            return new_f
        raise

dataclasses._get_field = _patched_get_field

import torch
import os

# PyTorch 2.6+ defaults to weights_only=True; fairseq checkpoints use custom classes
import torch.serialization
_safe_load = torch.load
def _patched_load(f, *a, **kw):
    kw.setdefault('weights_only', False)
    return _safe_load(f, *a, **kw)
torch.load = _patched_load

def extract_state_dict(ckpt_path, output_path):
    """Load fairseq Hubert checkpoint and save only the state dict."""
    # Import fairseq lazily (after monkey-patch is in effect)
    from fairseq.checkpoint_utils import load_model_ensemble_and_task
    
    models, _, _ = load_model_ensemble_and_task([ckpt_path], suffix='')
    model = models[0]
    model.eval()
    
    state_dict = model.state_dict()
    # Convert to CPU
    clean = {k: v.cpu().clone() for k, v in state_dict.items()}
    
    # Save config
    config = {
        'hidden_size': model.cfg.encoder_embed_dim if hasattr(model, 'cfg') else 768,
        'num_hidden_layers': model.cfg.encoder_layers if hasattr(model, 'cfg') else 12,
        'num_attention_heads': model.cfg.encoder_attention_heads if hasattr(model, 'cfg') else 12,
        'intermediate_size': model.cfg.encoder_ffn_embed_dim if hasattr(model, 'cfg') else 3072,
    }
    
    torch.save({'state_dict': clean, 'config': config}, output_path)
    print(f'Extracted state dict to {output_path}')
    print(f'  Keys: {len(clean)}')
    print(f'  Config: {config}')

if __name__ == '__main__':
    ckpt = sys.argv[1] if len(sys.argv) > 1 else '/home/david/chipi_workspace_pln/v3_core/models/hubert/hubert_base.pt'
    out = sys.argv[2] if len(sys.argv) > 2 else '/home/david/chipi_workspace_pln/v3_core/models/hubert/hubert_state.pt'
    extract_state_dict(ckpt, out)

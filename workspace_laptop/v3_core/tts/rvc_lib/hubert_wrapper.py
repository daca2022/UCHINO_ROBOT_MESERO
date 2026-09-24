"""Hubert content feature encoder for RVC inference.

Loads the fairseq Hubert model from the extracted state dict
and provides feature extraction without fairseq dependency.
"""
import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np


class ConvFeatureEncoder(nn.Module):
    def __init__(self, state_dict):
        super().__init__()
        # Feature encoder: 7 conv layers
        # Layer 0: (512, 1, 10), stride 5
        # Layer 1-4: (512, 3, 2) each, stride 2
        # Layer 5-6: (512, 2, 2) each, stride 2
        self.conv_layers = nn.ModuleList()
        in_channels = 1
        conv_cfg = [(512, 10, 5)] + [(512, 3, 2)] * 4 + [(512, 2, 2)] * 2
        for i, (out_c, k, s) in enumerate(conv_cfg):
            conv = nn.Conv1d(in_channels, out_c, kernel_size=k, stride=s, bias=False)
            layer_norm = nn.LayerNorm(out_c)
            in_channels = out_c
            self.conv_layers.append(nn.Sequential(
                conv, nn.Sequential(), layer_norm, nn.GELU()
            ))
        self.load_state_dict(state_dict)

    def forward(self, x):
        # x: B x T (audio waveform)
        x = x.unsqueeze(1)  # B x 1 x T
        for layer in self.conv_layers:
            x = layer(x)
        x = x.transpose(1, 2)  # B x T x C
        return x


class HubertContentEncoder(nn.Module):
    """Lightweight Hubert encoder using extracted state dict.
    
    Only the parts needed for RVC feature extraction:
    - Feature encoder (conv layers)
    - Positional convolution
    - Transformer encoder (12 layers, 768 dim)
    No mask, no final projection, no clustering heads.
    """
    def __init__(self, state_dict, config):
        super().__init__()
        self.config = config
        hidden_size = config.get('hidden_size', 768)
        num_layers = config.get('num_hidden_layers', 12)
        num_heads = config.get('num_attention_heads', 12)
        intermediate_size = config.get('intermediate_size', 3072)

        # Feature encoder
        feat_enc_state = {}
        for k, v in list(state_dict.items()):
            if k.startswith('feature_extractor.'):
                feat_enc_state[k.replace('feature_extractor.', '')] = v
                state_dict.pop(k)
        
        # Extract conv layer weights from the state dict
        # The fairseq ConvFeatureExtractionModel uses:
        # conv_layers.0.0.weight, conv_layers.0.2.weight, conv_layers.0.2.bias
        # conv_layers.1.0.weight, conv_layers.1.2.weight, conv_layers.1.2.bias
        # etc.
        self.feature_extractor = self._build_feature_extractor(feat_enc_state)
        
        # Layer norm (post feature extractor)
        self.layer_norm = nn.LayerNorm(512)
        ln_w = state_dict.pop('layer_norm.weight')
        ln_b = state_dict.pop('layer_norm.bias')
        self.layer_norm.weight.data.copy_(ln_w)
        self.layer_norm.bias.data.copy_(ln_b)
        
        # Post extract projection: 512 -> 768
        self.post_extract_proj = nn.Linear(512, hidden_size)
        pe_w = state_dict.pop('post_extract_proj.weight')
        pe_b = state_dict.pop('post_extract_proj.bias')
        self.post_extract_proj.weight.data.copy_(pe_w)
        self.post_extract_proj.bias.data.copy_(pe_b)
        
        # Positional convolution (weight_normed)
        self.pos_conv = self._build_pos_conv(state_dict)
        
        # Transformer encoder
        self.encoder = TransformerEncoder(
            hidden_size, num_layers, num_heads, intermediate_size, state_dict
        )
        
        self.encoder.layer_norm = nn.LayerNorm(hidden_size)
        en_w = state_dict.pop('encoder.layer_norm.weight')
        en_b = state_dict.pop('encoder.layer_norm.bias')
        self.encoder.layer_norm.weight.data.copy_(en_w)
        self.encoder.layer_norm.bias.data.copy_(en_b)
        
        # Remove unused keys
        for key in ['mask_emb', 'label_embs_concat', 'final_proj.weight', 'final_proj.bias']:
            state_dict.pop(key, None)
        
        # Verify no keys left
        assert len(state_dict) == 0, f"Unused state dict keys: {list(state_dict.keys())}"

    def _build_feature_extractor(self, state_dict):
        layers = nn.ModuleList()
        for i in range(7):
            conv_w = state_dict.pop(f'conv_layers.{i}.0.weight')
            ln_w = state_dict.pop(f'conv_layers.{i}.2.weight')
            ln_b = state_dict.pop(f'conv_layers.{i}.2.bias')
            out_c = conv_w.shape[0]
            k_size = conv_w.shape[2]
            stride = conv_w.shape[3] if conv_w.dim() == 4 else 1
            # Determine stride from config
            if i == 0:
                stride = 5
            elif i <= 4:
                stride = 2
            else:
                stride = 2
            
            conv = nn.Conv1d(1 if i == 0 else 512, out_c, k_size, stride=stride, bias=False)
            conv.weight.data.copy_(conv_w.squeeze(1))  # fairseq stores as (C_out, 1, k) but nn.Conv1d expects (C_out, in_c, k)
            
            ln = nn.LayerNorm(out_c)
            ln.weight.data.copy_(ln_w)
            ln.bias.data.copy_(ln_b)
            
            act = nn.GELU()
            layers.append(nn.Sequential(conv, nn.Identity(), ln, act))
        return layers

    def _build_pos_conv(self, state_dict):
        # Weight-normed Conv1d: 768 -> 768, kernel=128, groups=16
        # Fairseq stores as weight_g, weight_v
        w_g = state_dict.pop('encoder.pos_conv.0.weight_g')
        w_v = state_dict.pop('encoder.pos_conv.0.weight_v')
        bias = state_dict.pop('encoder.pos_conv.0.bias')
        
        conv = nn.Conv1d(768, 768, kernel_size=128, groups=16, padding=64, bias=True)
        # weight_norm in fairseq stores (out, in/groups, k) as (g * v/||v||)
        # w_g: (768, 1, 128) -> squeeze to (768,)  (per output channel)
        # w_v: (768, 48, 128) -> reshape properly
        # Actually fairseq uses torch.nn.utils.weight_norm which is different
        # Let's just use the weight_norm API directly
        conv = nn.utils.weight_norm(conv, name='weight', dim=0)
        conv.weight_g.data.copy_(w_g.squeeze())
        conv.weight_v.data.copy_(w_v)
        conv.bias.data.copy_(bias)
        return conv

    def forward(self, source, output_layer=12):
        """Extract features from audio waveform.
        
        Args:
            source: audio waveform (B, T) float32
            output_layer: which transformer layer to output (1-12)
        Returns:
            features: (B, T', 768) tensor
        """
        # Feature encoder
        x = source.unsqueeze(1)  # B x 1 x T
        for i, layer in enumerate(self.feature_extractor):
            x = layer[0](x)  # conv
            # layer_norm expects (B, T, C)
            x = x.transpose(1, 2)
            x = layer[2](x)  # layer_norm
            x = x.transpose(1, 2)
            x = layer[3](x)  # GELU
        
        x = x.transpose(1, 2)  # B x T x C
        x = self.layer_norm(x)  # B x T x 512
        x = self.post_extract_proj(x)  # B x T x 768
        
        # Positional convolution
        x_conv = x.transpose(1, 2)  # B x 768 x T
        x_conv = self.pos_conv(x_conv)
        x_conv = x_conv.transpose(1, 2)  # B x T x 768
        x = x + x_conv
        
        # Transformer encoder up to specified layer
        x = self.encoder(x, output_layer=output_layer)
        return x


class TransformerEncoder(nn.Module):
    def __init__(self, hidden_size, num_layers, num_heads, intermediate_size, state_dict):
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.num_heads = num_heads
        
        self.layers = nn.ModuleList()
        for i in range(num_layers):
            layer = TransformerEncoderLayer(hidden_size, num_heads, intermediate_size)
            # Load state dict for this layer
            layer_state = {}
            for k in list(state_dict.keys()):
                if k.startswith(f'encoder.layers.{i}.'):
                    layer_state[k.replace(f'encoder.layers.{i}.', '')] = state_dict.pop(k)
            layer.load_state_dict(layer_state)
            self.layers.append(layer)

    def forward(self, x, output_layer=None):
        if output_layer is None:
            output_layer = self.num_layers
        
        for i, layer in enumerate(self.layers):
            x = layer(x)
            if i + 1 == output_layer:
                break
        
        return x


class TransformerEncoderLayer(nn.Module):
    def __init__(self, hidden_size, num_heads, intermediate_size, dropout=0.1):
        super().__init__()
        self.self_attn = nn.MultiheadAttention(hidden_size, num_heads, dropout=dropout, batch_first=True)
        self.fc1 = nn.Linear(hidden_size, intermediate_size)
        self.fc2 = nn.Linear(intermediate_size, hidden_size)
        self.layer_norm1 = nn.LayerNorm(hidden_size)
        self.layer_norm2 = nn.LayerNorm(hidden_size)
        self.dropout = nn.Dropout(dropout)
        self.activation = nn.GELU()
    
    def forward(self, x):
        # Self-attention with residual
        residual = x
        x = self.layer_norm1(x)
        x, _ = self.self_attn(x, x, x, need_weights=False)
        x = self.dropout(x)
        x = residual + x
        
        # FFN with residual
        residual = x
        x = self.layer_norm2(x)
        x = self.fc1(x)
        x = self.activation(x)
        x = self.dropout(x)
        x = self.fc2(x)
        x = self.dropout(x)
        x = residual + x
        
        return x


def load_hubert_encoder(model_path, device='cpu', half=False):
    """Load the Hubert content encoder from extracted state dict."""
    data = torch.load(model_path, map_location='cpu', weights_only=False)
    config = data['config']
    state = data['state_dict']
    
    model = HubertContentEncoder(state, config)
    model = model.to(device)
    if half:
        model = model.half()
    model.eval()
    return model


def extract_hubert_features(model, audio_16khz, device='cpu', output_layer=12):
    """Extract Hubert features from 16kHz audio.
    
    Args:
        model: HubertContentEncoder
        audio_16khz: (T,) numpy array, 16kHz
        device: torch device
        output_layer: which transformer layer (12 for RVC v2)
    Returns:
        features: (T', 768) numpy array at 50Hz framerate
    """
    if isinstance(audio_16khz, np.ndarray):
        audio_16khz = torch.from_numpy(audio_16khz).float()
    if audio_16khz.dim() == 1:
        audio_16khz = audio_16khz.unsqueeze(0)
    
    audio_16khz = audio_16khz.to(device)
    
    with torch.no_grad():
        features = model(audio_16khz, output_layer=output_layer)
    
    return features[0].cpu().numpy()

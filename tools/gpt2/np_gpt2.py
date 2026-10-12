# Reference fp32 GPT-2 small forward pass in numpy from the Keras-NLP h5 weights.
import h5py, numpy as np, json
from tokenizers import ByteLevelBPETokenizer

import os
GPT2_DIR = os.environ.get('GPT2_DIR', 'gpt2')  # model.h5, vocab.json, merges.txt from storage.googleapis.com/keras-nlp/models/gpt2_base_en/v1/
H5 = os.path.join(GPT2_DIR, 'model.h5')
_tok = None
def tokenizer():
    global _tok
    if _tok is None:
        _tok = ByteLevelBPETokenizer(os.path.join(GPT2_DIR, 'vocab.json'), os.path.join(GPT2_DIR, 'merges.txt'), add_prefix_space=False)
    return _tok

def load_weights():
    f = h5py.File(H5, 'r')
    g = lambda k: np.array(f[k], dtype=np.float32)
    W = {'wte': g('token_embedding/token_embedding/embeddings:0'),
         'wpe': g('position_embedding/position_embedding/embeddings:0'),
         'lnf_g': g('layer_norm/layer_norm/gamma:0'), 'lnf_b': g('layer_norm/layer_norm/beta:0'), 'layers': []}
    for i in range(12):
        p = f'transformer_layer_{i}/transformer_layer_{i}/'
        a = p + 'multi_head_attention/'
        L = {
            'ln1_g': g(p+'layer_normalization/gamma:0'), 'ln1_b': g(p+'layer_normalization/beta:0'),
            'ln2_g': g(p+'layer_normalization_1/gamma:0'), 'ln2_b': g(p+'layer_normalization_1/beta:0'),
            'wq': g(a+'query/kernel:0').reshape(768, 768), 'bq': g(a+'query/bias:0').reshape(768),
            'wk': g(a+'key/kernel:0').reshape(768, 768), 'bk': g(a+'key/bias:0').reshape(768),
            'wv': g(a+'value/kernel:0').reshape(768, 768), 'bv': g(a+'value/bias:0').reshape(768),
            'wo': g(a+'attention_output/kernel:0').reshape(768, 768), 'bo': g(a+'attention_output/bias:0'),
            'wfc': g(p+'dense/kernel:0'), 'bfc': g(p+'dense/bias:0'),
            'wpr': g(p+'dense_1/kernel:0'), 'bpr': g(p+'dense_1/bias:0'),
        }
        W['layers'].append(L)
    return W

def ln(x, g, b, eps=1e-5):
    m = x.mean(-1, keepdims=True); v = ((x - m) ** 2).mean(-1, keepdims=True)
    return (x - m) / np.sqrt(v + eps) * g + b

def gelu(x):
    return 0.5 * x * (1 + np.tanh(np.sqrt(2 / np.pi) * (x + 0.044715 * x ** 3)))

def forward(W, ids):
    T = len(ids)
    x = W['wte'][ids] + W['wpe'][:T]
    mask = np.triu(np.full((T, T), -1e9, dtype=np.float32), 1)
    for L in W['layers']:
        h = ln(x, L['ln1_g'], L['ln1_b'])
        q = (h @ L['wq'] + L['bq']).reshape(T, 12, 64).transpose(1, 0, 2)
        k = (h @ L['wk'] + L['bk']).reshape(T, 12, 64).transpose(1, 0, 2)
        v = (h @ L['wv'] + L['bv']).reshape(T, 12, 64).transpose(1, 0, 2)
        s = q @ k.transpose(0, 2, 1) / 8.0 + mask
        s = np.exp(s - s.max(-1, keepdims=True)); s /= s.sum(-1, keepdims=True)
        o = (s @ v).transpose(1, 0, 2).reshape(T, 768)
        x = x + o @ L['wo'] + L['bo']
        h = ln(x, L['ln2_g'], L['ln2_b'])
        x = x + gelu(h @ L['wfc'] + L['bfc']) @ L['wpr'] + L['bpr']
    x = ln(x, W['lnf_g'], W['lnf_b'])
    return x @ W['wte'].T  # tied LM head -> logits [T, V]

def log_softmax(z):
    z = z - z.max(-1, keepdims=True)
    return z - np.log(np.exp(z).sum(-1, keepdims=True))

"""Build a GPT-2 small ONNX graph that outputs per-token detector statistics.

Inputs : input_ids int64 [1, T]
Outputs: stats  float32 [T-1, 4] = (log p(next token), rank of next token, E_p[log p], E_p[(log p)^2])
         top_ids int64 [T-1, K], top_logp float32 [T-1, K]   (the model's own top-K guesses)
Weights come from the Keras-NLP GPT-2 small checkpoint (OpenAI GPT-2 124M).
mode: 'fp32' (498 MB), or 'dq21' (141 MB: int8 blocks of 16 for the embedding/LM head, 64 for the
      layers, DequantizeLinear-21; same GLTR buckets as fp32 on 97-100% of tokens). 'int8w' and 'blk'
      are earlier variants kept for comparison ('int8w' is too lossy).
"""
import os, sys, numpy as np, onnx
from onnx import helper as oh, TensorProto as TP, numpy_helper as nh
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from np_gpt2 import load_weights

K = 5
def build(mode, out_path):
    W = load_weights()
    inits, nodes = [], []
    cnt = [0]
    def nm(p):
        cnt[0] += 1; return f'{p}_{cnt[0]}'
    def const(arr, name=None):
        name = name or nm('c')
        inits.append(nh.from_array(np.asarray(arr), name)); return name
    def weight(arr, name, axis):
        """fp32 weight, or int8 per-channel + DequantizeLinear."""
        if mode == 'fp32':
            return const(arr.astype(np.float32), name)
        if mode == 'dq21':
            a = arr.astype(np.float32)
            if name == 'wpe':
                return node_named('Cast', [const(a.astype(np.float16), name + '_h')], name, to=TP.FLOAT)
            bs = 16 if name == 'wte' else 64
            R, C = a.shape
            if axis == 0:   # channels = rows; blocks along columns (DQ axis=1)
                r = a.reshape(R, C // bs, bs); s = np.abs(r).max(-1) / 127.0; s[s == 0] = 1e-6
                q = np.clip(np.round(r / s[:, :, None]), -127, 127).astype(np.int8).reshape(R, C); dq_axis = 1
            else:           # channels = columns; blocks down the rows (DQ axis=0)
                r = a.reshape(R // bs, bs, C); s = np.abs(r).max(1) / 127.0; s[s == 0] = 1e-6
                q = np.clip(np.round(r / s[:, None, :]), -127, 127).astype(np.int8).reshape(R, C); dq_axis = 0
            return node_named('DequantizeLinear', [const(q, name + '_q'), const(s.astype(np.float32), name + '_s')], name, axis=dq_axis, block_size=bs)
        if mode == 'blk':
            a = arr.astype(np.float32)
            if name == 'wpe':
                return node_named('Cast', [const(a.astype(np.float16), name + '_h')], name, to=TP.FLOAT)
            bs = 16 if name == 'wte' else 64
            if axis == 0:   # rows are channels, blocks run along the columns
                R, C = a.shape; r = a.reshape(R, C // bs, bs)
                s = (np.abs(r).max(-1, keepdims=True) / 127.0).astype(np.float16); s[s == 0] = np.float16(1e-6)
                q = np.clip(np.round(r / s.astype(np.float32)), -127, 127).astype(np.int8)
                shp3 = [R, C // bs, bs]
            else:           # columns are channels, blocks run down the rows
                R, C = a.shape; r = a.reshape(R // bs, bs, C)
                s = (np.abs(r).max(1, keepdims=True) / 127.0).astype(np.float16); s[s == 0] = np.float16(1e-6)
                q = np.clip(np.round(r / s.astype(np.float32)), -127, 127).astype(np.int8)
                shp3 = [R // bs, bs, C]
            qf = node('Cast', [const(q.reshape(R, C), name + '_q')], to=TP.FLOAT)
            q3 = node('Reshape', [qf, const(np.array(shp3, dtype=np.int64))])
            sc = node('Cast', [const(s, name + '_s')], to=TP.FLOAT)
            return node_named('Reshape', [node('Mul', [q3, sc]), const(np.array([R, C], dtype=np.int64))], name)
        a = arr.astype(np.float32)
        red = tuple(i for i in range(a.ndim) if i != axis)
        scale = np.abs(a).max(axis=red) / 127.0
        scale[scale == 0] = 1e-8
        shp = [1] * a.ndim; shp[axis] = -1
        q = np.clip(np.round(a / scale.reshape(shp)), -127, 127).astype(np.int8)
        qn = const(q, name + '_q'); sn = const(scale.astype(np.float32), name + '_s')
        zn = const(np.zeros_like(scale, dtype=np.int8), name + '_z')
        nodes.append(oh.make_node('DequantizeLinear', [qn, sn, zn], [name], axis=axis))
        return name
    def node_named(op, ins, out, **kw):
        nodes.append(oh.make_node(op, ins, [out], **kw)); return out
    def node(op, ins, **kw):
        out = nm(op.lower()); nodes.append(oh.make_node(op, ins, [out], **kw)); return out

    wte = weight(W['wte'], 'wte', 0)
    wpe = weight(W['wpe'], 'wpe', 0)
    shp = node('Shape', ['input_ids'])
    T = node('Gather', [shp, const(np.array(1, dtype=np.int64))], axis=0)
    T1 = node('Unsqueeze', [T, const(np.array([0], dtype=np.int64))])
    pos = node('Range', [const(np.array(0, dtype=np.int64)), T, const(np.array(1, dtype=np.int64))])
    x = node('Add', [node('Gather', [wte, 'input_ids'], axis=0), node('Gather', [wpe, pos], axis=0)])
    TT = node('Concat', [T1, T1], axis=0)
    ones = node('ConstantOfShape', [TT], value=nh.from_array(np.array([1.0], dtype=np.float32)))
    tril = node('Trilu', [ones], upper=0)
    mask = node('Mul', [node('Sub', [tril, const(np.array(1.0, dtype=np.float32))]), const(np.array(1e4, dtype=np.float32))])
    shp_heads = const(np.array([1, -1, 12, 64], dtype=np.int64))
    shp_model = const(np.array([1, -1, 768], dtype=np.int64))
    c_half = const(np.array(0.5, dtype=np.float32)); c_one = const(np.array(1.0, dtype=np.float32))
    c_k = const(np.array(np.sqrt(2 / np.pi), dtype=np.float32)); c_a = const(np.array(0.044715, dtype=np.float32))
    c_scale = const(np.array(0.125, dtype=np.float32))
    split_sizes = const(np.array([768, 768, 768], dtype=np.int64))
    for i, L in enumerate(W['layers']):
        h = node('LayerNormalization', [x, const(L['ln1_g']), const(L['ln1_b'])], axis=-1, epsilon=1e-5)
        wqkv = np.concatenate([L['wq'], L['wk'], L['wv']], axis=1)
        bqkv = np.concatenate([L['bq'], L['bk'], L['bv']])
        qkv = node('Add', [node('MatMul', [h, weight(wqkv, f'l{i}_wqkv', 1)]), const(bqkv)])
        q, k, v = (f'l{i}_q', f'l{i}_k', f'l{i}_v')
        nodes.append(oh.make_node('Split', [qkv, split_sizes], [q, k, v], axis=-1))
        qh = node('Transpose', [node('Reshape', [q, shp_heads])], perm=[0, 2, 1, 3])
        kh = node('Transpose', [node('Reshape', [k, shp_heads])], perm=[0, 2, 3, 1])
        vh = node('Transpose', [node('Reshape', [v, shp_heads])], perm=[0, 2, 1, 3])
        s = node('Add', [node('Mul', [node('MatMul', [qh, kh]), c_scale]), mask])
        a = node('Softmax', [s], axis=-1)
        o = node('Reshape', [node('Transpose', [node('MatMul', [a, vh])], perm=[0, 2, 1, 3]), shp_model])
        x = node('Add', [x, node('Add', [node('MatMul', [o, weight(L['wo'], f'l{i}_wo', 1)]), const(L['bo'])])])
        h = node('LayerNormalization', [x, const(L['ln2_g']), const(L['ln2_b'])], axis=-1, epsilon=1e-5)
        f = node('Add', [node('MatMul', [h, weight(L['wfc'], f'l{i}_wfc', 1)]), const(L['bfc'])])
        inner = node('Mul', [c_k, node('Add', [f, node('Mul', [c_a, node('Mul', [f, node('Mul', [f, f])])])])])
        g = node('Mul', [node('Mul', [c_half, f]), node('Add', [c_one, node('Tanh', [inner])])])
        x = node('Add', [x, node('Add', [node('MatMul', [g, weight(L['wpr'], f'l{i}_wpr', 1)]), const(L['bpr'])])])
    hf = node('LayerNormalization', [x, const(W['lnf_g']), const(W['lnf_b'])], axis=-1, epsilon=1e-5)
    h2 = node('Reshape', [hf, const(np.array([-1, 768], dtype=np.int64))])
    logits = node('Gemm', [h2, wte], transB=1)
    Tm1 = node('Sub', [T1, const(np.array([1], dtype=np.int64))])
    zero1 = const(np.array([0], dtype=np.int64)); one1 = const(np.array([1], dtype=np.int64))
    Ls = node('Slice', [logits, zero1, Tm1, zero1])
    ids1 = node('Squeeze', ['input_ids', zero1])
    tgt = node('Unsqueeze', [node('Slice', [ids1, one1, T1, zero1]), one1])
    logp = node('LogSoftmax', [Ls], axis=1)
    lpt = node('GatherElements', [logp, tgt], axis=1)
    rank = node('ReduceSum', [node('Cast', [node('Greater', [logp, lpt])], to=TP.FLOAT), one1], keepdims=1)
    plp = node('Mul', [node('Exp', [logp]), logp])
    m1 = node('ReduceSum', [plp, one1], keepdims=1)
    m2 = node('ReduceSum', [node('Mul', [plp, logp]), one1], keepdims=1)
    nodes.append(oh.make_node('Concat', [lpt, rank, m1, m2], ['stats'], axis=1))
    nodes.append(oh.make_node('TopK', [logp, const(np.array([K], dtype=np.int64))], ['top_logp', 'top_ids'], axis=1))
    graph = oh.make_graph(nodes, 'gpt2_detector_stats',
        [oh.make_tensor_value_info('input_ids', TP.INT64, [1, 'T'])],
        [oh.make_tensor_value_info('stats', TP.FLOAT, ['Tm1', 4]),
         oh.make_tensor_value_info('top_ids', TP.INT64, ['Tm1', K]),
         oh.make_tensor_value_info('top_logp', TP.FLOAT, ['Tm1', K])], inits)
    model = oh.make_model(graph, opset_imports=[oh.make_opsetid('', 21 if mode == 'dq21' else 17)], producer_name='ai-check-gpt2')
    model.ir_version = 10 if mode == 'dq21' else 8
    onnx.checker.check_model(model, full_check=False)
    onnx.save(model, out_path)
    import os; print(out_path, '%.1f MB' % (os.path.getsize(out_path) / 1e6))

if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])

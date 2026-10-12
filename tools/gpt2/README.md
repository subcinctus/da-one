# GPT-2 export for GLTR-style checks (not used by the page yet)

`build_onnx.py fp32|dq21 out.onnx` builds a GPT-2 small ONNX graph that outputs, for every token,
log p(next token), its rank, and E[log p] / E[(log p)^2] — what GLTR, Fast-DetectGPT and the
GPTZero-style perplexity method need. Weights come from the Keras-NLP copy of OpenAI's GPT-2 small.
`check_gltr_ref.py` reproduces the outputs shipped with GLTR's demo (identical ranks, probabilities
within 3e-5). Left out of the page because it adds about 140 MB and these detectors score far lower than
the trained ones on modern AI text (GLTR 59.7% on RAID).

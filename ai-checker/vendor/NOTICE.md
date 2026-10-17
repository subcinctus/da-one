# Third-party components

| File | Project | Licence |
|---|---|---|
| `lzma_worker-min.js` | LZMA-JS by Nathan Rugg, as bundled in [thinkst/zippy](https://github.com/thinkst/zippy) (`inch/scripts/`) | MIT |
| `zippy-ai-generated.txt` | ZipPy AI-text corpus, the copy embedded in Thinkst's compiled browser build (`inch/scripts/nlzmadetect.js`) | MIT (Thinkst Applied Research) |
| `../detectors/zippy.js` | Port of ZipPy's `nlzmadetect.nim` | MIT (Thinkst Applied Research) |
| `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` (added at build time) | [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) 1.30.0 | MIT (Microsoft) |
| `tokenizers.min.mjs` (added at build time) | [@huggingface/tokenizers](https://www.npmjs.com/package/@huggingface/tokenizers) 0.1.3 | Apache-2.0 |
| `harper/*` (added at build time) | [harper.js](https://www.npmjs.com/package/harper.js) 2.13.0, Automattic's Harper grammar checker | Apache-2.0 |
| `web-llm/index.js` | [@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) 0.2.86 | Apache-2.0 |
| `../src/confusables-data.mjs` | Unicode TR39 `confusables.txt` 17.0.0 (selected rows) | Unicode License v3 (below) |
| `../src/tells-data.mjs` | Rules ported and adapted from [blader/humanizer](https://github.com/blader/humanizer) (© 2025 Siqi Chen), [tbhb/vale-ai-tells](https://github.com/tbhb/vale-ai-tells) (© 2025-2026 Tony Burns), [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop) (© 2025 Hardik Pandya), [berenslab/llm-excess-vocab](https://github.com/berenslab/llm-excess-vocab) (© 2024 Dmitry Kobak, Rita González-Márquez), [pablocaeg/sloptotal](https://github.com/pablocaeg/sloptotal) (© 2025-2026 SlopTotal) | MIT (each) |

Models (added at build time from the `claude/ai-checker-models` branch):

| Model | Source | Licence |
|---|---|---|
| ModernBERT detector | `GeorgeDrayson/modernbert-ai-detection-raid-mage` (Drayson, Yilmaz, Lampos, EMNLP 2025) | Apache-2.0 |
| e5-small LoRA | `MayZhou/e5-small-lora-ai-generated-detector` | MIT |
| BERT-tiny RAID | `ShantanuT01/BERT-tiny-RAID` | MIT |
| Fakespot RoBERTa | `fakespot-ai/roberta-base-ai-text-detection-v1` | Apache-2.0 |
| Tabularis ModernBERT | `tabularisai/ai-text-detection` | MIT |
| SalluLabs MiniLM | [salmannawaz786/sallulabs-ai-detector](https://github.com/salmannawaz786/sallulabs-ai-detector) (ONNX from the repository) | MIT |
| NLI DeBERTa-v3-xsmall (meaning guard) | `cross-encoder/nli-deberta-v3-xsmall` | Apache-2.0 |
| all-MiniLM-L6-v2 (similarity guard) | `sentence-transformers/all-MiniLM-L6-v2` | Apache-2.0 |

Rewriters the page can talk to (not shipped with the site; you run or load them yourself):

| Model | Source | Licence |
|---|---|---|
| Humanizer 12B (GGUF, run in llama.cpp on your computer) | `jialinyyzz/humanizer`, from [sgaofen/humanizer-local-model](https://github.com/sgaofen/humanizer-local-model) | Apache-2.0 (Gemma terms apply to the base model) |
| Qwen3 1.7B / 4B / 8B (loaded by WebLLM from Hugging Face) | `mlc-ai/Qwen3-*-MLC` | Apache-2.0 |

## Unicode License v3

`src/confusables-data.mjs` is derived from Unicode data files:

> UNICODE LICENSE V3
>
> COPYRIGHT AND PERMISSION NOTICE
>
> Copyright © 1991-2025 Unicode, Inc.
>
> NOTICE TO USER: Carefully read the following legal agreement. BY DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of data files and any associated documentation (the "Data Files") or software and any associated documentation (the "Software") to deal in the Data Files or Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, and/or sell copies of the Data Files or Software, and to permit persons to whom the Data Files or Software are furnished to do so, provided that either (a) this copyright and permission notice appear with all copies of the Data Files or Software, or (b) this copyright and permission notice appear in associated Documentation.
>
> THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF THIRD PARTY RIGHTS. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA FILES OR SOFTWARE.
>
> Except as contained in this notice, the name of a copyright holder shall not be used in advertising or otherwise to promote the sale, use or other dealings in these Data Files or Software without prior written authorization of the copyright holder.

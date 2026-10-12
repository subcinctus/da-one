# Third-party components

| File | Project | Licence |
|---|---|---|
| `lzma_worker-min.js` | LZMA-JS by Nathan Rugg, as bundled in [thinkst/zippy](https://github.com/thinkst/zippy) (`inch/scripts/`) | MIT |
| `zippy-ai-generated.txt` | ZipPy AI-text corpus, the copy embedded in Thinkst's compiled browser build (`inch/scripts/nlzmadetect.js`) | MIT (Thinkst Applied Research) |
| `../detectors/zippy.js` | Port of ZipPy's `nlzmadetect.nim` | MIT (Thinkst Applied Research) |
| `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` (added at build time) | [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) 1.22.0 | MIT (Microsoft) |
| `tokenizers.min.mjs` (added at build time) | [@huggingface/tokenizers](https://www.npmjs.com/package/@huggingface/tokenizers) 0.1.3 | Apache-2.0 |

Models (added at build time from the `claude/ai-checker-models` branch):

| Model | Source | Licence |
|---|---|---|
| ModernBERT detector | `GeorgeDrayson/modernbert-ai-detection-raid-mage` (Drayson, Yilmaz, Lampos, EMNLP 2025) | Apache-2.0 |
| e5-small LoRA | `MayZhou/e5-small-lora-ai-generated-detector` | MIT |
| BERT-tiny RAID | `ShantanuT01/BERT-tiny-RAID` | MIT |

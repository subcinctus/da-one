# Answer Rewrite Desk

A browser page for checking an answer against open-source AI-text detectors and rewriting the
sentences they flag, without breaking the facts in it.

- **Checks run in the browser.** Nothing is uploaded when you press Check. The detectors are
  ONNX models executed with ONNX Runtime Web (WebAssembly) in a worker, plus ZipPy in plain JS.
- **Rewrites go through Claude** (the artifact `sample` capability, on the viewer's own Claude
  account). Outside Claude the page offers a copy-the-request / paste-the-answer fallback.
- **Nothing is changed without review.** Every rewrite opens a word-level diff and a fact check
  (numbers, amounts, dates, acronyms and names must survive). Every check and accepted rewrite is
  saved as a version on the device; the draft autosaves.

## Checkers

| Checker | Source | Method | RAID (UPenn) at 5% false positives | Size in browser |
|---|---|---|---|---|
| ModernBERT detector | Drayson, Yilmaz, Lampos (UCL), EMNLP 2025 — [GeorgeDrayson/model_collapse](https://github.com/GeorgeDrayson/model_collapse), model Apache-2.0 | fine-tuned ModernBERT-base on RAID + MAGE | 99.1% caught (94.1% under attacks) | 160 MB |
| e5-small LoRA | [menglinzhou/microsoft-hackathon-24](https://github.com/menglinzhou/microsoft-hackathon-24), MIT | e5-small + LoRA on RAID | 93.9% (85.7%) | 36 MB |
| BERT-tiny RAID | RAID leaderboard entry `ShantanuT01/BERT-tiny-RAID`, MIT | 4M-parameter BERT on RAID | 91.1% (84.2%) | 4.7 MB |
| ZipPy | [thinkst/zippy](https://github.com/thinkst/zippy), MIT | LZMA compression against an AI-text corpus | not listed | none |

Universities mostly use Turnitin, GPTZero and Copyleaks (DrillBit through ShodhShuddhi in
India). None publish their models, so none can run here. The page links to GPTZero's free checker
for a cross-check.

Older university-lab detectors were considered and left out of this version. GLTR (Harvard/MIT-IBM)
scores 59.7% on RAID, the GPTZero-style perplexity method is similar, and Fast-DetectGPT
(Westlake) needs a 7B model to be strong. They all need GPT-2 in the browser (about 140 MB), which does
not fit next to ModernBERT under the 256 MB artifact limit. The GPT-2 export in `tools/` reproduces
GLTR's published GPT-2 outputs exactly, if a "classic detectors" page is wanted later.

## How the numbers were checked

- **Model export** (`tools/export_detectors.py`, run by `.github/workflows/fetch-detector-models.yml`
  because the build sandbox cannot reach Hugging Face): PyTorch → ONNX → int8 weights in 64-value
  blocks (`DequantizeLinear`-21). On 480 human vs GPT-4/ChatGPT samples the int8 models agree with
  PyTorch on 99.8% (ModernBERT), 100% (e5) and 99.2% (BERT-tiny) of decisions. 4-bit versions were
  too lossy and are not used. Files are on the `claude/ai-checker-models` branch.
- **Browser runtime**: tokenizers.js gives the same token IDs as Hugging Face `tokenizers` on 70
  test strings per model (incl. ₹ amounts, Hindi, emoji); ONNX Runtime Web gives the same
  probabilities as Python ONNX Runtime to within 1e-5.
- **ZipPy**: `detectors/zippy.js` is a port of Thinkst's browser build (`nlzmadetect`). With the
  same corpus it returns byte-identical scores to their compiled extension code on 64 test texts.
- **Calibration** (`tools/calibrate.py`): raw detector probabilities are not comparable across
  kinds of writing (RAID's own thresholds flagged 97% of human PubMed answers at ModernBERT's news
  threshold), so each score is shown as a percentile against 299 pieces of professional human
  writing: RAID's abstracts, news, Wikipedia, Reddit, reviews, books, poetry and recipes, plus BBC
  news and WritingPrompts stories from Fast-DetectGPT's data. "Flags AI" means above the 95th
  percentile. Measured on a held-out half (quantiles fitted on the other half):

  | | AI texts caught | Human texts flagged |
  |---|---|---|
  | Combined score (weights 3 ModernBERT, 1 e5, ¼ BERT-tiny, ¼ ZipPy) | 99% | 7% |
  | ModernBERT alone | 99% | 8% |
  | e5-small LoRA alone | 90% | 7% |
  | BERT-tiny alone | 69% | 3% |
  | ZipPy alone | 15% | 8% |

  The 301 AI texts came from GPT-4, ChatGPT, GPT-3, GPT-2, Llama 2 chat, Mistral, MPT and Cohere.

- **Essays are the weak spot.** On 300 human school essays (Kaggle DAIGT, Persuade corpus) ModernBERT
  scored 72% as AI, and e5 rated many of them highly too. Calibrated against those essays instead,
  the checkers caught 88% of AI essays but rated a ChatGPT-style business answer as low risk (27
  instead of 100). The page is meant for professional answers, so it compares with professional
  writing and tells the user that high scores on school-style essays need care.

## Build and publish

```
python3 tools/build_artifact.py dist     # needs the models branch, onnxruntime-web 1.22.0 and @huggingface/tokenizers 0.1.3
```

`dist/` holds 33 files (about 217 MB). Artifacts cap files at 15 MB, publishes at 64 MB and a version
at 256 MB, so model weights are split into 14 MiB parts named `.wasm` (a served binary type; the
worker only reads the bytes, then checks the SHA-256 of the whole model) and the folder goes up in
four publishes. The worker keeps downloaded parts in the browser's Cache Storage, so later visits
start in seconds.

Published at https://claude.ai/artifact/3zpyz9du2icMWjGLF4wPQQ (private to its owner until shared).

## Limits

- No open-source detector equals Turnitin. A low score here lowers the risk; it does not guarantee
  a pass.
- Under about 150 words every detector is unreliable. Turnitin does not score text under 300 words.
- Text rewritten by AI can still read as AI. The best results come from editing the flagged
  sentences in your own words; the suggestions are a starting point.
- ModernBERT needs about 0.8 GB of memory, so it is off by default on phones and low-memory devices.

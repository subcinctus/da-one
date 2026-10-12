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
- **Calibration** (`tools/calibrate.py`): RAID's own thresholds over-flag human writing outside RAID
  (for example 97% of human PubMed answers at ModernBERT's news threshold), so each score is shown as
  a percentile against CALIBRATION_HUMANS human-written samples (RAID, BBC news, WritingPrompts, US
  student essays). "Flags AI" means above the 95th percentile. Measured on a held-out half:
  CALIBRATION_TABLE

## Build and publish

```
python3 tools/build_artifact.py dist     # needs the models branch, onnxruntime-web 1.22.0 and @huggingface/tokenizers 0.1.3
```

`dist/` holds 33 files (~217 MB, every file under the 15 MB artifact limit). Model weights are split
into 14 MiB parts; the worker downloads them once, checks the SHA-256 and keeps them in the
browser's Cache Storage.

## Limits

- No open-source detector equals Turnitin. A low score here lowers the risk; it does not guarantee
  a pass.
- Under about 150 words every detector is unreliable. Turnitin does not score text under 300 words.
- Text rewritten by AI can still read as AI. The best results come from editing the flagged
  sentences in your own words; the suggestions are a starting point.
- ModernBERT needs about 0.8 GB of memory, so it is off by default on phones and low-memory devices.

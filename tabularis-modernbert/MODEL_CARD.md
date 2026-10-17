---
language: en
license: mit
tags:
- ai-text-detection
- modernbert
- raid
- text-classification
library_name: transformers
base_model: answerdotai/ModernBERT-base
---

# Tabularis ModernBERT R1 — AI Text Detector

ModernBERT-base fine-tuned for binary AI-vs-human text classification.
Trained on a unified ~11M-row corpus combining the RAID benchmark with six
external AI-text datasets.

## Real RAID leaderboard scores (PR #137)

| metric | value |
| --- | ---: |
| AUROC | 0.9904 |
| TPR @ FPR=5% | 0.9815 |
| TPR @ FPR=1% | 0.9306 |
| Clean (no attacks) AUROC | 0.9945 |
| Clean TPR @ FPR=5% | 0.9903 |

These are the official numbers from the RAID benchmark CI run on the hidden
test labels.

## Beats candidate-D on most attack categories

| attack | TPR@5% vs candidate-D | TPR@1% vs candidate-D |
| --- | ---: | ---: |
| paraphrase | +5.58 | +11.53 |
| synonym | +0.49 | +1.62 |
| perplexity_misspelling | +0.43 | +1.69 |
| upper_lower | +0.98 | +2.54 |
| article_deletion | +0.75 | +1.93 |
| alternative_spelling | +0.13 | +0.78 |
| none (clean) | -0.03 | +0.41 |
| zero_width_space | -6.32 | -26.85 |
| homoglyph | -1.11 | -8.31 |
| whitespace | -2.66 | -5.67 |
| insert_paragraphs | -0.82 | -1.46 |

The character-level attack losses (zero_width, homoglyph, whitespace) are
closeable at inference time with NFKC normalization (see "Inference notes"
below). Local pseudo-GT eval projects NFKC-normalized inference to push
AUROC to ~0.993 and TPR@5% to ~0.996.

## Training data

| source | rows | human | AI |
| --- | ---: | ---: | ---: |
| RAID train + extra | 7,650,631 | 218,685 | 7,431,946 |
| artem9k/ai-text-detection-pile | 1,391,905 | 1,028,142 | 363,763 |
| tabularisai/oak (AI-only Response) | 1,055,595 | 0 | 1,055,595 |
| andythetechnerd03/AI-human-text | 487,229 | 305,797 | 181,432 |
| NicolaiSivesind/human-vs-machine | 320,000 | 160,000 | 160,000 |
| Roxanne-WANG/AI-Text_Detection | 22,506 | 5,998 | 16,508 |
| Varun53/AI_text_detection | 2,252 | 1,000 | 1,252 |
| **TOTAL** | **10,930,118** | **1,719,622** | **9,210,496** |

Labels manually verified per dataset before mixing.

## Training recipe

- base model: `answerdotai/ModernBERT-base` (149M params)
- max sequence length: 512
- 1 epoch
- 4× H100 80GB, FSDP full-shard, BF16, TF32
- per-device batch 192, effective batch 768
- AdamW, lr 8e-5, 6% warmup, weight_decay 0.01
- class-weighted cross-entropy (inverse frequency): w_human=3.18, w_AI=0.59
- label smoothing 0.005
- training time: 2h 25min total

## Inference notes

Prediction is binary: `score` is the probability the text is AI-generated.

For maximum accuracy on noisy / adversarial inputs, apply NFKC normalization
before scoring. Strips zero-width invisibles, fullwidth chars, ligatures;
collapses whitespace. Projected leaderboard gain: AUROC +0.003,
TPR@5% +0.014, TPR@1% +0.075 over raw inference.

```python
import re, unicodedata
from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch

ZERO_WIDTH = re.compile(r"[​-‏⁠﻿­]")
WS = re.compile(r"\s+")

def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text)
    t = ZERO_WIDTH.sub("", t)
    t = WS.sub(" ", t).strip()
    return t

tok = AutoTokenizer.from_pretrained("tabularisai/ai-text-detection")
m = AutoModelForSequenceClassification.from_pretrained("tabularisai/ai-text-detection").eval().cuda()

@torch.no_grad()
def score(texts):
    norm = [normalize(t) for t in texts]
    enc = tok(norm, padding=True, truncation=True, max_length=512, return_tensors="pt").to("cuda")
    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        logits = m(**enc).logits
    return torch.softmax(logits.float(), dim=-1)[:, 1].cpu().tolist()
```

## Files

| file | purpose |
| --- | --- |
| `model.safetensors` | weights (149.6M params, ~600 MB) |
| `config.json` | ModernBERT config + classifier head |
| `tokenizer.json`, `tokenizer_config.json` | tokenizer |

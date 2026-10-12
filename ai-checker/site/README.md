# Answer Rewrite Desk

**Open the page: https://subcinctus.github.io/answer-desk/**

Paste an answer and press **Check**. Four open-source AI-text detectors score it in your browser, and
the sentences they rate most AI-like are highlighted for rewriting. Every rewrite opens a
word-by-word comparison and a fact check (numbers, amounts, dates, names and acronyms must
survive) before anything in your answer changes.

- **Private by design.** The checks run in the browser. Your text is not uploaded when you press Check.
- **First visit downloads the detectors** (about 215 MB on a computer, about 55 MB on a phone, where
  the largest detector is off by default). Later visits load them from the browser's cache in seconds.
- **Rewrites.** On this site, press Rewrite flagged or Rephrase all, copy the request into a Claude
  chat and paste the reply back; the page then shows the comparison and the fact check. When the
  same page is opened from Claude, rewrites happen in one click.
- **Versions.** Every check and accepted rewrite is saved as a version on this device, and the
  draft saves itself as you type.

## Checkers

| Checker | Source | RAID benchmark (UPenn), AI caught at 5% false positives |
|---|---|---|
| ModernBERT detector | Drayson, Yilmaz, Lampos (UCL), EMNLP 2025 — `GeorgeDrayson/modernbert-ai-detection-raid-mage`, Apache-2.0 | 99.1% |
| e5-small LoRA | `MayZhou/e5-small-lora-ai-generated-detector`, MIT | 93.9% |
| BERT-tiny RAID | `ShantanuT01/BERT-tiny-RAID`, MIT | 91.1% |
| ZipPy | [thinkst/zippy](https://github.com/thinkst/zippy), MIT | not listed |

Scores are shown as percentiles against 299 pieces of professional human writing. On a held-out set
the combined score flagged 99% of AI texts and 7% of human texts.

Universities mostly use Turnitin, GPTZero and Copyleaks (DrillBit through ShodhShuddhi in India).
None publish their models, so none can run here; the page links to GPTZero's free checker for a
cross-check.

## Limits

- No open-source detector equals Turnitin. A low score here lowers the risk; it does not guarantee a pass.
- Under about 150 words every detector is unreliable.
- These detectors score many human school-style essays as AI, so treat high scores on that kind of
  writing with care.
- Text rewritten by AI can still read as AI. Editing the flagged sentences in your own words works best.

This repository holds only the built page. Third-party components and licences are listed in
`vendor/NOTICE.md`, with licence texts in `LICENSES/`.

# Calibration report

Pool: {'n': 4091, 'ref_human': 1523, 'ai': 1653, 'modern_ai': 1493, 'nonnative': 382, 'essay': 158, 'heldout': 300}

## Detectors (held-out half; "flags" = above the 95th percentile of professional human writing)

| Detector | AUROC modern | AUROC held-out | Modern AI flagged | Prof. human flagged | Non-native flagged | Essays flagged | Held-out AI / human flagged |
|---|---|---|---|---|---|---|---|
| bert-tiny-raid | 0.686 | 0.535 | 23.7% (19.9–27.9, n=460) | 3.8% (2.3–5.9, n=473) | 12.8% (9.6–16.6, n=382) | 28.5% (21.6–36.2, n=158) | 5% / 2% |
| e5-small-lora | 0.725 | 0.799 | 30.9% (26.7–35.3, n=460) | 5.1% (3.3–7.5, n=473) | 14.9% (11.5–18.9, n=382) | 0.6% (0.0–3.5, n=158) | 11% / 1% |
| fakespot-roberta | 0.901 | 0.986 | 65.4% (60.9–69.8, n=460) | 5.1% (3.3–7.5, n=473) | 2.9% (1.4–5.1, n=382) | 1.3% (0.2–4.5, n=158) | 78% / 1% |
| modernbert-raid-mage | 0.753 | 0.730 | 12.8% (9.9–16.2, n=460) | 5.7% (3.8–8.2, n=473) | 17.0% (13.4–21.2, n=382) | 0.0% (0.0–2.3, n=158) | 3% / 3% |
| sallulabs-minilm | 0.854 | 0.608 | 55.0% (50.3–59.6, n=460) | 5.3% (3.4–7.7, n=473) | 0.3% (0.0–1.4, n=382) | 0.0% (0.0–2.3, n=158) | 36% / 1% |
| tabularis-modernbert | 0.863 | 0.914 | 65.4% (60.9–69.8, n=460) | 7.2% (5.0–9.9, n=473) | 17.3% (13.6–21.4, n=382) | 1.3% (0.2–4.5, n=158) | 86% / 19% |
| tells | 0.742 | 0.762 | 36.5% (32.1–41.1, n=460) | 4.4% (2.8–6.7, n=473) | 3.4% (1.8–5.7, n=382) | 1.3% (0.2–4.5, n=158) | 39% / 11% |
| zippy | 0.505 | 0.671 | 2.6% (1.4–4.5, n=460) | 6.8% (4.7–9.4, n=473) | 9.9% (7.1–13.4, n=382) | 0.6% (0.0–3.5, n=158) | 0% / 0% |

## Combined score

Weights: {'bert-tiny-raid': 0.0, 'e5-small-lora': 0.0, 'fakespot-roberta': 0.5217, 'modernbert-raid-mage': 0.2839, 'sallulabs-minilm': 0.1735, 'tabularis-modernbert': 0.0633, 'tells': 0.0287, 'zippy': 0.0}

- AUROC modern 0.921, held-out 0.985
- Modern AI flagged: 70.7% (66.3–74.8, n=460); legacy (GPT-3.5/4) AI: 100.0% (94.7–100.0, n=68)
- Professional human flagged: 4.7% (2.9–7.0, n=473); at 150+ words 5.3% (3.3–8.1, n=378); Medium or High 8.7% (6.3–11.6, n=473)
- Non-native human flagged: 3.9% (2.2–6.4, n=382); student essays 0.6% (0.0–3.5, n=158)
- Held-out articles (Human Detectors): AI 84.0% (77.1–89.5, n=150), human 1.3% (0.2–4.7, n=150)
- Modern AI rated Medium or High: 78.7% (74.7–82.4, n=460)
- In-domain AI answers (lending, the owner's register): flagged 13.8% (3.9–31.7, n=29); Medium or High 24.1% (10.3–43.5, n=29)

| Task | Modern AI flagged |
|---|---|
| generate | 79.4% (74.0–84.1, n=267) |
| polish | 56.9% (43.2–69.8, n=58) |
| rewrite | 54.1% (43.0–65.0, n=85) |
| humanized | 68.0% (53.3–80.5, n=50) |

| Generator | Flagged |
|---|---|
| Claude-3.7-sonnet | 62% |
| DeepSeek-R1 | 59% |
| DeepSeek-V3 | 80% |
| Doubao-1.5-pro-32k | 42% |
| GPT-4o | 62% |
| GPT-4o-mini | 82% |
| GPT-o3-mini | 58% |
| Llama-3.1-8B-Instruct | 100% |
| Qwen2.5-7B-Instruct | 100% |
| Qwen2.5-7B-Instruct-R1-Distill | 85% |
| claude-opus-5.5 | 14% |
| deepseek/deepseek-v4.1-flash | 58% |
| gemini-2.0-flash | 71% |
| gemini-2.0-flash-lite | 57% |
| grok2 | 60% |
| meta-llama/llama-4-maverick | 90% |
| mistralai/mistral-small-2603 | 82% |
| moonshot-v1 | 77% |
| openai/gpt-6-luna | 71% |
| qwen/qwen3.8-flash | 76% |
| qwq-plus | 62% |
| z-ai/glm-5.3-flash | 56% |

| Human source | Flagged |
|---|---|
| beemo | 37.0% (19.4–57.6, n=27) |
| dactyl | 3.6% (0.1–18.3, n=28) |
| edgar | 4.3% (1.2–10.6, n=93) |
| ellipse | – |
| fdg | 11.9% (4.0–25.6, n=42) |
| hc3-finance | 0.0% (0.0–8.2, n=43) |
| human-detectors | – |
| liang-collegeessay | – |
| liang-hewlettstudentessay | – |
| liang-toefl | – |
| llmtrace | 3.1% (0.1–16.2, n=32) |
| maga | 0.0% (0.0–21.8, n=15) |
| mirage | 0.9% (0.0–5.1, n=107) |
| slopbench | 0.0% (0.0–4.2, n=86) |

| Length (words) | AI flagged | Human flagged |
|---|---|---|
| 0-150 | 69% | 2% |
| 150-300 | 72% | 6% |
| 300-10000 | 69% | 3% |

## Agreement with commercial detectors on the held-out articles

- pangram: agreement 92%, kappa 0.85; pangram itself flagged 98% of AI and 3% of human (n=300)
- gptzero: agreement 93%, kappa 0.86; gptzero itself flagged 84% of AI and 0% of human (n=300)

## Sentence windows

| Detector | Human windows | AI windows | AUROC | AI windows above 90th |
|---|---|---|---|---|
| bert-tiny-raid | 6290 | 5296 | 0.625 | 26% |
| e5-small-lora | 6290 | 5296 | 0.672 | 29% |
| fakespot-roberta | 6290 | 5296 | 0.784 | 51% |
| modernbert-raid-mage | 6290 | 5296 | 0.619 | 22% |
| sallulabs-minilm | 6290 | 5296 | 0.775 | 49% |
| tabularis-modernbert | 6290 | 5296 | 0.764 | 42% |

Validator (held out of rewrite selection): fakespot-roberta

## Release gate: NOT MET
- Professional human texts of 150+ words flagged: 5.3% (3.3–8.1, n=378) (target ≤5%, upper bound ≤8%)
- Modern AI texts flagged: 70.7% (66.3–74.8, n=460) (target ≥90%)

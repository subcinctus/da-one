# Research: detectors, rewriting and hosting (October 2026)

Two research runs made for the website version of Answer Rewrite Desk on 2026-10-17: a broad study (seven topics, each with an independent fact-check, then a synthesis and a critical review) and a sweep of GitHub for free, locally runnable detectors and rewriters with an independently verified shortlist. Hugging Face, arXiv and several vendor sites could not be reached from the research environment, so some figures are marked unverified.

Decisions taken from this research are in the plan: free local models only (owner preference), GitHub Pages hosting, Fakespot RoBERTa added, recalibration on 2024-26 AI text, detector-guided rewriting with fact, meaning and grammar guards, and no character tricks.

---

# Answer Rewrite Desk: decision report on detectors, rewriting and deployment (2026-10-17)

## 1. Executive summary

- **The current accuracy figures were measured without attacks.** The project quotes 99.1%, 93.9% and 91.1% for its three models. Those are RAID scores with no adversarial attacks. Once RAID's 11 attacks are included, the detection rate at 5% false positives (TPR@5%FPR) falls to 94.1% for ModernBERT ([results.json](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/modernbert/results.json)), 85.7% for e5-small-lora ([results.json](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/e5-small-lora/results.json)) and 84.2% for BERT-tiny ([results.json](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/bert-tiny-4m/results.json)).
- **Two of the three current models barely work on 2026 text.** On SlopBench, which uses text from 14 current models, e5 scores AUC 0.721 and BERT-tiny 0.654. SlopTotal's fitted ensemble gives e5 zero weight ([SlopBench FINDINGS](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)). SlopBench is a single developer's benchmark, has not been peer reviewed, and contains only 3 Claude test samples ([SlopBench README](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/README.md)).
- **Recommended in-browser set:**
  - Keep ModernBERT, and A/B-test Tabularis R1.1 as a like-for-like replacement.
  - Add Fakespot RoBERTa-base: Apache-2.0, trained on 14 sources, SlopBench AUC 0.917.
  - Demote e5 and BERT-tiny to whatever weight a refit gives them.
  - Keep ZipPy at low weight.
  - Add a model-free "AI tells" explainer.
  - Normalise lookalike and invisible characters with a confusables map plus format-character stripping before NFKC. NFKC alone does not undo homoglyphs.
- **The best open model needs a server.** ShantanuT01/gradient-ai-text-detector (DeBERTa-v3-large, MIT, not trained on RAID) reached RAID AUC 0.998 with only 1 of 40 modern human texts scored above 0.5 ([SlopTotal eval](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/FINDINGS.md)). The quickest strong server tier is to self-host SlopTotal (MIT, Docker, 23 engines) ([SlopTotal](https://github.com/pablocaeg/sloptotal)) on a Hugging Face Docker Space, which needs a paid plan ([HF Spaces](https://raw.githubusercontent.com/huggingface/hub-docs/main/docs/hub/spaces-overview.md)).
- **Paid detector APIs, in order of value:**
  1. **Pangram:** best independent record; $0.05 per 100 words (vendor price) ([Pangram 4](https://pangram.com/blog/introducing-pangram-4)).
  2. **Sapling:** free quota of 50k characters/day, sentence-level scores ([Sapling pricing](https://sapling.ai/docs/api/pricing/)).
  3. **GPTZero:** from $45/month ([GPTZero developers](https://gptzero.me/developers)).
  - **Exclude Originality.ai.** Its terms forbid using its outputs to "test… or improve any… humanizer, writing assistant" ([Originality T&C](https://originality.ai/terms-and-conditions)).
  - Every API key must sit behind a server-side proxy.
- **Turnitin and DrillBit cannot be called by an individual.** Turnitin sells no individual licences, and its Core API is for institutions and partners only ([Turnitin](https://helpcenter.turnitin.com/hc/en-us/articles/27974736791565), [Core API](https://developers.turnitin.com/turnitin-core-api)). Pangram and GPTZero are the closest stand-ins, but no stand-in can predict one institution's verdict.
- **LLM rewriting can raise detector scores.**
  - Human text polished by an LLM moved from a median score of 22 to 50 on SlopBench, and 59.9% was flagged ([SlopBench FINDINGS](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)).
  - Prompt-based "humanizers" still scored 2–4% human on Pangram. Text rebuilt from the writer's own notes scored 100% human on 4 of 4 texts, but that is a small test run by the tool's builders ([work-humanizer](https://raw.githubusercontent.com/phuryn/work-humanizer/main/README.md)).
  - Design consequence: make Coach mode the default and Interview mode second. Third comes minimal edits to flagged sentences only, behind hard fact and meaning checks. Never use character tricks.
- **Claude watermarks its text.** Anthropic says text from future Claude models carries a watermark applied globally, and that light editing probably won't remove it. Its detection API is in private preview for eligible organisations, which include educational organisations ([Anthropic](https://www.anthropic.com/news/claude-text-watermark)). Rewrites made with newer Claude models can therefore carry a provenance mark that style detectors cannot see. Tell the owner this plainly.
- **Rewriting is cheap.** Sonnet 5.5 costs $2 input / $10 output per million tokens and Haiku 5.5 costs $0.10 / $0.50 ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)). At my estimated call sizes, a full rewrite loop costs about $0.20 per 500-word answer on Sonnet.
- **Calibration matters more than which models you pick.** With 299 human calibration texts, a "1% FPR" threshold could really give anywhere from 0.27% to 2.09%. Pinning it to ±0.5% needs about 1,522 in-domain human texts (my calculation, confirmed in the fact-check). No Indian-English AI-detection dataset was found, so the owner's own pre-2022 writing is the most valuable asset.
- **Host on Cloudflare Workers with static assets.** One origin serves the site, the model parts and the `/api` proxy. Static asset requests are free and unlimited ([CF billing](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/static-assets/billing-and-limitations.mdx)). The 25 MiB per-file limit fits the existing 14 MiB parts ([CF limits](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/platform/limits.mdx)).
- **Version-upgrade trap.** The WebGPU wasm in onnxruntime-web 1.30 is 26,781,914 bytes, over Cloudflare's 25 MiB per-file limit ([tarball](https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz)). To upgrade you must split it, use the 16.76 MB JSPI build, or stay on 1.22.
- **Labels used in this report:**
  - "Vendor" means a figure the company reported about itself.
  - "Unverified" means it could not be confirmed, because Hugging Face, arXiv and most vendor sites were unreachable during research.
  - "Est." means my own estimate.

---

## 2. Local in-browser detector set

### 2.1 Input normalisation (P0: do this before adding any model)
- **Why it is needed:**
  - Homoglyph attacks (lookalike letters from other alphabets) cut e5's detection to 11.1% and BERT-tiny's to 27.5%. ModernBERT holds 83.4% ([e5](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/e5-small-lora/results.json), [bert-tiny](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/bert-tiny-4m/results.json), [modernbert](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/modernbert/results.json)).
  - Fakespot's own figures put it at AUROC 0.49 against zero-width-space attacks ([apollo-text.md](https://github.com/FakespotAILabs/ApolloDFT/blob/main/apollo-text.md)).
- **NFKC alone is not enough.** It leaves the Cyrillic and Greek lookalikes RAID uses (for example "Ηеllо") and U+200B unchanged ([RAID](https://github.com/liamdugan/raid); fact-check test).
- **Required order:**
  1. A confusables map: either the Unicode TR39 skeleton or a Cyrillic/Greek-to-Latin table like DeBERTa-ConPara's `unicode_preprocessing_v2.py` ([deberta-conpara](https://github.com/SES-Lab-OTH/deberta-conpara)).
  2. Strip invisible format characters (Unicode category Cf: U+200B–U+200D, U+2060, U+FEFF).
  3. Apply NFKC.
  4. Normalise unusual spaces.
  5. Warn the user whenever pasted text contained any of these. Run the same checks on every LLM output.
- **Long texts.** e5 and the RoBERTa-family models read at most 512 tokens. Split longer texts into overlapping chunks and aggregate the scores.
  - In the Human Detectors data (articles with a median of about 775 words), the `e5_lora` field scored AUROC 0.198, as if inverted ([data](https://raw.githubusercontent.com/jenna-russell/human_detectors/main/human_detectors.json)). The project's own test shows e5 working the right way round, so the fault is probably in how those authors ran or truncated it.
  - Add a regression test that checks e5's label orientation.
- **Length gate.**
  - Turnitin calls AI scores under 300 words "likely less accurate" ([Turnitin](https://guides.turnitin.com/hc/en-us/articles/28234943089933-File-requirements-for-an-AI-Writing-Report)).
  - At 50 words, SlopBench's human false-flag rate rose from 18.3% to 27.2% ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)).
  - Below about 60 words, ConPara's errors rise 4–5 times ([ConPara](https://github.com/SES-Lab-OTH/deberta-conpara)).
  - Recommendation: below about 150 words show "too short to judge" (est.), and add a note about Turnitin under 300 words.

### 2.2 Recommended local set

| Pri. | Model | Licence | int8 size | New coverage | Evidence | Decision |
|---|---|---|---|---|---|---|
| P0 | GeorgeDrayson/modernbert-ai-detection-raid-mage | Check the HF card (unverified this session) | 160 MB (project) | Most attack-robust of the current set | RAID with attacks 94.1%; paraphrase 92.9%; homoglyph 83.4% ([results.json](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/modernbert/results.json)). 6/40 modern human and 4/26 classic texts scored above 0.5 ([SlopTotal eval](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/FINDINGS.md)). Flagged 72% of human school essays in the project's own test (/home/user/da-one/ai-checker/README.md). The leaderboard entry links `modernbert-ai-detection`, which may be a different checkpoint | **Keep**, desktop only (about 0.8 GB RAM) |
| P1 | tabularisai/ai-text-detection (R1.1, ModernBERT-base) | Unverified | ~150–160 MB est. | Replaces the row above; same architecture and training family | RAID with attacks 98.98% vs 94.14% ([RAID PR #137](https://github.com/liamdugan/raid/pull/137)). 0/40 vs 6/40 human texts above 0.5, but those are RAID texts, so the test is in-distribution ([SlopTotal eval](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/FINDINGS.md)) | **A/B test**, then swap if it gives lower FPR at equal TPR on the owner's calibration set and the licence is acceptable |
| P0 | fakespot-ai/roberta-base-ai-text-detection-v1 | Apache-2.0 ([ApolloDFT](https://github.com/FakespotAILabs/ApolloDFT)) | ~125 MB est. | The most varied training data of any small open model: RAID plus 13 sources including Claude-3-Opus-Instruct, HC3 and Ghostbuster, plus in-house GPT-4o/4o-mini, Gemma 2, Phi-3/3.5, Mixtral, Llama 3–3.2 and Qwen 2.5 ([data README](https://github.com/FakespotAILabs/ApolloDFT/blob/main/data/README.md)) | SlopBench AUC 0.917, third of 23 engines, weight 0.26 in the fit ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)). Bias on pre-1920 prose of +0.533, measured on only 26 passages ([SlopTotal eval](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/FINDINGS.md)). Repo has had no commits since 2025-02-25. Mozilla announced the product's closure in 2025; the exact date is unconfirmed ([PCWorld](https://www.pcworld.com/article/2811459/mozilla-scraps-two-more-firefox-add-ons-deep-fake-detector-and-orbit.html)) | **Add.** Convert with the project's own int8 pipeline and check it against fp32. Use it as the held-out validator in the rewrite loop (§5) |
| P2 | noumenon-labs/Earlybird-fast (DistilRoBERTa, 82M) | MIT according to a listing; unverified ([listing](https://huggingbay.xyz/artifact/hf-model-noumenon-labs-earlybird-fast)) | ~82 MB est. | Trained on Mega-WORM data, not RAID | RAID AUC 0.913, literary bias 0.040, 84 ms per text on CPU. No test on 2026-model text ([SlopTotal eval](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/FINDINGS.md)) | **Optional.** Keep only if it earns stacking weight |
| P1 | MayZhou/e5-small-lora-ai-generated-detector | Check | 36 MB | Little: it is also RAID-trained | RAID with attacks 85.7%, homoglyph 11.1%; SlopBench 0.721; zero weight in the SlopTotal fit ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)) | **Refit.** Drop it from the default download if its weight comes out near 0 |
| P0 | ShantanuT01/BERT-tiny-RAID | Check | 5 MB | Phone fallback; model for the CI smoke test | RAID with attacks 84.2%; SlopBench 0.654 | **Keep** at low weight |
| P0 | ZipPy (LZMA compression) | MIT ([zippy](https://github.com/thinkst/zippy)) | 0 | A non-neural signal | The README publishes no accuracy figure and says it does poorly on non-English text and non-prose | **Keep** at low weight; show it separately |
| P0 | AI-tells explainer (blader/humanizer patterns, stop-slop, berenslab style words) | MIT ([humanizer](https://github.com/blader/humanizer), [stop-slop](https://raw.githubusercontent.com/hardikpandya/stop-slop/main/README.md), [berenslab](https://github.com/berenslab/llm-excess-vocab)) | <1 MB est. | Explains why a sentence reads as AI; drives Coach mode | SlopTotal's "Structural Analysis" engine got the largest weight (0.41) in its fit ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)). The humanizer README says detectors "still flag most of its output" ([README](https://raw.githubusercontent.com/blader/humanizer/main/README.md)) | **Add** as an explainer. Then inspect SlopTotal's structural engine (MIT) and port it as a scored feature |
| P3 | SmolLM2-135M base + Instruct, used for zero-shot scoring | Apache-2.0 (secondary source) | ~118 MB q4f16 per file (HF listing via search, unverified) ([HF](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/blob/refs%2Fpr%2F12/onnx/model_q4f16.onnx)) | Adds the LM-probability family | See §2.3 | **Experiment** behind an opt-in "deep check" |

- **Estimated download size (est.).** Desktop default: ModernBERT + Fakespot + BERT-tiny ≈ 290 MB, or about 326 MB if e5 stays. Phone default: BERT-tiny + explainer, plus Fakespot only if an on-device memory test passes. iOS memory limits could not be verified.

### 2.3 Zero-shot and LM-probability methods
- **The in-browser route works, but not through WebLLM.** WebLLM's `echo` option only prepends the prompt text and returns no log-probabilities for prompt tokens ([engine.ts](https://raw.githubusercontent.com/mlc-ai/web-llm/main/src/engine.ts)). Raw ONNX Runtime Web gives logits for every position, which is what these methods need.
  - One forward pass yields mean log-probability, log-rank, entropy, the Fast-DetectGPT analytic score and surprisal variance (inferred from the method formulas).
  - A second model sharing the tokenizer adds Binoculars ([Binoculars](https://github.com/ahans30/Binoculars)).
  - Expected time is about 5–20 s per 500 words on single-thread WASM (est.).
- **Evidence that it adds value on 2026 text is weak:**
  - GPT-2-scale statistics scored AUC 0.62–0.68 on 2026 models, "close to a coin flip". SlopTotal's "Binoculars" is a simplified score, not the original ([SlopBench](https://raw.githubusercontent.com/pablocaeg/sloptotal/master/tests/eval/slopbench/FINDINGS.md)).
  - A Qwen2.5-0.5B pair scored AUROC 0.949, but on 2022 HC3 data, with thresholds picked on the same sample, in a one-person repo ([ai-text-verifier](https://github.com/andrescas168/ai-text-verifier)).
  - The canonical Falcon-pair Binoculars on official RAID: 79.0% without attacks, 36.1% under homoglyph and 42.1% under synonym attacks ([results.json](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/binoculars/results.json)).
  - No English evaluation of SmolLM2 pairs was found.
  - **Decision:** P3. Give it weight only if it raises held-out AUC on 2026 text.
- **Not feasible or not worth it in the browser:**
  - Qwen2.5-0.5B: the int8 file is 512 MB ([HF](https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/blob/516c8d04add8a80c5228f32102b57953b8d421a9/onnx/model_quantized.onnx)), and the logits for 700 tokens take about 425 MB (est.).
  - Gemma-3: 262k-token vocabulary, and an fp16 overflow on WebGPU that was fixed only by re-exporting the model ([ORT #26732](https://github.com/microsoft/onnxruntime/issues/26732)).
  - Falcon-7B or Llama3-8B pairs: these need a GPU.
  - Ghostbuster and Glimpse: they depend on OpenAI legacy models. Ghostbuster's ada/davinci models were retired, and davinci-002/babbage-002 were listed for shutdown on 2026-09-28 ([LiteLLM registry](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json), [glimpse](https://github.com/baoguangsheng/glimpse)).
  - DetectGPT, NPR and DNA-GPT: they need many LLM calls, and their multi-attack AUROC is 53–68 ([DetectRL](https://github.com/NLP2CT/DetectRL)).
  - DivEye: CC BY-NC-SA licence plus a trained XGBoost classifier ([IBM/diveye](https://github.com/IBM/diveye)).

### 2.4 Too big for single-thread WASM (server only)
- Gradient, Desklib, ConPara (DeBERTa-v3-large); SuperAnnotate, ADAL, RADAR (RoBERTa-large); Vanguard (ModernBERT-large); MELD (Ettin-400M); EditLens.
- mdok (Qwen3-14B, the PAN 2025 winner with a mean of 0.988) ([PAN26 tex](https://github.com/pan-webis-de/pan26-generative-ai-authorship-verification/blob/main/data/task-eval/pan26-leaderboard.tex), [mdok](https://github.com/kinit-sk/mdok)).
- The community q4 ONNX of Gradient is reportedly 408 MB (unverified) ([batmac](https://huggingface.co/batmac/gradient-ai-text-detector-onnx)).
- WASM has a 4 GB memory limit and a protobuf file is capped at 2 GB ([ORT large-models](https://raw.githubusercontent.com/microsoft/onnxruntime/gh-pages/docs/tutorials/web/large-models.md)). That rules out fp32, but not necessarily a quantized 400–600 MB file.
- DeBERTa int8 may shift scores a lot. A claim of up to 0.5 is unverified ([GabeuxDev](https://huggingface.co/GabeuxDev/ai-text-detector-v1.01-onnx)). Any quantized model must be checked against fp32.

### 2.5 Drop or never add
- Hello-SimpleAI RoBERTa: RAID 26.6%. OpenAI RoBERTa: about 51%. RADAR: 63.9%. GLTR: 51.5% ([submissions](https://github.com/liamdugan/raid/tree/main/leaderboard/submissions)).
- TMR: RAID-trained, and it scores human news around 0.98 whatever the year ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)).
- MELD and Linda-RAID: RAID-trained, about 400 MB, licences unknown. MELD's weights sit on an anonymous peer-review account ([meld metadata](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/meld/metadata.json)).
- rasbt and AICodexLab models: 24 of 40 human texts above 0.5 for AICodexLab ([SlopTotal eval](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/FINDINGS.md)).
- distil-labs Gemma slop detector: its authors say formal business and academic writing triggers false positives ([repo](https://github.com/distil-labs/distil-ai-slop-detector)).

### 2.6 Weighting
- Copy SlopTotal's method: a non-negative logistic fit over engine scores, with extra weight on human texts from groups prone to false flags ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)).
- Fit it on the calibration set described in §6.
- Any model that receives zero weight is left out of the default download.

---

## 3. Server-side open detectors worth hosting

Cloudflare Workers have 128 MB of memory per isolate ([CF limits](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/platform/limits.mdx)), so these models need a separate host that the Worker calls.

| Pri. | Option | Evidence | Licence | Host and cost | Effort (est.) |
|---|---|---|---|---|---|
| P2 | **Self-host SlopTotal** (Docker, CPU, about 2 GB of models, 23 engines including Desklib, SuperAnnotate, Fakespot and Structural Analysis, with fitted weights of 0.41 / 0.37 / 0.26 / 0.16 for Structural, Desklib, Fakespot and SuperAnnotate) ([SlopTotal](https://github.com/pablocaeg/sloptotal)) | SuperAnnotate 0.938 and Desklib 0.936 are the two best engines on SlopBench. After calibration, 15% of TOEFL essays are still "Likely AI" ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)) | Code is MIT. The bundled models vary: Desklib's licence is not stated ([desklib](https://github.com/desklib/ai-text-detector)), and SuperAnnotate uses a custom "SAIPL" licence (unverified) ([SuperAnnotate](https://huggingface.co/SuperAnnotate/ai-detector-low-fpr)) | HF Docker Space: creating one requires PRO. CPU Basic hardware (2 vCPU, 16 GB) is free ([HF](https://raw.githubusercontent.com/huggingface/hub-docs/main/docs/hub/spaces-overview.md)). It sleeps after 48 hours idle ([HF](https://raw.githubusercontent.com/huggingface/hub-docs/main/docs/hub/spaces-gpus.md)). PRO is about $9/month (secondary source) ([eesel](https://www.eesel.ai/en/blog/hugging-face-pricing)) | 1 day plus an adapter route |
| P2 | **Gradient-only endpoint** | RAID AUC 0.998 without RAID training, 1/40 human texts above 0.5, about 1,150 ms per text on CPU ([SlopTotal eval](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/FINDINGS.md)). Vendor out-of-distribution AUROC 0.9551 ([HF card, via search](https://huggingface.co/ShantanuT01/gradient-ai-text-detector)). It was **not** tested on SlopBench, so test it on 2026 text yourself. Next on SlopTotal's roadmap ([TODO](https://github.com/pablocaeg/sloptotal/blob/master/docs/TODO.md)) | MIT | Same Space as above. Alternatively a Gradio Space on ZeroGPU: free accounts may host 2 ([HF](https://raw.githubusercontent.com/huggingface/hub-docs/main/docs/hub/spaces-overview.md)), with about 5 GPU-minutes/day free (secondary source) ([eesel](https://www.eesel.ai/en/blog/hugging-face-pricing)) | 0.5–1 day |
| P4 | Binoculars or Fast-DetectGPT with a 7–8B pair | The authors say a Llama3-8B pair beats Falcon (vendor) ([fast-detect-gpt](https://github.com/baoguangsheng/fast-detect-gpt)). Zero-shot methods trail supervised ones (DetectRL multi-attack: Binoculars 85.05 vs RoBERTa 99.56) ([DetectRL](https://github.com/NLP2CT/DetectRL)) | Binoculars is BSD-3 and "not a consumer product"; Llama has its own licence | Modal T4 at about $0.59/hour, with $30/month of credits (via search) ([Modal](https://modal.com/pricing)). Or the authors' fastdetect.net API, whose uptime and terms are unverified | 2–3 days |

- **Do not host:**
  - DeBERTa-ConPara: false positives of 13–67% on academic prose, and its README says "Do not use this to accuse a student" ([ConPara](https://github.com/SES-Lab-OTH/deberta-conpara)).
  - Vanguard: 12/40 human texts above 0.5 ([SlopTotal eval](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/FINDINGS.md)).
  - mdok: 14B parameters.
  - EditLens: CC BY-NC-SA ([EditLens](https://github.com/pangramlabs/EditLens)). Use it only if the site stays personal and non-commercial; whether it is gated is unverified.
- **Wiring:**
  - The Worker route `/api/check/deep` forwards text with a shared token.
  - Server code in a Docker Space can hold that token. A static Space cannot: its variables are exposed to the browser ([HF static](https://raw.githubusercontent.com/huggingface/hub-docs/main/docs/hub/spaces-sdks-static.md)).
  - Show "waking up (up to a minute)" while the Space cold-starts.

---

## 4. Commercial and university detectors

### 4.1 Detectors with usable APIs

| Pri. | Service | API and auth | Price | Free tier | Browser/proxy | Granularity | Terms caveat | Independent evidence |
|---|---|---|---|---|---|---|---|---|
| **1** | **Pangram** | `POST https://text.external-api.pangram.com/task` with `x-api-key`; asynchronous, poll `GET /task/{id}`. Pass `model` explicitly: the SDK says callers must choose after 30 Sep 2026 ([pangram-sdk](https://pypi.org/project/pangram-sdk/)) | $0.05 per 100 words, about $0.25 per 500-word answer (vendor) ([Pangram 4](https://pangram.com/blog/introducing-pangram-4)). An older page said $0.10; confirm before budgeting | No free API tier; the web app gives 20 credits/day ([pricing](https://www.pangram.com/pricing)) | Proxy; CORS unknown | Overlapping 512-token windows labelled AI-Generated, AI-Assisted or Human Written, with `ai_assistance_score` and `is_humanized` ([SDK](https://pypi.org/project/pangram-sdk/)) | Licence is "internal professional use only", no resale ([ToS](https://www.pangram.com/terms-of-service)), so keep the site private to the owner | Epoch AI (July 2026): 0 false positives on 495 human passages ([Epoch](https://epoch.ai/data-insights/ai-detectors-false-negatives)). Human Detectors: TPR 98.7%, FPR 2.7% ([data](https://raw.githubusercontent.com/jenna-russell/human_detectors/main/human_detectors.json)). Karr et al.: fewer than 4% of AI texts humanized with Undetectable AI stayed flagged. Their 64–80% flag rate on LLM-refined human abstracts is unconfirmed as Pangram's figure ([arXiv](https://arxiv.org/html/2608.11256v2)) |
| **1** | **Sapling** | `POST https://api.sapling.ai/api/v1/aidetect`; key in the request body or as a Bearer token ([docs](https://sapling.ai/docs/api/detector/)) | $0.005 per 1,000 characters, about $0.015 per answer (est.); $5 one-time minimum ([pricing](https://sapling.ai/docs/api/pricing/)) | 50k characters/day and 250k/month; identical text is cached for 3 days and not re-billed | A browser SDK with short-lived JWTs is documented ([Sapling](https://sapling.ai/docs/sdk/JavaScript/frontend_key_management/)). Still use the proxy | Per-sentence scores with offsets | No resale without an agreement ([ToS](https://sapling.ai/tos)) | No 2025–26 independent test. The 2023 version flagged 68.1% of human TOEFL essays ([Liang](https://github.com/Weixin-Liang/ChatGPT-Detector-Bias)), which is stale |
| **2** | **GPTZero** | `POST https://api.gptzero.me/v2/predict/text` with `x-api-key` and `{document, version}`. GPTZero says the document-level field is `ai.classification.ai` ([GPTZero](https://gptzero.me/news/chicago-booth-2026/)) | From $45/month for 300k words; $150 per extra million ([developers](https://gptzero.me/developers)) | None for the API; academic researchers can ask ([ML page](https://gptzero.me/machine-learning)) | Proxy | Sentence-level (third-party docs; check against a live response). Classes include AI-paraphrased and Lightly edited by AI | Terms not retrieved; review before use | Epoch: 0 human false positives. Human Detectors: TPR 84.0%, FPR 0.7%, only 46.7% on humanized o1-pro text ([data](https://raw.githubusercontent.com/jenna-russell/human_detectors/main/human_detectors.json)). Chicago study: about 50% missed with humanizers, which GPTZero disputes ([NBER](https://www.nber.org/system/files/working_papers/w34223/w34223.pdf)) |
| 3 | Winston AI | `POST https://api.gowinston.ai/v2/ai-content-detection` with Bearer ([docs](https://docs.gowinston.ai/api-reference/v2/ai-content-detection/post)) | 1 credit per word; $18/month for 100k ([help](https://help.gowinston.ai/pricing/how-much-does-it-cost)) | 2,000 credits ([docs](https://docs.gowinston.ai/api-reference/introduction)) | Proxy | Per sentence; human-likelihood from 0 to 100. Minimum 300 characters, unreliable under 600 | Not retrieved | RAID 100.0% with attacks, but Winston ran its own detector on the test texts ([results.json](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/winston-ai/results.json)). No independent test found |
| 3 | Copyleaks | Login returns a token valid for 48 hours (cache it); then `POST /v2/writer-detector/{scanId}/check`, which is synchronous; `sandbox:true` returns free mock data; 255–100,000 characters ([docs](https://docs.copyleaks.com/reference/actions/writer-detector/check), [auth](https://docs.copyleaks.com/using-the-apis/authentication/)) | 1 credit = 250 words; API through sales ([pricing](https://copyleaks.com/pricing)) | Sandbox only | Proxy plus token cache | Sections with character offsets | "Non-commercial use as assessment tool for content integrity only"; no using outputs to train or improve other models ([ToS](https://copyleaks.com/termsofuse)) | Peer-reviewed IJEI 2026 study: caught 22.5% of humanised papers, reported 0% AI on human papers ([Springer](https://link.springer.com/article/10.1007/s40979-026-00226-w)) |
| 4 | Hive | Splits text into 2,048-character chunks ([docs](https://docs.thehive.ai/reference/ai-generated-text-detection-1)) | Price not found | Starter credits | Proxy | Per chunk | — | None |
| **Exclude** | Originality.ai | `X-OAI-API-KEY`, 500 requests/minute ([docs](https://docs.originality.ai/)) | $30 for 3,000 credits; the API may need the Enterprise plan | — | — | — | Bans using outputs to "test… or improve any… humanizer, writing assistant"; API keys can be disabled ([T&C](https://originality.ai/terms-and-conditions)) | Epoch: 3.8% false positives on human text ([Epoch](https://epoch.ai/data-insights/ai-detectors-false-negatives)) |
| **Exclude** | ZeroGPT | Official API unconfirmed; clone brands publish incompatible APIs ([zerogpt-net](https://github.com/zerogpt-net/zerogpt-api)) | — | — | — | — | — | Authors Guild test: 5–76% false positives ([The Decoder](https://the-decoder.com/authors-guild-test-finds-some-ai-detectors-perfectly-identify-human-writing-while-others-fail-on-every-single-text/)) |

### 4.2 Detectors that cannot be called at all
- **Turnitin.**
  - Sells no individual licences, and its Core API is limited to institutions and partners ([help](https://helpcenter.turnitin.com/hc/en-us/articles/27974736791565), [Core API](https://developers.turnitin.com/turnitin-core-api)).
  - Added AI-bypasser detection on 27 Aug 2025, English only ([press](https://www.turnitin.com/press/turnitin-expands-capabilities-amid-rising-threats-posed-by-ai-bypassers)).
  - On 4 Aug 2026 it replaced the two-colour report with one unified blue highlight that includes text "further modified by AI paraphrasers or bypassers". It released an improved English model on 14 Oct 2026 ([release notes](https://guides.turnitin.com/hc/en-us/articles/27251688507533-Turnitin-release-notes)).
  - Scores from 1% to 19% display as "*%" ([help](https://helpcenter.turnitin.com/hc/en-us/articles/46245332050317-Why-is-the-AI-Writing-Detection-report-score-showing-as)).
- **DrillBit.** UGC's ShodhShuddhi programme has offered DrillBit-Extreme since 1 Oct 2023 ([INFLIBNET](https://www.inflibnet.ac.in/downloads/brochure/shodhshuddhi.pdf)), with a separate AI report ([FAQ](https://shodhshuddhi.inflibnet.ac.in/faq.php)). No API for individuals was found, and its accuracy figures are the vendor's own.
- **Others:**
  - QuillBot/Scribbr: no public API found ([fast.io](https://fast.io/resources/quillbot-ai-detector-review/)).
  - Grammarly: the SDK was shut down in 2024 ([TechCrunch](https://techcrunch.com/2023/07/13/grammarly-to-shut-down-the-text-editor-sdk-in-january/)).
  - Writer.com: reportedly shut down in Dec 2025 ([Stork](https://www.stork.ai/en/writer-com-ai-content-detector)).
  - Crossplag: no API ([ToolChase](https://toolchase.com/tool/crossplag/)).
- **What Indian institutions use:**
  - IIM Calcutta licenses Turnitin with AI writing detection ([IIMC](https://library.iimcal.ac.in/turnitin-originality/)).
  - IIT Delhi's Turnitin subscription excludes AI detection ([IITD](https://etsc.iitd.ac.in/faq.html)).
  - No evidence was found for what HBS Online, Wharton, INSEAD or Emeritus use.
- **Best stand-in.** Pangram plus GPTZero: like Turnitin's unified highlight, both label AI-assisted and paraphrased text. No stand-in can match a specific institution:
  - On 150 human and 150 AI news articles, GPTZero and Pangram agree with κ 0.83 ([data](https://raw.githubusercontent.com/jenna-russell/human_detectors/main/human_detectors.json)).
  - On human TOEFL essays, the 2023 GPTZero and Originality versions agreed with κ of only 0.06 ([Liang data](https://github.com/Weixin-Liang/ChatGPT-Detector-Bias/tree/main/Data_and_Results/Human_Data)).
  - Label external scores "Pangram's opinion", never "Turnitin equivalent".
- **Watermark detectors: none can be called.**
  - The open-source SynthID tool only detects text marked with your own keys ([HF blog](https://raw.githubusercontent.com/huggingface/blog/main/synthid-text.md)).
  - Anthropic's detector is in private preview ([Anthropic](https://www.anthropic.com/news/claude-text-watermark)).
  - Do not ship a "watermark check".

### 4.3 Integration order
1. Sapling as an always-available second opinion within the free quota.
2. Pangram as an on-demand "final check" button.
3. GPTZero only if a $45/month floor is acceptable.
- Every external call goes through the proxy, needs an explicit per-check consent toggle because text leaves the browser, and runs **only outside the rewrite loop** (§5).

---

## 5. Rewriting pipeline design

### 5.1 What the evidence says
- **Surface edits fool perplexity-style detectors, not trained classifiers.** A rule-based humanizer's outputs passed Binoculars, yet GPTZero, Grammarly and Pangram still scored them 99–100% AI. The author ran these tests and gave no per-tool numbers ([harshaneel/humanize](https://github.com/harshaneel/humanize)).
- **Prompt humanizers fail on Pangram; the writer's own material holds up.** Prompt humanizers scored 2–4% human on Pangram 4. Emulate-1 reached 87% human but made 120 meaning changes, against 18 for work-humanizer. Text built from the writer's notes scored 100% human on 4 of 4 texts, with 0 invented facts across 56 rewrites. These are small tests run by the tool's builders ([work-humanizer](https://raw.githubusercontent.com/phuryn/work-humanizer/main/README.md)).
- **Polishing human text with an LLM raises flags.** On SlopBench, polished human text went from a median of 22 to 50.1, with 59.9% flagged; "humanized" AI text was still 75.8% flagged ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)).
- **Detector-guided paraphrasing transfers between detectors.** That is the authors' claim ([Adversarial-Paraphrasing](https://github.com/chengez/Adversarial-Paraphrasing)); the headline percentages are unverified. It is also exactly what commercial vendors now train against: Turnitin's bypasser detection and the unified highlight (§4.2).
- **Character tricks backfire.** Commercial detectors resist homoglyphs: Winston and GPTZero keep 98–100% on homoglyph-attacked text ([gptzero](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/gptzero/results.json), [winston](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/winston-ai/results.json)). Turnitin's automatic character replacement is unverified ([help](https://help.turnitin.com/ithenticate/user/the-similarity-report/flags.htm)).

### 5.2 Three modes, in order of safety
1. **Coach (default; generates no text).**
   - Highlights each flagged sentence and says why: tell words, "Furthermore/Moreover" openers, triads, uniform sentence length, em-dash density, "-ing" participial clauses and nominalisations.
   - The grammar multipliers from the PNAS study (2–5× participial clauses, 1.5–2× nominalisations) are unverified ([arXiv 2410.16107](https://arxiv.org/html/2410.16107v2)).
   - The author edits and scores update live. This adds no AI signal and cannot break facts.
2. **Interview.**
   - For each flagged paragraph, ask one or two questions: a concrete case from the author's lending or business experience, a number they know, their own view.
   - The rewrite may use **only** the facts the author supplied. Those facts are added to the guard's allow-list. This is the approach behind work-humanizer's 4/4 result.
3. **Minimal edit (opt-in).** The loop in §5.3.

### 5.3 Minimal-edit loop specification
1. **Normalise** the text as in §2.1, then split it into sentences. Leave quotations alone ([humanizer SKILL.md](https://raw.githubusercontent.com/blader/humanizer/main/SKILL.md)).
2. **Choose targets.** Use the existing flagged sentences, plus one sentence of context either side.
3. **Build the prompt.**
   - Frame the task as "edit for clarity in the author's voice; keep every fact, number, hedge and modal verb". The task framing is my recommendation.
   - Include 2–3 paragraphs of the owner's pre-2022 writing as style examples, the tell list to avoid, and the grammar targets.
   - Do not use assistant prefill: it returns a 400 error on models 4.6 and later ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview)).
4. **Generate 3–4 candidates by varying the prompt** (different style samples or emphasis). Temperature cannot be used: on Opus 5.5 the sampling parameters are removed, and on Sonnet 5.5 and Haiku 5.5 any non-default value returns a 400 ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview)).
5. **Guard gate.** Reject a candidate automatically if any check fails, and show the reason:
   - **Fact multiset match** (extraction with [compromise](https://github.com/spencermountain/compromise) plus regex). It must cover ₹, Rs., INR, lakh and crore, Indian digit grouping ("1,00,000"), %, bps, multiples ("x"), FY24 and FY2024-25, Q1–Q4, H1, dd/mm/yyyy, "March 2025", and acronyms such as RBI, NBFC, GNPA/NNPA, CRAR, LTV, ECL, PSL and MSME. Whether compromise parses lakh and crore is unconfirmed, so write explicit regexes.
   - **Negation and modal multiset match:** not, no, never, without; may, might, will, must, should, could.
   - **NLI entailment in both directions** using Xenova/nli-deberta-v3-xsmall ([HF](https://huggingface.co/Xenova/nli-deberta-v3-xsmall/tree/main)). Call it as a sentence-pair classifier, not through the zero-shot pipeline, which failed with "text_pair must also be an array" ([benchmark](https://huggingface.co/datasets/whitphx/transformersjs-performance-leaderboard-results/commit/74c8b04d0e5e606f6c7f761f953176b10e7d235c)). Starting thresholds (est., to be tuned): entailment ≥0.8, contradiction ≤0.1.
   - **Embedding similarity** ≥0.85 (est.).
   - **Token-edit ratio** ≤40% per sentence (est.).
   - **No new named entities, and no invisible or lookalike characters.**
6. **Select** the candidate with the lowest score from the **guide** detectors only: ModernBERT or Tabularis, BERT-tiny and the tells explainer.
7. **Validate** the whole answer with the **held-out** detectors: Fakespot, ZipPy and, if consented, Sapling. If the validators got worse while the guide detectors improved, warn about over-fitting ("Goodhart").
8. **Stop** at the target percentile, after 2–3 rounds per sentence, or after one round with no improvement.
9. **Review.** Show the word diff and require approval. Keep the original in version history. Run a paid external check, such as Pangram, only on the final draft.
10. **Optional fact audit.** One Haiku 5.5 call lists any dropped, changed or added claim, following work-humanizer's sentence-by-sentence audit ([work-humanizer](https://github.com/phuryn/work-humanizer)).

### 5.4 Which LLM, and cost per 500-word answer

Prices are from [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing); everything else is est.

| Item | Assumption (est.) | Cost |
|---|---|---|
| Sonnet 5.5 rewrite (**default**) | 12 calls (4 candidates × 3 rounds), each 3k input + 1k output tokens | ≈ $0.19 |
| Haiku 5.5 rewrite (cheap candidates) | Same | ≈ $0.01 |
| Haiku 5.5 fact audit | 1 call | < $0.001 |
| Sapling check | about 3k characters | ≈ $0.015, or free within the quota |
| Pangram final check | 500 words | $0.25 |
| GPTZero | Inside the $45 plan | ≈ $0.075 |

- Opus 5.5 ($4 / $20) is not needed.
- Prompt caching lowers input cost further: cache hits on Sonnet 5.5 cost $0.10 per million tokens.
- Batch mode is 50% off but asynchronous, so it does not suit interactive use.

### 5.5 Provenance and watermarks
- **Anthropic** (14 Aug 2026, updated 1 Sep) ([Anthropic](https://www.anthropic.com/news/claude-text-watermark)):
  - Text from future Claude models is watermarked "globally at launch". Models launched before 2 Aug 2026 get it over a transition period.
  - Light editing probably won't remove the mark; a complete rewrite will. Marks are sparse on factual passages and on light proofreading.
  - The post does not say explicitly whether API output is included.
  - Detection is in private preview for eligible organisations, which include educational organisations.
- **OpenAI** watermarks ChatGPT and Codex text in the EU only; on the API it is opt-in (secondary source) ([Techzine](https://www.techzine.eu/news/security/144764/openai-introduces-ai-watermark-for-texts-in-the-eu/)).
- **Gemini API:** whether output is watermarked is unresolved ([forum](https://discuss.ai.google.dev/t/does-gemini-api-text-output-carry-synthid-watermarking-gemini-2-5-flash-lite-gemini-3-1-flash-lite-eu-ai-act-art-50-2/177241)).
- **Decision:** disclose this in the UI next to the rewrite button. Do not pick a provider, or post-process text, in order to strip provenance marks.

### 5.6 What NOT to do
- No homoglyphs, zero-width characters, whitespace or spacing tricks (see §5.1).
- No round-trip translation chains, such as lynote's zh→ja→fi→en ([lynote](https://github.com/lynote-ai/humanize-text)).
- No recursive paraphrasing, base-model paraphrasers, or T5/BART/Pegasus paraphrasers. They drift on meaning and numbers, and none showed a detector benefit beyond weak self-reports.
- No whole-text "humanize" button. No model-invented "concrete details".
- No paid API inside the selection loop: because of Originality's terms, and to avoid over-fitting.
- No in-browser 1–3B rewriter as the default. They need 0.9–2.3 GB of VRAM through WebGPU ([web-llm config](https://raw.githubusercontent.com/mlc-ai/web-llm/main/src/config.ts)), and their rewriting quality is unmeasured.
- Never promise "undetectable".

---

## 6. Calibration and evaluation plan

### 6.1 Datasets

| Dataset | Use | Size | Licence | Source |
|---|---|---|---|---|
| MIRAGE (DIG/SIG: generate, **polish**, rewrite) | Closest public match to the user's case: human email and academic originals with versions polished by 17 LLMs, including Claude-3.7-Sonnet, GPT-4o and DeepSeek-R1 | About 94k pairs; Enron emails about 1.6k per task | Pi-Lab 1.0, **non-commercial** ([LICENSE](https://raw.githubusercontent.com/fjc2005/detectanyllm/main/LICENSE.txt)) | [data](https://github.com/fjc2005/detectanyllm/tree/main/data) |
| Human Detectors | External benchmark that includes GPTZero and Pangram verdicts plus humanized text | 300 | MIT | [repo](https://github.com/jenna-russell/human_detectors) |
| Liang TOEFL, Hewlett and college essays | False positives on non-native writing | 91 / 88 / 70 | MIT | [repo](https://github.com/Weixin-Liang/ChatGPT-Detector-Bias) |
| ELLIPSE | False positives on ESL writing (no first-language field; 70.7% Hispanic/Latino) | 3,911 in the train split | CC BY-NC-SA 4.0 | [repo](https://github.com/scrosseye/ELLIPSE-Corpus) |
| Beemo | Expert-edited and LLM-edited text | 6.5k + 13.1k | MIT | [repo](https://github.com/Toloka/beemo) |
| RAID `train_none` plus attacks | Regression test for attack robustness | 802 MB CSV | Code MIT; data licence not stated | [RAID](https://github.com/liamdugan/raid) |
| WildAI | Large set of Pangram-labelled web documents for fitting a stand-in. Candidates were preselected by EditLens, so borderline text is under-represented | 96M | CC BY-NC-SA 4.0 | [repo](https://github.com/pangramlabs/WildAI) |
| EDGAR-CORPUS | Formal business human text from before LLMs | Large | Check | [edgar-crawler](https://github.com/nlpaueb/edgar-crawler) |
| **Owner corpus (build this)** | Human negatives in the right register: the owner's pre-Nov-2022 answers, reports and emails, plus consented colleague texts. AI positives: the owner's own questions answered by Claude, GPT, Gemini, DeepSeek and Qwen, plus LLM-polished versions of the owner's human answers | Target 1,000–1,500 human; a few hundred AI per model family (est.) | Private | — |

No AI-detection dataset built on Indian English was found. Details on ICNALE and TOEFL11 are unverified.

### 6.2 Controlling false positives on Indian and non-native English
- **Evidence of the problem:**
  - In 2023, seven detectors flagged 61.2% of 91 human TOEFL essays on average, and 97.8% were flagged by at least one. Recomputed from the authors' data ([Liang](https://github.com/Weixin-Liang/ChatGPT-Detector-Bias)).
  - On SlopBench, TOEFL essays were 34% flagged before calibration and 26% after; 22% were called "Likely AI" before and 15% after, against 0 of 88 US essays ([SlopBench](https://raw.githubusercontent.com/pablocaeg/sloptotal/master/tests/eval/slopbench/FINDINGS.md)).
  - A 2026 study of 13 detectors on non-native manuscripts reporting 0–100% false-positive rates is unverified ([arXiv 2608.26710](https://arxiv.org/abs/2608.26710)).
  - In a new domain, MAGE kept only 38.05% of human texts as human ([MAGE](https://github.com/yafuly/MAGE)).
- **Controls:**
  - Calibrate separately per group (Mondrian calibration): Indian-English professional, generic professional, ESL/essay, crossed with length bands (<150, 150–400, >400 words).
  - Report the false-positive rate of the worst group.
  - Never show a "Likely AI" verdict for a group whose calibration set has fewer than about 300 texts (est.).

### 6.3 Method
- **Per detector:** a one-class conformal p-value, p = (1 + #{human scores ≥ s}) / (n + 1). This is effectively what the project already does with percentiles.
- **Combining:** non-negative logistic stacking on [logit(p_i), log length], with cross-validation, as SlopTotal does ([SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)).
- **Then set the combined score's own conformal threshold** on held-out human texts. Use Platt scaling only for the displayed number; isotonic regression needs more than about 1,000 points.
- **Why calibrate in-domain:** RAID's thresholds are fitted per domain. ModernBERT's 1%-FPR threshold ranges from 0.054 (recipes) to 0.96 (books), so headline scores do not transfer to a new domain ([results.json](https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/modernbert/results.json)).
- **Parity checks:** int8 against fp32, and WASM against WebGPU. Each must stay within 1 percentile point on the calibration set; otherwise recalibrate.

### 6.4 Metrics and sample sizes
- **What to report:**
  - TPR at 1% and 5% FPR, per model family and per task (generate, polish, rewrite, humanized).
  - AUROC.
  - False-positive rate of the worst group.
  - Agreement and κ with Pangram on a held-out set.
  - Exact Clopper–Pearson confidence intervals throughout.
- **Sample sizes** (my calculations, confirmed in the fact-check):
  - The project's ~6.5% held-out false-positive rate, if it is 10 of 150, has a 95% interval of 3.2–11.9%.
  - A conformal 1% threshold set on 299 human texts realises a 0.27–2.09% false-positive rate (90% band). With 1,000 texts the band is 0.54–1.57%.
  - Holding a 1% rate to ±0.5% needs 1,522 texts.
- **Recalibrate** whenever a model, its quantisation, the backend or the mix of generating models changes.

### 6.5 Release gate (proposed; set the targets with the owner)
- On the Indian-professional group with at least 150 words, the "Likely AI" false-positive rate is at most 5%, and the upper end of its interval is at most 8%.
- On fresh raw 2026 AI text, TPR is at least 90%.
- On MIRAGE "polish", report the TPR honestly rather than optimising for it.

---

## 7. Deployment architecture

### 7.1 Decision: one Cloudflare Worker with static assets
- Cloudflare's guidance is "Start new projects with Workers" ([CF](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/partials/pages/workers-for-new-projects.mdx)).
- Limits on the free plan ([limits](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/platform/limits.mdx)):
  - 25 MiB per asset file; 20,000 files per version.
  - 100,000 Worker requests/day.
  - 10 ms of CPU per request. Time spent waiting on `fetch()` does not count, so an LLM proxy fits.
- Static asset requests are free and unlimited. With `run_worker_first`, matching requests always invoke the Worker and get 429 once over the free limit ([billing](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/static-assets/billing-and-limitations.mdx)). So set `run_worker_first: ["/api/*"]` only, and quota exhaustion can never take down the static site.

```
Browser ──GET / , /app/*───────────────▶ static assets (free, unlimited)
        ──GET /models/v3/*.part ────────▶ static assets, ≤14 MiB each, immutable
        ──GET /ort/*.wasm ──────────────▶ static assets
        ──POST /api/* + passphrase ─────▶ Worker code
                                           ├─ /api/rewrite        → Anthropic (secret key)
                                           ├─ /api/check/sapling  → Sapling
                                           ├─ /api/check/pangram  → Pangram (poll)
                                           └─ /api/check/deep     → HF Docker Space (shared token)
```

### 7.2 Hosting the models
- Commit the parts (each ≤14 MiB) as plain Git files; no LFS needed. GitHub warns above 50 MiB and blocks above 100 MiB ([GitHub](https://raw.githubusercontent.com/github/docs/main/data/variables/large_files.yml)).
- Use versioned paths such as `/models/v3/…` and set `Cache-Control: public, max-age=31556952, immutable` in `_headers` ([CF headers](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/static-assets/headers.mdx)).
- Keep the SHA-256 manifest. Name the Cache Storage after the version and delete old caches on startup.
- Call `navigator.storage.persist()`.
- Safari deletes all script-created data for an origin after 7 days of browser use without interaction with it ([MDN](https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/storage_api/storage_quotas_and_eviction_criteria/index.md)). Show "first visit after a week re-downloads".

### 7.3 Runtime performance
- **Multithreading (do first).**
  - ONNX Runtime uses `min(hardwareConcurrency/2, 4)` threads, but only when the page is cross-origin isolated ([ORT env flags](https://raw.githubusercontent.com/microsoft/onnxruntime/gh-pages/docs/tutorials/web/env-flags-and-session-options.md)).
  - Set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` in `_headers`. Use `require-corp` because Safari lacks `credentialless` ([MDN BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/http/headers/Cross-Origin-Embedder-Policy.json)).
  - Self-host the fonts.
  - Do not use coi-serviceworker: last release 0.1.7 in 2023, it reloads the page and intercepts every fetch ([npm](https://registry.npmjs.org/coi-serviceworker), [README](https://raw.githubusercontent.com/gzuidhof/coi-serviceworker/master/README.md)).
  - Skip Turnstile: whether it works under COEP is untested.
  - The real speedup is unmeasured.
- **WebGPU (later).**
  - Support: Chrome 113+, Chrome Android 121, Safari 26, Firefox 141 partial ([MDN GPU](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/GPU.json)). ONNX Runtime 1.30's own README still marks Safari and Firefox WebGPU as unsupported ([README](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/js/web/README.md)), so test on real devices.
  - First list the op types in each `.onnx` file. MatMulNBits runs on WebGPU in 1.30 with 2-, 4- or 8-bit weights; the fast wide-tile path handles only 4 and 8 bits ([matmul_nbits.h](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/onnxruntime/contrib_ops/webgpu/quantization/matmul_nbits.h)). MatMulInteger and DynamicQuantizeLinear are not supported, so those nodes fall back to the CPU ([op table](https://raw.githubusercontent.com/microsoft/onnxruntime/main/js/web/docs/webgpu-operators.md)).
  - The 1.22 kernel still had a "TODO" for bit widths other than 4 ([1.22](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.22.0/js/web/lib/wasm/jsep/webgpu/ops/matmulnbits.ts)), so WebGPU needs the upgrade.
- **Upgrading to ONNX Runtime 1.30.** The asyncify wasm (26.78 MB) and the jsep wasm (28.31 MB) both exceed 25 MiB. Three options:
  1. Split the file into parts and pass the bytes through `env.wasm.wasmBinary`. The `.mjs` glue file still loads via `wasmPaths` unless a bundle build is used ([env.ts](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/js/common/lib/env.ts)).
  2. Use the JSPI build (16.76 MB). Browser support for JSPI was not checked.
  3. Use the CPU-only wasm (14.2 MB) ([tarball](https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz)).
  - Always keep the WASM fallback, and catch errors at session creation.
- **Stay on raw onnxruntime-web rather than switching to transformers.js 4.3.1.** transformers.js defaults to loading wasm from jsDelivr and pins a dev build of ORT ([onnx.js](https://raw.githubusercontent.com/huggingface/transformers.js/main/packages/transformers/src/backends/onnx.js), [npm](https://registry.npmjs.org/@huggingface/transformers)).

### 7.4 Keys, privacy and abuse control
- **Secrets** go in **Workers & Pages → Worker → Settings → Variables and Secrets → Type: Secret** ([CF secrets](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/configuration/secrets.mdx)).
- **Access:** a passphrase stored as `ACCESS_CODE`, compared in constant time, plus a check of the `Origin` header.
- **Rate limiting:** use the rate-limit binding keyed on a hash of the passphrase. Its period must be 10 or 60 seconds; it is local to each location and eventually consistent; its docs advise against keying on IP ([rate-limit](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/runtime-apis/bindings/rate-limit.mdx)). Whether it works on the Free plan is unconfirmed.
- **Request limits:** a model allowlist, a cap on `max_tokens`, and a cap on request size.
- **Logging:**
  - Workers Logs are **on by default**, kept 3 days on Free and 7 on Paid. Set `observability.enabled: false` and never log the user's text ([logs](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/observability/logs/workers-logs.mdx)).
  - If AI Gateway is used, its logs are also on by default; send `cf-aig-collect-log-payload: false` ([AI Gateway](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/ai-gateway/observability/logging/index.mdx)).
- **The real cost backstop is a spending limit at each provider.** Anthropic's and Pangram's console limits were not verified in this session.
- **Optional bring-your-own-key:**
  - The key lives in memory or `sessionStorage` only.
  - It is sent with the `anthropic-dangerous-direct-browser-access` header.
  - Anthropic calls this acceptable only for internal tools or short-lived keys ([TS SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)).

### 7.5 Testing and monitoring
- **Smoke test.** Playwright 1.64.1 ([npm](https://registry.npmjs.org/@playwright/test)) in GitHub Actions ([ci-intro](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/ci-intro.md)), run on every deploy and on a `17 */6 * * *` schedule. It checks:
  - the manifest returns 200 with the expected SHA-256 values;
  - BERT-tiny scores a fixed AI text and a fixed human text into the expected bands;
  - `/api/rewrite` works with a test passphrase;
  - the fact guard holds on a sample containing numbers.
- **Actions limits.** Actions is free for public repos ([billing](https://raw.githubusercontent.com/github/docs/main/content/billing/concepts/product-billing/github-actions.md)). Scheduled runs can be delayed or dropped, and are **disabled after 60 days without repository activity** in public repos ([GitHub](https://raw.githubusercontent.com/github/docs/main/content/actions/reference/workflows-and-actions/events-that-trigger-workflows.md)).
- **Rollback:** Workers Builds keeps version history and preview URLs ([Builds](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/ci-cd/builds/index.mdx)).
- **In-page self-test button** that runs the same checks.

### 7.6 Steps the owner must take (about 15–30 minutes, no terminal; est.)
1. Create a free Cloudflare account and verify the email.
2. Get the repository into your account, by one of two routes:
   - Click the "Deploy to Cloudflare" button in the README. It clones the repo into your GitHub account and builds it. The source repo **must be public** ([deploy buttons](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/platform/deploy-buttons.mdx)).
   - If the code must stay private: **Workers & Pages → Create → Import a repository**. For an existing Worker: **Settings → Builds → Connect** ([Builds](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/ci-cd/builds/index.mdx)).
3. Add the secrets `ANTHROPIC_API_KEY`, `ACCESS_CODE` and, optionally, `PANGRAM_API_KEY`, `SAPLING_API_KEY` and `DEEP_CHECK_TOKEN`. Set each one's type to Secret.
4. Set monthly spending caps in the Anthropic and Pangram consoles.
5. Open the `*.workers.dev` address on your **work laptop** and press the self-test button. Corporate filters may block `workers.dev`; this is unverified. If they do, add a custom domain under **Settings → Domains & Routes**.
6. Optional, for the server tier: get Hugging Face PRO, then duplicate the prepared Docker Space and paste the same `DEEP_CHECK_TOKEN`.
7. Every month: check that the GitHub "smoke" workflow is still enabled, and look at the Deployments page. To roll back, choose the previous version there.

### 7.7 Alternatives considered
- **GitHub Pages (current):**
  - Soft limit of 100 GB/month bandwidth, which is about 460 first-time desktop loads (est.).
  - No custom headers, so no multithreading. No secrets.
  - Not allowed as free hosting for commercial SaaS ([limits](https://raw.githubusercontent.com/github/docs/main/content/pages/getting-started-with-github-pages/github-pages-limits.md)).
- **Hugging Face Static Space:** can set COOP and COEP headers ([config](https://raw.githubusercontent.com/huggingface/hub-docs/main/docs/hub/spaces-config-reference.md)), but its variables are public, so it cannot hold a secret.
- **Vercel or Netlify:** limits unverified this session.

---

## 8. Reusable open-source projects and assets

| Asset | Licence | Reuse for | Caveat |
|---|---|---|---|
| [SlopTotal](https://github.com/pablocaeg/sloptotal) | MIT | Server tier, the SlopBench evaluation harness, the ensemble-fitting method, the structural engine | Single developer; licences of bundled models vary |
| [raid-bench 0.2.0](https://pypi.org/pypi/raid-bench/json) | MIT | Evaluating the ensemble on RAID including attacks | RAID favours RAID-trained models |
| [blader/humanizer](https://raw.githubusercontent.com/blader/humanizer/main/SKILL.md) | MIT | 26 patterns, an AI-vocabulary list, and the mark → draft → check → final workflow with a "no added facts" rule | It does not get past detectors |
| [stop-slop](https://raw.githubusercontent.com/hardikpandya/stop-slop/main/README.md) | MIT | Business jargon and structure rules; a 5-part rubric scored out of 50 | Over-triggers if applied naively |
| [berenslab/llm-excess-vocab](https://raw.githubusercontent.com/berenslab/llm-excess-vocab/main/results/excess_words.csv) | MIT | 407 "style" excess words | Built from biomedical abstracts |
| [slop-score](https://github.com/sam-paech/slop-score) / [slop-forensics](https://github.com/sam-paech/slop-forensics) | MIT, plus Apache-2.0 and CC-BY-SA data files | Browser JavaScript scorer; regenerating word lists for the business domain | Built for creative writing |
| [phuryn/work-humanizer](https://github.com/phuryn/work-humanizer) | MIT | Interview mode, claim-strength rules, fact audit, the `check.py` tell scanner | Small tests run by its builders |
| [compromise](https://registry.npmjs.org/compromise) / [jsdiff](https://registry.npmjs.org/diff) / [text-readability](https://registry.npmjs.org/text-readability) | MIT / BSD-3 / ISC | Extracting facts, word diffs, readability change | Lakh/crore parsing unconfirmed |
| [DeBERTa-ConPara preprocessing](https://github.com/SES-Lab-OTH/deberta-conpara) | MIT | Homoglyph mapping table | — |
| [MIRAGE](https://github.com/fjc2005/detectanyllm), [Human Detectors](https://github.com/jenna-russell/human_detectors), [Liang data](https://github.com/Weixin-Liang/ChatGPT-Detector-Bias), [Beemo](https://github.com/Toloka/beemo) | NC / MIT / MIT / MIT | Calibration and evaluation | MIRAGE is non-commercial |
| [LLM-DetectAIve](https://github.com/mbzuai-nlp/LLM-DetectAIve) | Not shown | Idea for four labels (human / AI / humanized AI / human polished by AI) | Ideas only |
| [Adversarial-Paraphrasing](https://github.com/chengez/Adversarial-Paraphrasing) | Apache-2.0 | Idea of separating the guide classifier from the deploy classifier | Ideas only; framed as an attack |
| **Do not reuse:** [detect-law](https://github.com/devkancheti4-design/detect-law) (no licence), [DivEye](https://github.com/IBM/diveye) and [EditLens](https://github.com/pangramlabs/EditLens) (non-commercial), [antislop lists](https://github.com/sam-paech/antislop-sampler) (fiction-heavy), translation-chain humanizers | — | — | — |

---

## 9. Risks, limits and honest caveats

- **No pass can be guaranteed.**
  - Turnitin's unified highlight counts bypasser-modified text as AI ([release notes](https://guides.turnitin.com/hc/en-us/articles/27251688507533-Turnitin-release-notes)).
  - Pangram claims 98.83% detection on humanized text (vendor) ([Pangram 4](https://pangram.com/blog/introducing-pangram-4)).
  - Independent results swing widely ([Karr et al.](https://arxiv.org/html/2608.11256v2)).
- **Rewriting genuinely human answers can raise scores.** In Karr et al., honest AI-editing carried a higher sanction risk than evasion with a humanizer ([Karr](https://arxiv.org/html/2608.11256v2)). This is why Coach mode is the default.
- **Academic integrity.** If a programme forbids AI help, LLM rewriting may break its rules whatever the detectors say, and Claude's watermark can reveal Claude involvement to institutions in the preview programme ([Anthropic](https://www.anthropic.com/news/claude-text-watermark)). Position the tool as fixing false flags on the owner's own writing, with disclosure.
- **Terms of service:**
  - Originality forbids this use case outright.
  - Pangram allows internal professional use only.
  - Copyleaks allows only non-commercial content-integrity assessment.
  - Sapling allows no resale. Keep the site to the owner.
- **Bias against the user's writing style.** Formal, non-native-influenced prose is the group most at risk ([Liang](https://github.com/Weixin-Liang/ChatGPT-Detector-Bias), [SlopBench](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md)). No Indian-English evidence exists for any detector.
- **Benchmark limits:**
  - RAID is saturated and many leaders trained on it.
  - SlopBench's model mix is uneven, with only 3 Claude samples ([README](https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/README.md)).
  - Commercial RAID scores are self-reported predictions with per-domain thresholds.
- **Unverified items** (Hugging Face was unreachable):
  - Licences of ModernBERT-raid-mage, Tabularis, Earlybird, Desklib and SuperAnnotate.
  - All Hugging Face ONNX sizes.
  - Whether the e5 field in Human Detectors is the same checkpoint the project uses.
- **Stale dependencies:** Fakespot's repo has been frozen since February 2025; coi-serviceworker since 2023; ORT is three minor versions behind.
- **Privacy.** External checks send text off-device, which contradicts the current "private by design" README promise. Every external call needs per-call consent, and the UI must say so.
- **Platform uncertainties:**
  - iOS memory limits.
  - Corporate blocking of `workers.dev`.
  - Whether the rate-limit binding works on the Free plan.
  - Turnstile under COEP.
  - Vercel and Netlify limits.
  - Whether Pangram 4 became the default model after 30 Sep 2026.
- **Research limits:** much of the vendor and paper detail came from search summaries. These are unverified: the Adversarial Paraphrasing and ARB percentages, the PNAS grammar multipliers, GPTZero's 95% bypass claim, and the claim that base-model output is labelled human.

---

## 10. Prioritised roadmap

Efforts are estimates.

| Phase | Scope | Effort | Done when |
|---|---|---|---|
| **0. Correctness fixes** | Confusables map, format-character strip and NFKC on input and output; length gates; e5 chunking and orientation test; tells explainer; honest UI copy ("indicative, not Turnitin") | 1–2 days | Homoglyph and zero-width regression tests pass; e5 orientation test passes |
| **1. Website and rewrite API** | Move to Cloudflare Workers (assets plus `/api/rewrite`); secrets; passphrase; rate limit; observability off; COOP/COEP threads; Playwright smoke test; owner runbook | 3–4 days | Owner deploys alone; smoke test green on the live address; spending caps set |
| **2. Safer rewriting** | Coach, Interview and Minimal-edit modes; the full guard gate (Indian-finance fact guard, NLI, similarity, edit cap); guide/validator split; stop rules; Haiku fact audit | 4–6 days | 0 fact changes on a 50-answer test set; every rejection shows a reason |
| **3. Better detectors and calibration** | Convert Fakespot (check against fp32); A/B Tabularis; build the owner corpus; non-negative logistic stacking; per-group calibration; confidence-interval reports | 5–8 days, plus the owner's time collecting texts | Release gate in §6.5 met, or gaps documented |
| **4. External checks** | Sapling and Pangram (plus GPTZero if wanted) through the proxy, with consent; a report of agreement and κ against the local ensemble | 2–3 days | Per-service toggles; cost per check shown |
| **5. Server tier** | SlopTotal Docker or a Gradient endpoint on a Hugging Face Space; `/api/check/deep`; cold-start UX | 2–3 days, plus about $9/month | Gradient or SlopTotal scores land on the 2026 test set |
| **6. Optional performance and experiments** | ORT 1.30 plus WebGPU (op audit, wasm split, parity); SmolLM2 zero-shot; Earlybird | 1–2 weeks | Each item kept only if it shows a measured gain |
| **Ongoing** | Monthly: Turnitin release notes, Pangram and GPTZero model changes, refreshed 2026 AI samples, recalibration after any model or backend change, re-enable the scheduled workflow | ~2 hours/month | — |

---

# Reviewer corrections and additions

## Review of the decision report: corrections and additions (2026-10-17)

The web-search budget was used up, so I checked claims by fetching primary pages directly. huggingface.co, pangram.com, gptzero.me and privacy.claude.com could not be reached, so the Hugging Face model licences and the Pangram and GPTZero terms are still unverified.

### (a) Claims the sources contradict, or that contradict each other
1. **The ModernBERT checkpoint caveat is wrong.** RAID's ModernBERT entry points to `GeorgeDrayson/modernbert-ai-detection-raid-mage`, which is the project's own checkpoint. Its 94.1% (with attacks) and 99.1% (without) therefore apply. Remove the "may be a different checkpoint" note from §2.2. The only real oddity is that the contact address (blinkdevelopers@gmail.com) does not look like the author's. https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/modernbert/metadata.json
2. **The report contradicts itself on paid APIs in the loop.** §4.3 says external calls run "only outside the rewrite loop" and §5.6 says "no paid API inside the selection loop". Yet §5.3 step 7 checks every round with Sapling. Fix: validate each round with Fakespot and ZipPy only, and run Sapling on the final draft. Sapling's terms also bar building a competing product, and Sapling is itself a writing assistant. https://sapling.ai/tos
3. **The held-out validator can leak into selection.** §5.3 step 8 stops "at the target percentile" but does not say which score. If that score is the displayed ensemble, which includes Fakespot, then Fakespot is no longer held out. Base the stop target on the guide detectors only, matching the guidance/deploy split in Adversarial-Paraphrasing. https://github.com/chengez/Adversarial-Paraphrasing
4. **"Keep ModernBERT" has no 2026 evidence behind it.** SlopBench lists 14 engines with AUCs, and none of them is a ModernBERT model (neither Drayson's nor Tabularis) or ZipPy. Both ModernBERT models are trained on RAID data. The other RAID-trained engines collapsed on 2026 text: TMR 0.749, e5 0.721, BERT-tiny 0.654. Say this in §1, and make a 2026-text test of ModernBERT and Tabularis a release blocker, not just an A/B test. https://github.com/pablocaeg/sloptotal/blob/master/tests/eval/slopbench/FINDINGS.md
5. **The Structural Analysis engine is weaker than its weight suggests.** Its 0.41 weight is its share of the fitted ensemble; on its own it scores only AUC 0.755.
   - It is 7 standard-library heuristics. Colon density and "Term: explanation" lines carry 0.30 each, and bullet density 0.12.
   - Structured executive answers will trigger those heuristics.
   - Porting it is trivial because it has no dependencies. Until it is refit on the owner's texts, show it as an explainer rather than a high-weight vote.
   - https://raw.githubusercontent.com/pablocaeg/sloptotal/master/app/engines/structural.py

### (b) Important options the report left out
6. **SlopTotal is easier to use than §3 assumes.**
   - It ships a prebuilt image, `ghcr.io/pablocaeg/sloptotal`.
   - It has REST endpoints: `/api/analyze` (2–8 s on CPU), `/api/quick-score` (4 classifiers, 0.1–0.5 s) and `/api/paragraph-score` (per-paragraph heat map, which suits the flagged-text UI).
   - The README's "Standard" hardware is 8 GB RAM and 4 cores. HF CPU Basic (2 vCPU) is "Lite" level, so expect slower checks.
   - There is also a public instance at sloptotal.com. Do not send the owner's text there, because its terms and privacy are unknown.
   - `THIRD_PARTY_LICENSES.md` lists no model licences. It does list trafilatura under GPL-3.0, which is fine for private hosting.
   - https://github.com/pablocaeg/sloptotal and https://raw.githubusercontent.com/pablocaeg/sloptotal/master/docs/THIRD_PARTY_LICENSES.md
7. **Cloudflare Containers could replace HF PRO for the server tier.**
   - It needs Workers Paid at $5/month, which includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk.
   - Custom instances go up to 4 vCPU, 12 GiB RAM and 20 GB disk.
   - It is billed only while running and sleeps after idle.
   - Everything stays in one account and one bill, with no second provider's token to manage. Cold-start and model-load time still need measuring.
   - https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/containers/platform/pricing.mdx and https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/containers/platform/limits.mdx
8. **Fast AI Detector's "contrast" mode is a missing small candidate.** It is a distilled model of about 40M parameters. On the Pangram benchmark it reaches 78.6% TPR at 5% FPR, against 64.7% for its raid-finetune mode. It is the only small, non-RAID-tuned model with an out-of-distribution score. It has no stated licence and no ONNX export, so ask the author before adopting it. https://github.com/Ejhfast/fast-ai-detector
9. **SlopTotal's own code is more evidence for dropping e5.** It loads the same MayZhou checkpoint, detects the AI label automatically, scores 510-token windows with a 256-token stride and averages them, and still gets AUC 0.721. So e5's weakness is not a truncation or label-orientation artifact. Reuse that windowing for Fakespot. https://raw.githubusercontent.com/pablocaeg/sloptotal/master/app/engines/classifier_e5.py
10. **Turnitin Clarity is missing from §4.2 and §9.**
    - It is a writing space that records process evidence: a revision timeline and paste indicators.
    - It went generally available in July 2025 and added customisable AI settings in May 2026.
    - If a programme requires writing in Clarity, text pasted in from the Desk is visible whatever the detector scores say.
    - https://www.plagiarismtoday.com/2025/03/06/turnitin-announces-clarity-aim-to-make-student-writing-more-transparent/ and https://in.turnitin.com/press/turnitin-delivers-turnitin-clarity
11. **Trinka is an Indian vendor worth checking.** It belongs to Crimson Interactive and self-submitted 99.8% on RAID (2026-05-26). Check whether it offers an API before leaving it out. https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/trinka/metadata.json
12. **HC3's finance split is missing from §6.1.** It contains FiQA human finance answers, the only public finance-domain human/AI pairs. Its ChatGPT side is from January 2023, so use it mainly for extra in-register human texts. https://github.com/Hello-SimpleAI/chatgpt-comparison-detection
13. **Zero-cost manual checks would widen coverage.** Add "copy and open in Pangram / GPTZero / QuillBot web" buttons. Pangram's free web plan gives 20 credits a day, and manual use raises no API-terms questions. https://www.pangram.com/pricing

### (c) Recommendations that are infeasible or fragile for a browser or a non-developer owner
14. **The Deploy button makes a one-off copy.** Cloudflare's docs say it "clones" the repo, which reads as an independent copy, not a fork, and they describe no way to sync with the source. They also do not say whether the new repo can be private. Document how the owner receives future fixes, for example the developer opens pull requests into the owner's repo. https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/platform/deploy-buttons.mdx
15. **Committing model parts to Git will bloat the repo.** Every model version stays in Git history permanently: the 160 MB ModernBERT, the ~125 MB Fakespot, the Tabularis A/B, and any re-quantisation. GitHub recommends staying under 1 GB and strongly under 5 GB, and cleaning history requires `git filter-repo`. Use a separate models repo or R2. https://raw.githubusercontent.com/github/docs/main/content/repositories/working-with-files/managing-large-files/about-large-files-on-github.md
16. **The 290 MB download estimate is too low.**
    - It leaves out the guard models. NLI deberta-v3-xsmall alone has an 8.66 MB tokenizer plus a 2.46 MB spm file, and its model size is unverified. The embedding model and the ORT wasm are also missing.
    - Sessions running in one worker share one WASM heap, capped at 4 GB. Add all of this to the budget and to the phone gate.
    - https://raw.githubusercontent.com/microsoft/onnxruntime/gh-pages/docs/tutorials/web/large-models.md
17. **The SmolLM2 size is for the wrong format.** q4f16 is a WebGPU format, and ORT advises against fp16 on CPU because it is slow. On WASM, use int8 weights; the 118 MB size will not hold. https://raw.githubusercontent.com/microsoft/onnxruntime/gh-pages/docs/tutorials/web/performance-diagnosis.md
18. **1,000–1,500 owner texts is unrealistic for one executive.** Collecting them also risks exposing confidential lending documents.
    - Plan for roughly 150–300 owner texts and report honestly wide intervals.
    - Top up the human side with MIRAGE's Enron originals (about 1.6k per task) and EDGAR filings.
    - Never use the same texts both as style examples in prompts and as calibration negatives.
    - https://github.com/fjc2005/detectanyllm/tree/main/data
19. **The smoke test has hidden requirements.** It needs `ACCESS_CODE` stored as a GitHub Actions secret, and it calls a paid API four times a day. If the owner's repo is private, Actions time counts against the plan's included minutes, because Actions is free only for public repos. https://raw.githubusercontent.com/github/docs/main/content/billing/concepts/product-billing/github-actions.md

### (d) Missing costs, licences and risks
20. **Thinking tokens are missing from the cost estimate.**
    - On Sonnet 5.5, adaptive thinking is on by default at effort `high`. `thinking:{type:"disabled"}` returns a 400 error. The lowest setting is `between_tools`, allowed at effort low, medium or high.
    - The $0.19 estimate assumes no thinking. Send `between_tools` with low or medium effort, and record output tokens in tests.
    - On Haiku 5.5, leave out the sampling parameters entirely.
    - https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5
21. **Refusals need handling.** A declined request returns HTTP 200 with `stop_reason:"refusal"` and a `stop_details` category. The proxy and the guard must count it as a failed candidate, not an empty rewrite. Prompts framed as "make this undetectable" invite a `general_harms` decline. Same source as item 20.
22. **The caching costs are incomplete.**
    - On Sonnet 5.5 a 5-minute cache write costs $2.50 per million tokens (1.25× base input), and cache reads cost $0.10.
    - The minimum cacheable prompt is 512 tokens.
    - Put the style samples and the tell list in a shared cached system prefix of at least 512 tokens.
    - https://platform.claude.com/docs/en/models/sonnet-5-5/overview
23. **The Anthropic spend cap is verified, and the report says it was not.**
    - It is set at Console, Billing, Spend limits, Set limit. Over the limit, requests get HTTP 400 `invalid_request_error`.
    - The tier cap is different: it returns 429 with no `retry-after` header.
    - New organisations may start on a lower "Evaluation" tier.
    - The Worker should turn each case into a clear message.
    - https://platform.claude.com/docs/en/api/rate-limits
24. **The privacy copy should cover rewrite data.** Prompts and outputs are not retained by default, except for "Covered Models" (Fable and Mythos, which keep 30 days). Flagged content may be kept for up to 2 years. Allow only the 5.5 Sonnet and Haiku models in the proxy. https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention
25. **Pangram's terms carry more risk than the report says.**
    - The research notes' extract says §10 bars access "by tools other than Pangram's own software". The report omits this.
    - Personal academic submissions may not count as "internal professional use".
    - Verify both before building. Until a console cap is confirmed, buy credits without auto-refill.
    - https://www.pangram.com/terms-of-service and https://www.pangram.com/knowledge-hub/what-is-pangrams-developers-plan
26. **Tabularis has provenance gaps.** Its licence is unverified and it has no paper or GitHub. The RAID entry is "R1.1 (NFKC)", so its score assumes NFKC preprocessing, and the current HF revision may differ from what was tested. Pin the HF revision before the A/B. https://raw.githubusercontent.com/liamdugan/raid/main/leaderboard/submissions/tabularis-modernbert-r1/metadata.json

### (e) Stale items, or items now resolvable
27. **The default rewriters should be treated as watermarked.** Sonnet 5.5 was released 2026-09-28 and Haiku 5.5 on 2026-10-07, both after 2 Aug 2026. They are therefore not covered by the transition period, and Anthropic says it applies watermarking "globally at launch". The post still does not name the API explicitly. https://platform.claude.com/docs/en/models/sonnet-5-5/overview, https://platform.claude.com/docs/en/models/haiku-5-5/overview and https://www.anthropic.com/news/claude-text-watermark
28. **JSPI support is now known.** MDN lists JSPI in Chrome and Edge 137, Firefox 153 and Safari/iOS 27. So the 16.76 MB JSPI build is a valid ORT 1.30 upgrade route; users on Safari or iOS 26 still need the fallback. https://raw.githubusercontent.com/mdn/browser-compat-data/main/webassembly/jspi.json
29. **Several cited evaluations predate the current models.** All three predate GPTZero 4o (2026-09-24), so their GPTZero numbers are possibly stale:
    - the Chicago study (Aug 2025), including GPTZero missing about 50% with humanizers;
    - Human Detectors, which used GPTZero version 2025-01-09;
    - Epoch AI (July 2026).

    Chicago and Human Detectors also predate Pangram 4 (2026-07-29). Mark them as possibly stale in §4.1. https://gptzero.me/news/introducing-gptzero-4o/

---

# GitHub sweep: verified shortlist

| Verdict | Repository | Licence (code / weights) | Size | Runs where | Evidence | Reason |
|---|---|---|---|---|---|---|
| maybe | https://github.com/ritabratamaiti/tinydetect | PolyForm Noncommercial 1.0.0 (LICENSE.md, (c) 2026 Ritabrata Maiti). The JS loader (app.js, boot.js, bpe.js, the int4 em / Apache-2.0. models/LICENSE-MODELS.txt says the text detector is derived from fakespot-ai/roberta-base-ai-text-detection- | About 89 MB compressed download, 93-97 MB on disk (results.json: 'Shipped ... 97 | Browser: yes. It is designed for onnxruntime-web 1.30, using WebGPU when available and WASM otherwise, with a service wo | Published, but thin. results.json compares the compressed build against full precision on two fresh sets of 40 texts each: 24 human (2012/2014 Hacker News, Gutenberg, 2019 Wikipedia) and 16 AI (Claude-written). AUROC (set 1 / set 2): full precision 0.982 / 0.917, 8-bit 0.982 / 0.924, shipped mixed i | The weights are Apache-2.0 and run in the browser, and the compressed build matches full precision on the author's small test. But the real size is about 89 MB, not 6.9 MB, so it breaks the 39 MB budget assumption, and all reusable code is PolyForm Noncommercial. Worth adding only in the GitHub Pages build or as an on-demand fetch. Use your own loader, check it against plain Fakespot q8 on the 299 |
| use | https://github.com/salmannawaz786/sallulabs-ai-detector | MIT (LICENSE file in the repo) / MIT (same repo). Not gated. Base models: nreimers MiniLMv2 is Apache-2.0 and microsoft/deberta-v3-large is MIT. | 38 MB (int8 ONNX, weight-only 8-bit) | Easy in the browser. A RoBERTa-architecture int8 ONNX file plus tokenizer.json should run in onnxruntime-web WASM with t | RAID leaderboard, independently scored. PR liamdugan/raid#213, 'Add SalluLabs Detector (MiniLM, 38MB)', was merged on 2026-10-13 by maintainer Liam Dugan. The evaluation bot reported, with attacks: AUROC 98.94, TPR 95.61% at 5% FPR and 89.42% at 1% FPR. Without attacks: AUROC 99.22, TPR 96.83% at 5% | MIT, small (38 MB), weights in the repo, a different architecture and distillation, and an independent hidden-label RAID score. Its training data partly overlaps the existing RAID models, so errors may correlate. Its weakest category, long instruction-style answers, is close to the owner's use case. It is a brand-new single-author repo. Port the normalization and windowing to JS, ignore its thresh |
| maybe | https://github.com/woohp/ai-detector | None. No LICENSE or COPYING file and no licence in package.json or the About section, so the default is all rights reser / MIT according to the Hugging Face card, as seen through search-indexed text; huggingface.co was unreachable from this sa | About 790 MB fp16. The repo does not state a size. This is computed as roughly 3 | Browser, on demand only. README timings (Chromium, Apple Silicon): WebGPU 2.4 s load and warm-up, 0.02 s for short text, | Vanguard Hugging Face card (self-reported): average out-of-distribution AUROC 0.9475 and macro-F1 0.8493 over 7 OOD datasets, against Fakespot 0.9315/0.8029 and Desklib 0.9213/0.7837. In-distribution AUROC on MAGA is 0.9992. The card notes that performance drops on unseen distributions. Related: the | It has the strongest out-of-distribution evidence and the weights are MIT, and woohp shows fp16 browser parity. But the woohp code has no licence, the about 790 MB model cannot be hosted on GitHub Pages or within the artifact cap, and it is practical only on WebGPU. It is acceptable only as an opt-in, cached 'deep check' exported with your own script and fetched from a Hugging Face repo. Confirm t |
| maybe | https://github.com/baoguangsheng/fast-detect-gpt | MIT / SmolLM2-135M and -Instruct: Apache-2.0, not gated. distilgpt2: Apache-2.0. (gpt-neo-2.7B is MIT; Llama3-8B uses the Llam | SmolLM2-135M q8 ONNX is roughly 135-145 MB. I could not open the file listing (H | The repo is PyTorch research code written for an A100 GPU (Python 3.8, torch 1.10) and is not usable in the browser as-i | Repo and ICLR 2024 paper (large models only): average AUROC 0.9887 on 5-model white-box generations and 0.9338 on ChatGPT/GPT-4 black-box with surrogate models, across XSum, SQuAD and WritingPrompts-style sets. The 2026 README ranks Llama3-8B above falcon-7b, and both well above gpt-j-6B and gpt-neo | The licences are fine (MIT method, Apache-2.0 LM) and a JS reimplementation over SmolLM2-135M logits is feasible in the browser. But there is no accuracy evidence at 135M scale, it adds about 140 MB, and the repo code itself cannot be used directly. Use it only as a low-weight, calibrated, on-demand signal for ranking predictable sentences, not as a detector verdict. |
| maybe | https://github.com/gauravsdama/binoculars-local-mcp | BSD-3-Clause (LICENSE.md is upstream Binoculars' licence, (c) 2023 Abhimanyu Hans, Avi Schwarzschild, Tom Goldstein). Ga / Apache-2.0 for both Qwen2.5-0.5B and Qwen2.5-0.5B-Instruct, not gated. Confirmed through indexed pages; the Hugging Face | About 1,976 MB on disk (2 x 988 MB bf16 safetensors; README: 'about 1.9 GB toget | Runs locally as a Python program (3.11-3.13, uv) with no GPU server. On a 24 GB M4 Pro MacBook: CPU 1.73 s load, 0.346 s | Self-reported 'limited local benchmark'. On a separate 240-text holdout of CC-News, CNN and PubMed human text against Falcon-generated text, accuracy mode reached 88.3%, and conservative mode had a 2.5% human false-positive rate and 60.0% AI true-positive rate. No AUROC is given. Calibration used 36 | Licences are clean (BSD-3, Apache-2.0 weights pinned by hash), it is actively maintained, and it is a genuine zero-shot signal that runs offline. But it is a 2 GB, roughly 6 GB-RAM Python MCP server, set up mainly for macOS, that a static site cannot call directly. Its evidence is a small, easy news-domain holdout, and it would need full recalibration on business answers. Treat it as an optional l |
| maybe | https://github.com/fastdatascience/faststylometry | MIT (LICENSE file confirmed: Copyright (c) 2023 Fast Data Science) / n/a (no weights) | 0 MB of models. Core logic is about 325 lines of Python (burrows_delta.py 223, p | Fully browser-feasible after a small JS port: z-scores, mean absolute difference, and a 1-feature logistic regression. N | The repo gives no accuracy numbers; its README shows only a novel-attribution walkthrough. The literature limit is Eder, 'Does size matter?' (Digital Scholarship in the Humanities 30(2):167-182, doi 10.1093/llc/fqt066): Burrows' Delta needs about 5,000 words per sample for English (2,500 at best) to | The licence and size are fine and the port is easy, but the code shows two practical problems the shortlist understates. (1) Delta's z-scores use the standard deviation of word proportions across authors in the training corpus. calibrate() then does leave-one-out across several authors' texts. So the owner's answers alone are not enough: a background corpus of other writers is also needed, for exa |
| maybe | https://github.com/CoffeeMethod/MELD-GUI | Apache-2.0. A LICENSE file and a NOTICE file both exist on master (confirmed by raw fetch), which corrects the shortlist / MIT, per the model-card metadata (via search snippets) and the GUI's NOTICE. It is not gated. huggingface.co was blocked | About 1,600 MB fp32 (README). fp16 about 800 MB and int8 about 400 MB are estima | Runs locally as a Python program (torch>=2.2, transformers>=4.48, FastAPI on 127.0.0.1:8000) on CPU or CUDA. MELD_MODEL_ | MELD paper (arXiv 2605.06903, Cornell, May 2026), Table 1, on the official RAID test set. All settings including attacks: AUROC 99.82, TPR@5%FPR 99.78, TPR@1%FPR 99.24. No attack: 99.85, 99.76, 99.40. MELD-eval (held-out frontier chat models): 99.7% TPR at 1% FPR. These are the authors' own figures, | The weights are strong, MIT and real, so this is worth keeping as an optional local second opinion. Risks: the GUI is a 1-star, single-day project; the weights sit at an anonymous-review HF id with a conflicting mirror; and the browser port is unbuilt. The README itself warns that scores under 100 words are noise and that formulaic or boilerplate prose reads as machine-like. A senior executive's f |
| use | https://github.com/houtini-ai/ai-detect | MIT (LICENSE file present; pyproject license MIT) / Desklib: MIT and ungated, per the HF card's YAML header (license: mit) seen via search snippets; huggingface.co was bloc | Desklib about 1,700 MB fp32 (README; consistent with about 435M total parameters | Local Python program (CLI, MCP server or package) on CPU, with CUDA used automatically if present. Works offline after t | The Desklib card claims it led RAID 'at time of submission' but gives no numbers. A later paper (arXiv 2601.20006) puts it fifth overall on RAID. Third-party out-of-distribution evaluation (ShantanuT01 vanguard/gradient HF model cards, 7 OOD datasets) gives an average AUROC of 0.9213 and macro-F1 of | Use it only as the offline held-out judge that the browser rewrite loop never optimises against. It meets every rule: MIT code and weights, active in August 2026, runs on a laptop CPU, and 1.7 GB is acceptable for a local program. Caveats: it is a 3-commit beta wrapper; Desklib was trained on documents, so per-sentence scores are noisy; and it strongly penalises formal register (missing contractio |
| use | https://github.com/QwenLM/Qwen3 | No LICENSE file in the repo (raw LICENSE returns 404). The README states: 'All our open-weight models are licensed under / Apache-2.0 (Qwen3 README). Ungated. | These download sizes are estimates, because Hugging Face was blocked: Qwen3-4B q | Browser via WebGPU (Chrome or Edge) on a laptop with about 4 GB of free GPU memory for 4B, or about 2 GB for 1.7B (both  | Qwen3 Technical Report (arXiv 2505.09388), Qwen3-4B: IFEval strict-prompt 81.9 / 81.2, Creative Writing v3 61.1 / 53.6, WritingBench 7.35 / 6.85. The first figure is thinking mode; the second set's mode was not confirmed from the snippet, likely non-thinking. I found no measurement of prompt-only Qw | This is the best-supported free on-device rewriter: Apache-2.0 weights, prebuilt and maintained WebLLM builds (October 2026 release), and a 1.7B fallback for weaker laptops. The repo's last commit (January 2026) does not matter, because the weights are static and WebLLM is active. Caveats: WebGPU only; about 2.3 GB first download; a 4,096-token context, so rewrite per paragraph rather than per doc |
| maybe | https://github.com/microsoft/PhiCookBook | MIT (repository) / MIT and ungated, per multiple secondary sources. huggingface.co was blocked here, so I could not open the official card  | About 2,200 MB download (q4f16, an estimate). VRAM is 3,438 MB (q4f16) or 4,221  | Browser via WebLLM on WebGPU with about 3.5 GB of GPU memory, the same constraint as Qwen3-4B. Loading both models at on | WebLLM paper (arXiv 2412.15803), Table 1: Phi-3.5-mini reached 71.1 tok/s in WebLLM against 89.3 tok/s native (79.6% retained) on an M3 Max, Chrome Canary, WebLLM v0.2.75. That is the speed of Phi-3.5, not Phi-4-mini, and not quality. The Phi-4-mini-instruct card reports MMLU 5-shot 67.3 (Phi-3.5-mi | Licences (MIT for code and weights) and browser feasibility check out, and the cookbook is maintained. But it is an optional second engine: it adds about 2.2 GB of download and the same WebGPU and VRAM limit, and there is no evidence it improves best-of-N selection or detector outcomes. The instruction-following claim is unverified. Add it only if A/B tests show Qwen3 candidates are too uniform. A |
| use | https://github.com/sgaofen/humanizer-local-model | Apache-2.0 (README: 'Code and weights: Apache License 2.0') / Apache-2.0, as stated in the README. The Gemma 4 base is Apache-2.0 (Google Open Source Blog), so the old Gemma Terms of | GGUF only, no int8/fp16 ONNX. Q8_0 12,700 MB (peak RAM 13.7 GB, the authors' rec | Local program only. Too big for a browser tab, and there is no WebLLM/MLC or ONNX build. It runs with llama.cpp llama-se | All self-reported by the author. Held-out set: 312 drafts (210 English, 102 Chinese) across 18 genres, including emails, work reports, policy memos, opinion essays and forum answers, written about a third each by GLM-5.3, GPT-5.6 Luna and Claude Sonnet (none used in training). Detector: Originality. | The repo is real, public, active (2026-10-15) and Apache-2.0 for both code and weights. The weights exist, are not gated, and the Gemma 4 base is Apache-2.0, so the licence fits. The shortlist's numbers check out. Use it only as an optional, opt-in rewriter on localhost, never as part of the static download. Corrections to the shortlist: (1) the strong detector result is for bf16 (Q8_0 gave 7%), a |
| maybe | https://github.com/chengez/Adversarial-Paraphrasing | Apache-2.0 / N/A for the repo. The default paraphraser, Llama-3-8B-Instruct, is gated on HF under the Llama 3 Community License; any  | 0 MB for the method. The reference setup (Llama-3-8B fp16, about 16,000 MB, plus | The published code is not usable locally in a browser. The sbatch script requests 2x RTX A6000 GPUs, 24 h, CUDA. The met | NeurIPS 2025 (arXiv 2506.07001, Cheng, Sadasivan, Saberi, Saha, Feizi, University of Maryland). Main dataset: MAGE, plus KGW and Unigram watermarked MAGE. Guided by OpenAI-RoBERTa-Large: average 87.88% relative reduction in T@1%F (TPR at 1% FPR) across neural, watermark and zero-shot detectors; -64. | Keep it as a peer-reviewed reference for the design rule (unguided paraphrasing can make text easier to detect; detector-guided selection lowers detection, and transfers across detectors). Do not run or ship the code: it is stale (last commit 2025-06-10, 4 commits) and needs CUDA, 2 GPUs and Llama-3-8B (gated). The shortlist's numbers are accurate, but the planned best-of-N sentence selection is o |
| use | https://github.com/blader/humanizer | MIT (sidebar, README and SKILL.md frontmatter) / N/A (MIT text) | 0 MB to download; SKILL.md is about 31.6 KB (about 397 lines, roughly 5,000 word | Runs anywhere because it is just a prompt. It is long and dense, though (26 patterns in 6 groups, conditional rules, thr | README: blind judges preferred its rewrite over the raw AI text 16 of 16 times (issue #229, by @itsryanlenk, opened 2026-08-19 and closed 2026-09-28). In that issue all judges were LLMs from one model family, only 77 of 144 planned trials ran, and raw versus rewrite+checker was 22/22. Detection in t | The repo is real, MIT, hugely popular and active (2026-10-16). It adds nothing to the download. Use it only as the instruction and ban-list text inside the detector-guided best-of-N loop, never as the thing that lowers scores. The maintainer says outright that prompting alone does not beat detectors. Correct the shortlist: replace 'Originality.ai flagged 60 of 60' with the issue #229 numbers (97.8 |
| use | https://github.com/fredgaffey/local-ai-detector | MIT. The LICENSE reads 'Copyright (c) 2026 freddygaffey', a different spelling from the account fredgaffey, and the READ / All permissive (MIT or Apache-2.0) per models.ts. The code notes that the conversion repos mostly carry no licence tag o | Code: small. Referenced models (int8/q8 on WASM): Fakespot about 125 MB; TMR abo | Fully in-browser: transformers.js 4.x with bundled onnxruntime-web WASM (wasmPaths pinned, never a CDN), WebGPU first wi | Self-reported in docs/calibration.md. About 1,870 English web texts (MAGA, LLMTrace and DACTYL human and AI text from 2024-26 generators, plus 67 Claude texts); hash split, reported on a test half of about 900. WebGPU path, all genres: Fakespot AUROC 0.91 (FPR 5%, TPR 68%); TMR 0.87 (4% / 58%); e5-s | Confirmed: MIT, active (2026-10-07), and the closest match to the site's own stack. The shortlist's AUROC 0.91 / 5% FPR figure is accurate. Lift the code, not the extension packaging. Caveats: 0 stars and no outside validation; a copyright and clone-URL mismatch (freddygaffey/ai_detector is 404); the numbers are self-reported. Its own calibration matters for this site: the two detectors the site a |
| use | https://github.com/tbhb/vale-ai-tells | MIT / N/A (MIT) | 0 MB of model weights; the rules are a few hundred KB of YAML | Easy to port to browser JS for most rules. 'existence' rules such as FormalRegister are plain token lists, so regexes wi | No precision, recall or FPR for the package. Evidence is per rule: hit counts on 'seven pre-LLM corpora' (Go and Python standard libraries, Rust RFCs, PEPs), for example ConsequenceClause with 58 pre-LLM hits and StrawmanContrast whose kept tokens match about 30 times, one PNAS study cited for Parti | Confirmed: MIT, maintained (2026-10-11, v1.37.0), the largest maintained AI-tell rule set, and it adds no download. It gives the explainable per-sentence reasons and a ban list for the rewriter. Tuning for lending prose matters more than the shortlist says. FormalRegister flags implement/implementation, prioritize, optimize, maximize, minimize, terminate and facilitate, which are normal finance wo |
| use | https://github.com/Automattic/harper | Apache-2.0 (repo LICENSE, also the licence field of the npm package harper.js@2.13.0) / Not applicable (no ML weights). The dictionary and rules are inside the Apache-2.0 WASM. It is not gated and needs no ac | Larger than the 'a few MB' claimed. harper_wasm_bg.wasm is 20.25 MB raw and abou | Good in the browser and fully offline. I installed harper.js 2.13.0 and ran it locally in Node 22 with the inlined binar | No published precision or recall benchmark exists (no CoNLL-2014 or BEA-2019 numbers, and no head-to-head with LanguageTool). The vendor claims only speed (ms per lint) and memory (under 1/50th of LanguageTool). Reviews and forum posts say it covers fewer rules than LanguageTool. My own spot test (N | Fits the role well as an optional post-rewrite grammar gate. It is Apache-2.0, actively maintained (commit 2026-10-17, release 2.13.0 on 2026-10-16), free, offline, has no model weights, runs in WASM in milliseconds, and adds about 8 MB gzipped (~20 MB raw). Changes to the plan: - Set Dialect.Indian, not British. - Gate on the difference between versions. Lint both the original and each candidate, |

## Notable candidates dropped

- https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX: TMR RoBERTa (also used by Text Integrity Studio and unslop) was trained on RAID like the three existing models, so it adds little diversity. It raised false alerts on 54% of HC3 human Q&A answers at the 80% cut-off, and SlopTotal reports a mean score of 0.72 on modern human text. Formal Q&A prose is exactly the owner's genre.
- https://github.com/andrewnakas/gpttrace: Same RAID+MAGE training data and a ModernBERT-style Ettin encoder as the existing ModernBERT, so little diversity. The 99.73% RAID score belongs to an unreleased RAID-only model; the released v3 scores 0.742 AUROC on paraphrased text. Repo started 2026-10-14 and has 1 star. Revisit only as a replacement for the ModernBERT slot.
- https://github.com/liamdugan/raid/tree/main/leaderboard/submissions/tabularis-modernbert-r1: A near drop-in upgrade for the ModernBERT slot at the same size (98.98% vs 94.14% at 5% FPR under attacks), but it is not on GitHub, the licence is unverified, and it adds no diversity. Worth checking the HF licence as a straight replacement later.
- https://github.com/pablocaeg/sloptotal: Excellent reference: read its SlopBench FINDINGS for per-engine biases when setting ensemble weights. As a tool to adopt, though, it is a 2 GB Docker app that overlaps MELD-GUI and houtini as a local second opinion, several of its engines are RAID-trained, and the shortlist was capped at 3 toolkits.
- https://github.com/SES-Lab-OTH/deberta-conpara: Strong RAID numbers including attacks (AUROC 99.61, MIT), but 13-67% false positives on academic prose (risky for formal business answers), 1.7 GB, and it overlaps MELD and Desklib as a local judge.
- https://github.com/OpaceDigitalAgency/opace-ai-content-checker-detector: Small and well calibrated on paper (34 MB, formal GOV.UK-style human data), but the fine-tuned weights have no published HF id or host and no stated licence. It is also another e5-small, which is already in the stack.
- https://github.com/superannotateai/generated_text_detector: The low-FPR variant suits the goal, but the weights use the custom SAIPL licence, the model is 1.4 GB (RoBERTa-large), and the repo has been inactive since 2024-12.
- https://github.com/pangramlabs/EditLens: The 'how much AI editing' score fits the use case, but the licence is CC BY-NC-SA (non-commercial) and the weights are gated. Not usable for a company executive's professional work.
- https://github.com/fjc2005/DetectAnyLLM: The best small curvature scorer on paper (Qwen2-0.5B), but under the non-commercial Pi-Lab licence, with no browser port and 15 GB of GPU for evaluation as published.
- https://github.com/distil-labs/distil-ai-slop-detector: Apache-2.0 and proven in the browser through wllama, but trained on Kaggle essays; its README says formal business emails give the most false positives (88%). 242 MB.
- https://github.com/hyunseoklee-ai/ReMoDetect: The reward-model signal would add diversity, but no licence is stated and DeBERTa int8 quantisation is known to distort scores.
- https://github.com/IBM/RADAR: Paraphrase-robust, but the weights licence is unverified, it is a 1.4 GB RoBERTa-large, and Desklib or MELD cover the local-judge role.
- https://github.com/Imalwayshere/Open-Detector: Accuracy is self-reported only (99.57%), on academic text, and the weights licence is not stated.
- https://github.com/Hello-SimpleAI/chatgpt-comparison-detection: 2022-era ChatGPT-3.5 training data; SlopTotal AUC 0.829 (OpenAI RoBERTa detector 0.771). Too weak on modern LLM text.
- https://github.com/ahans30/Binoculars: The reference code needs a GPU (Falcon-7B pair) and has been unmaintained since 2024. The small-pair version is covered by binoculars-local-mcp. The same GPU-only problem applies to ImBD, DNA-GPT, DetectGPT, Lastde, AdaDetectGPT, mdok, SeqXGPT, DIPPER and CoPA.
- https://github.com/vivek3141/ghostbuster: Needs paid, deprecated OpenAI logprob APIs. Glimpse and RAIDAR have the same problem.
- https://github.com/rudra496/StealthHumanizer: Considered as a WASM fallback rewriter (BART-large, MIT), but its evidence is vague (the detector is unnamed), it defaults to cloud providers, and its 'typographic variation' layer risks inserting lookalike or invisible characters. That would be deceptive and is undone by normalisation such as SalluLabs'.
- https://github.com/lynote-ai/humanize-text: The pipeline calls paid LLM APIs (DeepSeek, OpenRouter) and Google Translate. Only the T5-small checkpoint is local, and it makes light edits. The sister repo lynote-ai/ai-text-detector keeps its real model behind a paid API.
- https://huggingface.co/authormist/authormist-originality: The base model is under the Qwen2.5-3B Research licence, it was trained on academic abstracts, there is no GitHub code, and its stated purpose is evasion. TempParaphraser (commercial use prohibited) and CoEdIT (CC-BY-NC) were dropped for licence reasons too.
- https://github.com/meta-llama/llama-models: Llama 3.2 3B/1B as rewriters: the licence is not OSI, the 1B often drops or changes facts, and Qwen3 and Phi-4-mini cover the same sizes with permissive licences. Gemma-4-E2B was only added to WebLLM 6 days ago; recheck it later.
- https://github.com/zacharyhorvitz/TinyStyler: An attractive idea (rewrite towards the owner's own style from his past answers, MIT), but 800M params, no activity since 2024-11, and no detector data. Revisit once an owner corpus exists; faststylometry covers the voice check meanwhile.
- https://github.com/Matt-Komiske/humanizer: The best design reference for the rewrite loop and the held-out-judge lesson, but it has no licence file (all rights reserved), so it cannot be reused as code. Its lessons are carried in the Adversarial Paraphrasing and houtini entries.
- https://github.com/ilien-dev/quiron: Its human-band metrics and factdiff idea are good, but the AGPL-3.0 copyleft also covers network use. Reimplement the idea rather than reuse the code.
- https://github.com/harshaneel/humanize: Its 'add specifics' lever can introduce new facts, which conflicts with keeping every fact, and its README admits GPTZero and Pangram still rate the output 99-100% AI.
- https://github.com/webmachinelearning/writing-assistance-apis: The Chrome Rewriter API uses closed Gemini Nano weights, is Chrome-only, and is still behind an origin trial or flag.

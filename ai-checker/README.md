# Answer Desk

Check an answer with open-source AI-text detectors, see which sentences read as AI-written, and
rewrite them without losing a single fact. Everything runs in your browser; nothing is uploaded.

**Open it: https://subcinctus.github.io/answer-desk/** (after the first deploy, see below)

## What it does

1. **Check.** Paste an answer and press Check. Six checkers score it, each shown separately;
   five of them are combined into one risk score (Low / Medium / High). Sentences are highlighted by how
   AI-like their surroundings read, and the AI tells in them (stock phrases, even sentence lengths
   and so on) are listed with what to do instead.
2. **Fix it yourself (Coach).** Edit in place; the tells update as you type, and Check rescores.
3. **Ask me (Interview).** For a flagged paragraph the page asks one or two questions: the real
   figure, an example from your own work, your view. A model rewrites the paragraph using only
   your answers as new facts. This is the method that reads most human, because the content is yours.
4. **Rewrite flagged.** For each flagged sentence the rewriter writes several versions. Every
   version must pass the guards below; of the ones that do, the one the checkers rate least AI-like
   is kept, for up to three rounds. You then see a word-by-word comparison, a fact report and a
   before/after table for every checker, and nothing changes until you press Use rewrite.
5. **My writing.** Paste 20 or more of your own pre-2022 texts. They stay in this browser. The
   page scores them with every checker, so you can see how your genuine writing scores. It also uses
   up to three of them as voice examples for the rewriter.
6. **Versions.** Every check and accepted rewrite is saved on this device; undo works across
   rewrites.

### The guards (a version is thrown out if any fails)

- **Facts.** Every number, amount (₹, lakh, crore, Indian digit grouping), percentage, bps, date,
  FY/quarter, acronym (GNPA, RBI, DSA…) and name in the original must still be there, and nothing
  new may be added.
- **Negations and modal words.** "not", "may", "will", "must", "can" and similar must match, so
  "can reduce" never becomes "cuts".
- **Meaning.** A small NLI model (DeBERTa-v3-xsmall) checks both directions: the original implies
  the version and the version implies the original.
- **Similarity.** MiniLM sentence embeddings must stay close (cosine ≥ 0.85).
- **Size of change.** An edit-ratio cap, a length window, and no new names.
- **Grammar.** Harper (Indian English) must find no new grammar slips.
- **Hidden characters.** No zero-width or look-alike characters (these are also cleaned from pasted
  text, since they fool detectors and some institutions treat them as cheating).

One checker (Fakespot) is held back from choosing versions and only confirms the result. If the
other checkers improved and it did not, the page warns that the rewrite was over-fitted to them.

### Rewriters (all free)

| Engine | What it is | Set-up |
|---|---|---|
| **Local, Humanizer 12B** (recommended on a Mac with 32 GB) | Gemma-based model fine-tuned to rewrite AI text into human-sounding text ([sgaofen/humanizer-local-model](https://github.com/sgaofen/humanizer-local-model), Apache-2.0), run by llama.cpp on your computer | `brew install llama.cpp`, then `llama-server --hf-repo jialinyyzz/humanizer --hf-file humanizer-12b-Q8_0.gguf -c 8192 -np 1 -ngl 99 --port 8080`. The first start downloads about 13 GB. LM Studio or Ollama with any chat model also work. Interview mode needs a chat model (Humanizer only restyles). |
| **In-browser Qwen3** | Qwen3 8B / 4B / 1.7B run by WebLLM on the graphics chip | Nothing to install; Chrome or Edge with WebGPU. First use downloads 1–5 GB and keeps it. |
| **Claude chat (copy and paste)** | Your Claude plan | Copy the request into Claude, paste the reply back. The guards and the choice still run locally. Newer Claude models watermark their output (Anthropic, August 2026). |

## How good is it? (measured, `docs/calibration-report.md`)

Calibration pool: 4,091 texts. Human: professional writing (SEC filings, HC3 finance answers,
Enron mail, news, Stack Exchange), non-native and student essays. AI: 2024–26 generators
(MIRAGE's 17 LLMs, SlopBench's 2026 models, MAGA, LLMTrace, DACTYL, Beemo) in four styles
(generate, polish, rewrite, humanized), plus 72 answers on Indian lending written for this test by
a current Claude model. Rates are on a held-out half. Separately, the Human Detectors set (300
articles carrying GPTZero and Pangram verdicts) was never used for fitting.

| Checker | Source | AUROC, 2024–26 AI | AUROC, held-out articles | Weight |
|---|---|---|---|---|
| Fakespot RoBERTa | Mozilla Fakespot, Apache-2.0 | 0.90 | 0.99 | 0.52 |
| ModernBERT (RAID + MAGE) | Drayson et al., UCL, EMNLP 2025, Apache-2.0 | 0.75 | 0.73 | 0.28 |
| SalluLabs MiniLM | RAID leaderboard 2026, MIT | 0.85 | 0.61 | 0.17 |
| Tabularis ModernBERT | tabularis.ai, MIT | 0.86 | 0.91 | 0.06 |
| AI-tell rules | blader/humanizer, vale-ai-tells, stop-slop, berenslab, SlopTotal (MIT) | 0.74 | 0.76 | 0.03 |
| ZipPy (compression) | Thinkst, MIT | 0.51 | 0.67 | 0 (shown, not counted) |

ModernBERT is weak on general modern text but the best of the five at telling the in-domain Claude
answers from human writing, which is why it keeps a large weight.

**Combined score** (High = above the 95th percentile of professional human writing; Medium = 90th):

| | Result |
|---|---|
| Professional human texts rated High | 4.7% (5.3% at 150+ words) |
| Professional human texts rated Medium or High | 8.7% |
| Non-native English human texts rated High | 3.9% |
| 2024–26 AI texts rated High / Medium or High | 71% / 79% |
| Held-out articles: AI rated High / human rated High | 84% / 1.3% |
| Agreement with GPTZero / Pangram on those articles | 93% / 92% |
| **In-domain Claude answers rated High / Medium or High** | **14% / 24%** (n = 29) |

**The release target was not met.** The plan asked for 90% of modern AI caught at ≤5% false flags;
these open models reach about 71–79%. The weakest point is the last row: answers written plainly
by the newest models in your own field mostly pass these checkers. So a Low score means "these
checkers did not flag it", not "Turnitin will pass it". Use the GPTZero and Pangram buttons for a
second opinion on anything that matters.

Other honest limits:

- No rewrite method guarantees a pass. Since August 2026 Turnitin counts text changed by
  "bypasser" tools as AI. The safest changes are your own (Interview mode): a real example, the
  actual figure, your view.
- Under about 150 words every detector is unreliable; Turnitin itself calls scores under 300 words less reliable.
- Turnitin and DrillBit cannot be called by individuals, so nothing here reproduces their verdict.
- If a course or employer does not allow AI help, an AI rewriter may break that rule whatever the
  scores say.

## Privacy

The checkers, guards and grammar check run in your browser (ONNX Runtime Web, WebAssembly). Your
text is not sent anywhere when you check it. The local and in-browser rewriters keep it on your
computer; the Claude engine sends only what you paste into Claude yourself. Writing samples and
versions stay in this browser's storage. The page is marked `noindex`.

## Repository layout

| Path | What |
|---|---|
| `ai-checker/` | The page: `index.html`, `app.mjs`, modules in `src/` (contracts in `src/README.md`), workers, `calibration.json` |
| `tools/export_detectors.py`, `tools/model_specs.py` | Export the detectors and guard models to int8 ONNX, with fp32 parity checks |
| `tools/build_artifact.py` | Build the static site (`python3 tools/build_artifact.py site --site`) |
| `tools/calib/`, `tools/calibrate.py` | Build and score the calibration pool, fit the ensemble, write the report |
| `tests/unit/` | 560+ unit tests (`npm test`) |
| `tests/e2e/` | Playwright tests on a gzip static server with a fake local rewriter (`npm run e2e`); `smoke.mjs` for the live site |
| `.github/workflows/` | `models` (export to the `models` release), `deploy` (test, build, publish to Pages, check the live site), `weekly check` |

## Deploying (once)

1. Create a public repository named `answer-desk` and give the Claude GitHub app access to it.
2. Settings → Pages → Source: **GitHub Actions**.
3. Push this repository's contents to `main`. Run the **models** workflow once (Actions tab).
   When it finishes, **deploy** runs by itself: unit tests, site build, nine browser tests, publish,
   then a smoke test against the live URL.

The models are never committed. The models workflow exports them from pinned Hugging Face and
GitHub sources into release assets, and the site serves them split into 14 MiB parts. The first
visit downloads about 600 MB; the browser keeps it, so later visits start in seconds.

Third-party components and licences: `ai-checker/vendor/NOTICE.md`.

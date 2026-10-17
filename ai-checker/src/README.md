# Page modules

Plain ES modules, no bundler, no DOM access (except `app.mjs` and the engines' browser APIs).
Every module has unit tests in `tests/unit/<module>.test.mjs`, run with `node --test tests/unit`.
Node 22 and current Chrome/Safari must both run them. Keep regexes safe for older Safari: no
`(?<=` / `(?<!` lookbehind.

## Contracts

### `text.mjs` (exists)
`words(t)`, `esc(s)`, `splitSentences(text) -> [{start, end, text}]` (exact offsets),
`diffWords(a, b) -> [{op: 'eq'|'del'|'ins', s}]`, `paragraphs(t) -> count`.

### `normalize.mjs`
- `cleanText(text) -> {text, changed, counts: {invisible, lookalike, fullwidth, spaces}}`
  Meaning-preserving clean-up applied to the editor (with notice and undo):
  remove invisible format characters (Unicode Cf such as U+200B–U+200F, U+202A–U+202E,
  U+2060–U+2064, U+FEFF, U+00AD); map lookalike letters (Cyrillic, Greek, Latin-like symbols from
  the Unicode TR39 confusables data) to Latin **only inside words that mix scripts or in words
  made entirely of confusables in an otherwise Latin-script text** (genuine Hindi, Greek or Russian
  words stay); fullwidth ASCII → ASCII; unusual spaces (U+00A0, U+2000–U+200A, U+202F, U+205F,
  U+3000) → normal space; U+2028/U+2029 → `\n`. Never touches ₹, superscripts, fractions, quotes,
  dashes or ellipses.
- `forDetector(text) -> string`: `cleanText(text).text` then NFKC. Used only for detector input.
- `auditText(text) -> [{index, char, code, kind: 'invisible'|'lookalike'|'fullwidth'|'space'}]`.

### `facts.mjs`
- `extractFacts(text) -> {nums: Map<canon, {raw: string[], count}>, terms: Map<term, count>,
  negations: Map<word, count>, modals: Map<word, count>}`
  Number canon is value-based so that equivalent spellings match:
  `₹1,00,000` = `Rs 100000` = `INR 1 lakh` → `inr:100000`; `2.5 crore` → `n:25000000` (with
  currency prefix → `inr:25000000`); `Rs 2,000 cr` → `inr:20000000000`; `1.5%` = `1.5 per cent`
  → `pct:1.5`; `150 bps` → `bps:150`; `3x` → `x:3`; `$4 mn` → `usd:4000000`; `FY24` = `FY'24` =
  `FY2023-24` = `FY 2024` → `fy:2024` (Indian fiscal year named by its end year); `Q1`..`Q4`,
  `H1`, `H2` → `q:1`.. / `h:1`..; dates `31 March 2025`, `31/03/2025`, `March 2025` → `date:2025-03-31`
  / `date:2025-03`; bare numbers → `n:<value>`; Indian digit grouping `1,00,00,000` handled.
  Terms: acronyms (`RBI`, `NBFC`, `GNPA`, `DSAs`, `LTV`, `PSL`, `MSME`), mid-sentence capitalised
  names. Negations: not, no, never, without, none, nor, cannot, n't. Modals: may, might, will,
  would, must, should, could, can, shall.
- `compareFacts(before, after, {allow = []} = {}) -> {ok, missingNums, addedNums, missingTerms,
  addedTerms, negations: {before, after}, modals: {changed: [{word, before, after}]},
  parasBefore, parasAfter, wordsBefore, wordsAfter}` (multiset comparison; `allow` lists raw facts
  the author supplied in Interview mode that may be added).
- `factCheck(before, after)` keeps the old shape for the review dialog:
  `{missingNums, addedNums, missingTerms, parasBefore, parasAfter, wordsBefore, wordsAfter}`.

### `tells.mjs` (+ `tells-data.mjs`)
- `findTells(text) -> [{start, end, rule, category, message, weight}]`, exact offsets, sorted.
  Categories: `vocabulary`, `phrase`, `opener`, `closer`, `formula` (not just X but Y, triads,
  "it's not X, it's Y"), `structure`, `punctuation` (em-dash density, colon lists).
  Tuned for formal Indian finance writing: never flag ordinary domain words (implement,
  prioritise, optimise, facilitate, disburse, leverage *ratio*, portfolio, underwriting…).
- `styleStats(text) -> {sentences, meanLen, cvLen, contractionsPer100, emDashPer100,
  colonLines, triads, ingOpeners, flags: [{stat, value, message}]}`.
- `tellsBySentence(text, sentences) -> [{count, weight, rules: [...]}]` aligned with `sentences`.
- `BAN_LIST -> string[]`: phrases a rewrite must avoid (for prompts).
- Rule lists ported from MIT sources must keep attribution in `tells-data.mjs` and
  `vendor/NOTICE.md`.

### `guards.mjs`
- `async gateCandidate(original, candidate, ctx = {}) -> {ok, reasons: [{code, message}], metrics}`
  `ctx`: `{nli?: async (premise, hypothesis) => ({entailment, contradiction, neutral}),
  embed?: async (texts: string[]) => Float32Array[] (L2-normalised), grammar?: async (text) =>
  [{start, end, message, kind}], allow?: string[], limits?: {...}}`.
  Checks, each with its own reason code: `empty`, `unsafe-chars` (any `auditText` hit),
  `facts` (compareFacts not ok), `negation`, `modal`, `entailment` (both directions; skipped if no
  `nli`), `contradiction`, `similarity` (skipped if no `embed`), `edit-ratio`, `length`,
  `new-entity`, `grammar` (only lints that the candidate adds and the original lacks), `meta`
  (the model talking about itself: "Here is", "As an AI", "rewritten version").
- `DEFAULT_LIMITS = {entailment: 0.80, contradiction: 0.10, cosine: 0.85, maxEditRatio: 0.80,
  minLengthRatio: 0.6, maxLengthRatio: 1.6}`.
- `editRatio(a, b)`: word-level Levenshtein distance / max word count.

### `calibration.mjs`
- `humanPct(q, x)` (101 quantiles, linear interpolation; identical to the old page and
  `tools/calibrate.py`), `riskFromPct(p)`, `band(risk)`.
- `combine(cal, pcts: {key: pct}) -> {pct, risk, used, flagged}`: uses the combo for the sorted
  set of available keys; supports `cal.feature === 'logit'` (Σw·logit(clip(p/100, 0.001, 0.999))/Σw)
  and the old linear average.

### `rewrite/prompts.mjs`
- `sentencePrompt({before, sentence, after, voice, samples, variant}) -> {system, user}` for chat
  models; `variant` 0..3 changes emphasis (plainer / more personal / restructured / your-voice).
- `batchVariantsPrompt({items: [{id, before, sentence, after}], voice, samples, n}) -> string`:
  one request for a chat app (Claude) asking for a JSON object `{"<id>": ["v1", ...]}`.
- `parseVariantsReply(reply, ids) -> Map<id, string[]>` (tolerates code fences and prose).
- `humanizerPrompt(text) -> string`: exact completion wrapper of `sgaofen/humanizer-local-model`.
- `interviewQuestions(paragraph, tells) -> string[]` (template based, 1–2 questions).
- `interviewPrompt({paragraph, answers, voice}) -> {system, user}` (may only use supplied facts).
- `cleanOutput(text) -> string` strips quotes, "Here is…", markdown, think tags.

### `rewrite/engines/*.mjs`
Each exports an engine: `{id, label, async probe() -> {ok, detail}, async generate(requests,
{signal, onProgress}) -> string[][]}` where `requests = [{system, user, n, maxTokens}]` and the
result holds `n` candidates per request (fewer on failure, never throws for one bad candidate).
- `local.mjs`: llama.cpp `llama-server` (or LM Studio/Ollama OpenAI-compatible) on
  `http://127.0.0.1:<port>`; `probe` uses `/health` or `/v1/models`; Humanizer-12B uses the raw
  `/completion` endpoint with `humanizerPrompt`; other models use `/v1/chat/completions`.
- `webllm.mjs`: `@mlc-ai/web-llm` in a module worker (`workers/llm.mjs`); picks the largest
  prebuilt Qwen3 that fits (`8B` → `4B` → `1.7B`), thinking off; `probe` checks WebGPU.
- `manual.mjs`: copy/paste with a chat app; `generate` is not automatic — exposes
  `buildRequest(items)` and `parseReply(text)`.

### `rewrite/loop.mjs`
`async rewriteFlagged({text, sentences, targets, getCandidates, scoreGuide, scoreValidator, gate,
rounds = 3, targetPct = 85, signal, onProgress}) -> {text, changes, validator, warnings}`
- `getCandidates(items, round) -> Promise<Map<index, string[]>>` (items `{index, before,
  sentence, after}`); `scoreGuide(texts) -> Promise<number[]>` percentiles (higher = more AI) of
  each candidate in its 3-sentence window; `scoreValidator(text) -> Promise<number|null>` on the
  whole answer (held out, never used for selection).
- Per target: gate every candidate, keep the lowest guide score among those that pass and beat
  the current sentence; stop per sentence at `targetPct`, after `rounds`, or after a round with no
  improvement. Changes apply right-to-left so offsets stay valid. Warn (`goodhart`) if the guide
  improved but the validator did not.

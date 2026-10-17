# Answer Desk (built site)

This folder is the built website: the page, its modules, and the detector and guard models split
into 14 MiB parts. Source, tests and the calibration report live in the repository's
`ai-checker/`, `tools/` and `tests/` folders; the `deploy` workflow builds and publishes this.

Paste an answer and press **Check**. Open-source AI-text checkers (Fakespot RoBERTa, ModernBERT,
SalluLabs MiniLM, Tabularis ModernBERT, the AI-tell rules and ZipPy) score it in your browser,
and the sentences that read most AI-like are highlighted. **Ask me** rewrites a paragraph with your
own figures and examples; **Rewrite flagged** writes several versions of each flagged sentence
with a local model (Humanizer 12B via llama.cpp), an in-browser model (Qwen3 via WebLLM) or a
Claude chat, and keeps only versions that keep every fact, negation and "may/will" word and
mean the same (checked by NLI, embedding similarity and a grammar check).

- Your text is not uploaded when you check it.
- The first visit downloads about 600 MB of models; the browser keeps them.
- Measured on held-out text: 4.7% of professional human writing rated High; 71% of 2024–26
  AI text rated High and 79% Medium or High. Answers written plainly by the newest models are the
  blind spot, so a Low score is not a pass: cross-check with GPTZero or Pangram.

Third-party components and licences: `vendor/NOTICE.md`, licence texts in `LICENSES/`.

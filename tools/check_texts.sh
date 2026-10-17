#!/usr/bin/env bash
# Check a batch of texts offline with the page's checkers and calibration.
#   tools/check_texts.sh IN.jsonl OUT.json [WORK_DIR]
# IN.jsonl rows are {id, text, ...}. Needs the exported models (MODELS_DIR, default /home/user/work/models),
# Python onnxruntime + tokenizers, and Node. Scores are cached in WORK_DIR, so a rerun only scores new text.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IN="$1"; OUT="$2"; WORK="${3:-$(dirname "$OUT")/check-work}"
MODELS="${MODELS_DIR:-/home/user/work/models}"
mkdir -p "$WORK"
node "$HERE/check_texts.mjs" prepare "$IN" "$WORK/pool.jsonl"
# the detectors the shipped calibration gives weight (doc or windows)
KEYS=$(node -e "
const c = require('$HERE/../ai-checker/calibration.json'); const m = c.modes[c.default_mode || 'article'];
const ks = new Set([...Object.keys(m.ensemble.weights).filter((k) => m.ensemble.weights[k] > 0), ...Object.keys(c.window_weights || {}).filter((k) => c.window_weights[k] > 0)]);
console.log([...ks].filter((k) => k !== 'zippy' && k !== 'tells').join(','));")
pids=()
for k in ${KEYS//,/ }; do
  ORT_THREADS="${ORT_THREADS:-1}" python3 "$HERE/calib/score_pool.py" "$WORK/pool.jsonl" "$MODELS" "$WORK/scores-$k.json" "$k" > "$WORK/score-$k.log" 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
python3 - "$WORK" $KEYS <<'PY'
import json, sys, os
work, keys = sys.argv[1], sys.argv[2].split(',') if len(sys.argv) == 3 else sys.argv[2:]
keys = [k for ks in keys for k in ks.split(',') if k]
out = None
for k in keys:
    d = json.load(open(os.path.join(work, f'scores-{k}.json')))
    if out is None: out = {'ids': d['ids'], 'doc': {}}
    assert d['ids'] == out['ids']
    out['doc'].update(d['doc'])
json.dump(out, open(os.path.join(work, 'scores.json'), 'w'))
PY
node "$HERE/check_texts.mjs" report "$IN" "$WORK/scores.json" "$OUT"

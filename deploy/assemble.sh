#!/usr/bin/env bash
# Assemble the answer-desk repository (the website's home) from this one.
#   deploy/assemble.sh DEST
# DEST becomes: the page source (ai-checker/), the build, export and calibration tools, the tests,
# package files, and the GitHub Actions workflows from deploy/github-workflows/. Models are never
# copied: the "models" workflow exports them into a release, and the deploy workflow downloads them.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: deploy/assemble.sh DEST}"
mkdir -p "$DEST"
cd "$ROOT"

copy() { mkdir -p "$DEST/$(dirname "$1")"; cp -p "$1" "$DEST/$1"; }

# tracked files only, so nothing local (node_modules, caches, built sites) slips in
git ls-files -- ai-checker tools tests package.json package-lock.json ':!:tools/gpt2/**' ':!:ai-checker/README.md' \
  | while read -r f; do copy "$f"; done

mkdir -p "$DEST/.github/workflows"
cp -p deploy/github-workflows/*.yml "$DEST/.github/workflows/"
cp -p ai-checker/README.md "$DEST/README.md"
cp -p ai-checker/site/MIT.txt "$DEST/LICENSE"
cat > "$DEST/.gitignore" <<'EOF'
node_modules/
/site/
/models/
/models-tar/
__pycache__/
*.pyc
ai-checker/vendor/web-llm/
EOF
echo "assembled $(find "$DEST" -type f -not -path '*/.git/*' | wc -l) files in $DEST"

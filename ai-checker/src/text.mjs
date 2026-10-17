// Plain-text helpers shared by the page, the guards and the rewrite loop. No DOM access.

export const words = (t) => (String(t).match(/[\p{L}\p{N}](?:[\p{L}\p{N}'’.-]|,(?=\d))*/gu) || []).length;
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Sentences with exact character offsets into `text` ({start, end, text}); paragraphs never merge.
export function splitSentences(text) {
  const out = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
    for (const s of seg.segment(text)) {
      // Intl splits paragraphs too; trim whitespace but keep offsets exact
      const lead = s.segment.length - s.segment.trimStart().length;
      const body = s.segment.trim();
      if (/[\p{L}\p{N}]/u.test(body)) out.push({ start: s.index + lead, end: s.index + lead + body.length, text: body });
    }
  } else {
    const re = /[^.!?\n]+(?:[.!?]+["'’”)\]]*|\n|$)/g;
    let m;
    while ((m = re.exec(text))) {
      const lead = m[0].length - m[0].trimStart().length;
      const body = m[0].trim();
      if (/[\p{L}\p{N}]/u.test(body)) out.push({ start: m.index + lead, end: m.index + lead + body.length, text: body });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

// Word-level diff (LCS) for the review dialog: [{op: 'eq'|'del'|'ins', s}].
export function diffWords(a, b) {
  const A = a.match(/\s+|[^\s]+/g) || [], B = b.match(/\s+|[^\s]+/g) || [];
  if (A.length * B.length > 9e6) return [{ op: 'del', s: a }, { op: 'ins', s: b }];
  const n = A.length, m = B.length, W = m + 1;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const out = [];
  const push = (op, s) => { const last = out[out.length - 1]; if (last && last.op === op) last.s += s; else out.push({ op, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('eq', A[i]); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return out;
}

export const paragraphs = (t) => String(t).split(/\n\s*\n/).filter((p) => p.trim()).length;

// Grammar checks for rewrite candidates with Harper (Automattic, Apache-2.0): rule-based, offline, WASM.
// Messages in : {id, type: 'lint', texts: string[]}
// Messages out: {id, ok: true, lints: [[{start, end, kind, message, problem}]]} | {id, error}
import { LocalLinter, Dialect } from '../vendor/harper/index.js';
import { slimBinary } from '../vendor/harper/slimBinary.js';

// Words Harper's dictionary does not know but Indian lending answers use all the time.
const DOMAIN_WORDS = ['NBFC', 'NBFCs', 'NPA', 'NPAs', 'GNPA', 'NNPA', 'MSME', 'MSMEs', 'DSA', 'DSAs', 'LTV', 'EMI', 'EMIs', 'RBI',
  'SEBI', 'CRAR', 'ECL', 'PSL', 'KYC', 'CIBIL', 'FY', 'crore', 'crores', 'lakh', 'lakhs', 'disbursement', 'disbursements',
  'disburse', 'disbursed', 'underwriting', 'collections', 'bps', 'Rs', 'INR', 'AUM', 'NIM', 'PCR', 'ROA', 'ROE', 'HFC', 'HFCs'];

let linter = null;
async function ready() {
  if (!linter) {
    linter = new LocalLinter({ binary: slimBinary, dialect: Dialect.Indian });
    await linter.setup();
    await linter.importWords(DOMAIN_WORDS);
  }
  return linter;
}

self.onmessage = async (e) => {
  const { id, type, texts } = e.data || {};
  try {
    if (type !== 'lint') throw new Error(`Unknown request: ${type}`);
    const l = await ready();
    const lints = [];
    for (const t of texts) {
      const found = await l.lint(t, { language: 'plaintext' });
      lints.push(found.map((x) => {
        const sp = x.span();
        const r = { start: sp.start, end: sp.end, kind: x.lint_kind(), message: x.message(), problem: x.get_problem_text() };
        x.free();
        return r;
      }));
    }
    self.postMessage({ id, ok: true, lints });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};

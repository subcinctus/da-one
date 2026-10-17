// A stand-in for a local llama.cpp server (llama-server) so the rewrite path can be tested end to end
// without a 13 GB model. It answers /health, /v1/models, /completion and /v1/chat/completions, and
// rewrites known sentences from REWRITES (several versions each, cycling), otherwise echoes the input.
//   node tests/e2e/fake-llm.mjs [port] [model-id]
import http from 'http';

const port = Number(process.argv[2] || 18080);
const model = process.argv[3] || 'humanizer-12b-Q8_0.gguf';
const chatModel = process.argv[4] || '';  // a second, instruction-following model (as LM Studio or Ollama can list)
export const REWRITES = [
  [/^In today's dynamic lending landscape/, [
    'Growing a retail mortgage book is a balancing act: you push for growth, but you watch credit closely.',
    'You cannot grow a retail mortgage book on ambition alone; prudence has to keep pace.',
    "We grow the mortgage book carefully, because the losses from a bad year last for many years.",
  ]],
  [/^First and foremost, it is important to leverage data-driven underwriting/, [
    'We underwrite on data, and we look hardest at Tier 2 and Tier 3 cities, where demand for affordable housing keeps rising.',
    'Data drives our underwriting, especially in Tier 2 and Tier 3 cities, where demand for affordable housing keeps rising.',
    'Our underwriting leans on data to find good borrowers in Tier 2 and Tier 3 cities, where demand for affordable housing keeps rising.',
  ]],
  [/^Moreover, fostering strong partnerships with builders and DSAs/, [
    'Builders and DSAs bring us most of our good customers, so we stay close to them.',
    'Most of our good customers come through builders and DSAs, which is why those relationships matter.',
    'We work closely with builders and DSAs, since they bring in quality customers at scale.',
  ]],
  [/^Furthermore, robust early-warning systems and proactive collection strategies/, [
    'Early-warning signals and calls made before a customer slips are what keep GNPA below 1.5%.',
    'What keeps GNPA below 1.5% is simple: early warnings, and collection calls made in time.',
    'We keep GNPA below 1.5% by spotting stress early and calling customers before they miss a payment.',
  ]],
  [/^By seamlessly integrating technology across the loan lifecycle/, [
    'Technology helps at every step, from sourcing to disbursement and servicing, and it cuts turnaround time for customers.',
    'From sourcing to disbursement and servicing, technology cuts turnaround time and makes the customer experience better.',
    'Lenders that use technology from sourcing to disbursement and servicing can reduce turnaround time and serve customers better.',
  ]],
  [/^Ultimately, sustainable growth is not just about volumes/, [
    'Volume matters, but what we are really building is a franchise that lasts and creates long-term value for all stakeholders.',
    'Growth that lasts is about building a franchise that delivers long-term value for all stakeholders, not just about volumes.',
    'In the end we want a franchise that delivers long-term value for all stakeholders, and volumes are only part of that.',
  ]],
];
const counters = new Map();
function rewrite(text) {
  const src = text.trim();
  for (const [re, outs] of REWRITES) {
    if (re.test(src)) { const k = re.source; const n = counters.get(k) || 0; counters.set(k, n + 1); return outs[n % outs.length]; }
  }
  return src;
}
// the sentence to rewrite: the last quoted or marked sentence in the prompt, else the longest line
function target(prompt) {
  const s = String(prompt);
  const known = REWRITES.map(([re]) => s.split(/\n|"|“|”|⟦|⟧/).map((x) => x.trim()).find((x) => re.test(x))).find(Boolean);
  if (known) return known;
  return s.split('\n').map((x) => x.trim()).sort((a, b) => b.length - a.length)[0] || '';
}

// Interview mode: keep the paragraph exactly and add the author's answers, as a careful chat model would.
function interview(msg) {
  const para = (msg.match(/My paragraph:\n([\s\S]*?)\n\n/) || [])[1];
  const answers = ((msg.match(/My answers[^\n]*\n([\s\S]*?)(?:\n\n|$)/) || [])[1] || '').split('\n')
    .map((l) => l.replace(/^- /, '').trim()).filter((l) => l && l !== '(none)');
  if (!para) return null;
  return `${para.trim()} ${answers.map((a) => `In our case, ${a.replace(/[.\s]+$/, '')}.`).join(' ')}`.trim();
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    const url = req.url.split('?')[0];
    if (url === '/health') return send(200, { status: 'ok' });
    if (url === '/v1/models' || url === '/models') return send(200, { object: 'list', data: [model, chatModel].filter(Boolean).map((id) => ({ id, object: 'model' })) });
    if (url === '/props') return send(200, { model_path: model, default_generation_settings: { n_ctx: 8192 } });
    if (url === '/completion') return send(200, { content: rewrite(target(j.prompt)), stop: true });
    if (url === '/v1/completions') return send(200, { choices: [{ text: rewrite(target(j.prompt)), index: 0, finish_reason: 'stop' }] });
    if (url === '/v1/chat/completions') {
      const msg = (j.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const n = Math.max(1, j.n || 1);
      const reply = () => interview(msg) ?? rewrite(target(msg));
      return send(200, { choices: Array.from({ length: n }, (_, i) => ({ index: i, message: { role: 'assistant', content: reply() }, finish_reason: 'stop' })) });
    }
    send(404, { error: 'not found' });
  });
}).listen(port, '127.0.0.1', () => console.log(`fake llm on http://127.0.0.1:${port} (${[model, chatModel].filter(Boolean).join(', ')})`));

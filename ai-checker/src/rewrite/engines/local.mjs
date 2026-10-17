// Local rewriter: llama.cpp's llama-server on this computer (or LM Studio / Ollama through their
// OpenAI-compatible API). The Humanizer-12B model (sgaofen/humanizer-local-model, Apache-2.0) is a
// plain completion model, so it gets its exact prompt on the raw completion endpoint; any other model
// gets the chat prompts. Browser APIs used: fetch, AbortController, navigator.permissions.
import { humanizerPrompt, HUMANIZER_SAMPLING, forModel } from '../prompts.mjs';
import { abortError } from '../loop.mjs';

export const DEFAULT_PORTS = [8080, 1234, 11434];  // llama-server, LM Studio, Ollama
// The model card's own command (README "Option 2"). llama-server answers any site by default (it
// reflects the Origin header), so no CORS flag is needed. 16 GB machines: humanizer-12b-Q6_K.gguf.
export const SETUP_COMMAND = 'llama-server --hf-repo jialinyyzz/humanizer --hf-file humanizer-12b-Q8_0.gguf -c 8192 -np 1 -ngl 99 --port 8080';
export const TIMEOUTS = { probe: 2500, permission: 30000, candidate: 240000 };
const MAX_N = 16, LANG_TRIES = 3, CHAT_TEMPERATURE = 0.8, CHAT_TOP_P = 0.95;
const KIND_LABEL = { 'llama-server': 'llama-server', ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'a local server' };

const str = (v) => (v == null ? '' : String(v));
const isHumanizer = (model) => /humanizer/i.test(str(model));
const isQwen3 = (model) => /qwen[-_ ]?3/i.test(str(model));

export class EngineError extends Error {
  constructor(code, message) { super(message); this.name = 'EngineError'; this.code = code; }
}

// "8080", "localhost:1234", "http://127.0.0.1:8080/v1/" -> "http://127.0.0.1:8080"; null when unusable.
export function normalizeBaseUrl(v) {
  let s = str(v).trim();
  if (!s) return null;
  if (/^\d{1,5}$/.test(s)) s = `127.0.0.1:${s}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')}`;
  } catch { return null; }
}

const hostOf = (base) => { try { return new URL(base).host; } catch { return base; } };
const portOf = (base) => { try { const u = new URL(base); return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { return 0; } };
const isLoopbackHost = (h) => /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i.test(str(h)) || /\.localhost$/i.test(str(h));
const isPrivateHost = (h) => /^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/.test(str(h)) || /\.local$/i.test(str(h));

// A LAN machine by name: one label ("gpu-box") or a home/office suffix. Public names are left alone.
const isLanName = (h) => !/^[\d.]+$|^\[/.test(str(h)) && (!str(h).includes('.') || /\.(?:lan|home|internal|intranet|corp|home\.arpa)$/i.test(str(h)));

// Chrome's Local Network Access fetch option ("loopback" or "local"): it asks the user once, and a
// plain-http LAN name gets past an https page's mixed-content block only when tagged. Browsers
// without it ignore the unknown option.
function addressSpace(base) {
  try {
    const h = new URL(base).hostname;
    return isLoopbackHost(h) ? 'loopback' : isPrivateHost(h) || isLanName(h) ? 'local' : undefined;
  } catch { return undefined; }
}

const validPorts = (ports) => {
  const list = Array.isArray(ports) ? ports.map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536) : [];
  return list.length ? [...new Set(list)] : DEFAULT_PORTS;
};
// Not a rewriter: embedding and reranking models that Ollama and LM Studio list beside chat models.
const NOT_CHAT = /embed|rerank|(?:^|[/:_-])bge[-_]|minilm/i;
// llama-server's router lists cached models that failed to load or are still downloading.
const broken = (m) => !!(m.status?.failed || /^(?:incomplete|downloading|failed)$/i.test(str(m.status?.value ?? m.status)));

// Chrome 142-144 call the permission "local-network-access"; 145+ split it into "loopback-network"
// (apps on this device) and "local-network". Unknown names throw, so try each.
async function permissionState(permissions, space) {
  if (!permissions?.query || !space) return 'unknown';
  const names = space === 'loopback' ? ['loopback-network', 'local-network-access'] : ['local-network', 'local-network-access'];
  for (const name of names) {
    try { const st = await permissions.query({ name }); if (st?.state) return st.state; } catch { /* not this browser's name */ }
  }
  return 'unknown';
}

// One signal for the caller's abort and our own timeout.
function linked(signal, ms) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = ms > 0 && Number.isFinite(ms) ? setTimeout(() => { timedOut = true; ctl.abort(); }, ms) : null;
  const onAbort = () => ctl.abort(signal.reason);
  if (signal?.aborted) ctl.abort(signal.reason);
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  return { signal: ctl.signal, timedOut: () => timedOut, done: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); } };
}

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
// llama-server and LM Studio send {error: {message}}, Ollama {error: "..."}
const errText = (j, text) => str(j?.error?.message ?? (typeof j?.error === 'string' ? j.error : '')).trim() || str(text).trim().slice(0, 200);

export function createLocalEngine(opts = {}) {
  const st = { base: normalizeBaseUrl(opts.baseUrl), ports: validPorts(opts.ports), server: null, noSpace: false };
  const doFetch = (url, init) => (opts.fetch || globalThis.fetch)(url, init);
  const timeouts = { ...TIMEOUTS, ...opts.timeouts };
  const permissions = () => ('permissions' in opts ? opts.permissions : globalThis.navigator?.permissions);
  const pageOrigin = () => ('origin' in opts ? opts.origin : globalThis.location?.origin) || '';
  const pageHost = () => { try { return new URL(pageOrigin()).hostname; } catch { return ''; } };
  const onWindows = () => /^win/i.test(str('platform' in opts ? opts.platform : globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform));

  const bases = () => [...new Set([st.base, ...st.ports.map((p) => `http://127.0.0.1:${p}`)].filter(Boolean))];

  // GET/POST with a timeout. Network failures become EngineError('network'), our timeout 'timeout'.
  async function call(url, { method = 'GET', body, signal, timeout, mode } = {}) {
    if (signal?.aborted) throw abortError(signal);
    const l = linked(signal, timeout);
    const init = { method, signal: l.signal, cache: 'no-store' };
    const space = addressSpace(url);
    if (space && !st.noSpace) init.targetAddressSpace = space;
    if (mode) init.mode = mode;
    if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    try {
      let res;
      try { res = await doFetch(url, init); } catch (err) {
        // a browser that knows the option but not this value refuses before sending anything
        if (!init.targetAddressSpace || !/targetAddressSpace|IPAddressSpace/.test(str(err?.message))) throw err;
        st.noSpace = true;
        delete init.targetAddressSpace;
        res = await doFetch(url, init);
      }
      if (mode === 'no-cors') return { status: res.status, ok: true, json: null, text: '' };
      const text = await res.text();
      return { status: res.status, ok: res.ok, json: parse(text), text };
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      if (l.timedOut()) throw new EngineError('timeout', `No answer from ${hostOf(url)} in time.`);
      throw new EngineError('network', str(err?.message || err));
    } finally { l.done(); }
  }

  // What is listening at one address: {ok, base, kind, model, models} or {ok: false, base, why, kind?}.
  async function probeOne(base, timeout, signal) {
    const get = (path) => call(base + path, { signal, timeout });
    let kind = null, health;
    try { health = await get('/health'); } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err.code === 'timeout') return { ok: false, base, why: 'timeout' };
      // CORS hides every answer; an opaque no-cors request still succeeds when something listens.
      try { await call(`${base}/health`, { signal, timeout, mode: 'no-cors' }); return { ok: false, base, why: 'cors' }; } catch (e2) {
        if (e2.name === 'AbortError') throw e2;
        return { ok: false, base, why: e2.code === 'timeout' ? 'timeout' : 'network' };
      }
    }
    if (health.status === 503) return { ok: false, base, why: 'loading', kind: 'llama-server' };
    if (health.status === 401 || health.status === 403) return { ok: false, base, why: 'auth' };
    if (health.ok && health.json?.status === 'ok') kind = 'llama-server';
    let models = [];
    const list = await get('/v1/models').catch((e) => { if (e.name === 'AbortError') throw e; return null; });
    if (list && (list.status === 401 || list.status === 403)) return { ok: false, base, why: 'auth', kind };
    if (list?.ok && Array.isArray(list.json?.data)) models = list.json.data.filter((m) => m && m.id != null);
    if (!models.length && kind === 'llama-server') {
      // older llama-server builds: the loaded file is in /props
      const props = await get('/props').catch((e) => { if (e.name === 'AbortError') throw e; return null; });
      const id = props?.json?.model_alias || props?.json?.model_path;
      if (id) models = [{ id: String(id) }];
    }
    if (!kind) {
      const ver = await get('/api/version').catch((e) => { if (e.name === 'AbortError') throw e; return null; });
      if (ver?.ok && typeof ver.json?.version === 'string') kind = 'ollama';
      else if (models.some((m) => m.owned_by === 'organization_owner')) kind = 'lmstudio';
      else if (list?.ok && Array.isArray(list.json?.data)) kind = 'openai';
      else return { ok: false, base, why: 'unknown' };
    }
    const usable = models.filter((m) => !NOT_CHAT.test(shortModel(m.id)) && !broken(m));  // the name, not its folder
    if (!usable.length) return { ok: false, base, why: 'no-model', kind };
    const loaded = (m) => !m.status || m.status === 'loaded' || m.status?.value === 'loaded';
    const best = (ms) => ms.find(loaded) || ms[0];
    const pick = best(usable.filter((m) => isHumanizer(m.id))) || best(usable);
    // a chat model on the same server, for requests the humanizer cannot serve (Interview mode)
    const chat = isHumanizer(pick.id) ? best(usable.filter((m) => !isHumanizer(m.id))) : pick;
    return { ok: true, base, kind, model: String(pick.id), humanizer: isHumanizer(pick.id), chat: chat ? String(chat.id) : null, models: models.map((m) => String(m.id)) };
  }

  function explain(why, base, kind) {
    const where = hostOf(base);
    const origin = pageOrigin() || 'this site’s address';
    switch (why) {
      case 'loading': return `llama-server at ${where} is still loading the model. Wait a minute, then check again.`;
      case 'auth': return `The server at ${where} asks for an API key (it was started with --api-key). Restart it without --api-key; this page does not send keys.`;
      case 'no-model': return `${KIND_LABEL[kind] || 'The server'} at ${where} is running but has no model loaded. Load the Humanizer model (or any chat model), then check again.`;
      case 'cors':
        if (portOf(base) === 11434) {
          // the POSIX "VAR=x cmd" form fails in PowerShell and cmd
          const cmd = onWindows() ? `PowerShell with: $env:OLLAMA_ORIGINS="${origin}"; ollama serve` : `Terminal with: OLLAMA_ORIGINS="${origin}" ollama serve`;
          return `Ollama is running at ${where} but does not accept requests from this site. Quit Ollama, then start it from ${cmd}`;
        }
        if (portOf(base) === 1234) return `LM Studio’s server is running at ${where} but blocks this site. In LM Studio open Developer → Server settings, turn on “Enable CORS”, then check again.`;
        return `A server is running at ${where} but refuses requests from this site (CORS). llama-server accepts every site unless it was started with --agent, --tools or --cors-origins: restart it without those flags, or add --cors-origins ${origin}`;
      case 'lna-denied': return 'Chrome is blocking this site from talking to apps on this computer. Click the icon to the left of the address bar, open Site settings, set “Apps on device” (older Chrome: “Local network access”) to Allow, then reload the page.';
      case 'lna-prompt': return 'Chrome is asking whether this site may connect to apps on this device. Choose Allow, then check again.';
      default: return `No local rewriter answered on this computer (looked at ${bases().map(hostOf).join(', ')}). Start llama-server (see “How to set it up”) and check again. If it is running, the browser may be blocking this site from reaching it: Chrome and Edge ask first; Safari may block it outright.`;
    }
  }

  async function probe({ signal } = {}) {
    st.server = null;
    const list = bases();
    if (!list.length) return { ok: false, code: 'not-running', detail: explain('none') };
    const space = addressSpace(list[0]);
    const local = isLoopbackHost(pageHost());  // a page served from this machine needs no permission
    const perm = local ? 'granted' : await permissionState(permissions(), space);
    if (perm === 'denied') return { ok: false, code: 'lna-denied', detail: explain('lna-denied') };
    // while Chrome shows its prompt the request waits for the answer, so give the user time
    const timeout = perm === 'prompt' ? timeouts.permission : timeouts.probe;
    // the address the owner set comes first; the usual ports are only tried when it does not answer
    // (each refused port is a red line in the browser console, which nothing can suppress)
    const first = st.base ? [await probeOne(st.base, timeout, signal)] : [];
    const found = first[0]?.ok ? first : [...first, ...(await Promise.all(list.filter((b) => b !== st.base).map((b) => probeOne(b, timeout, signal))))];
    const hit = found.find((r) => r.ok);
    if (hit) {
      st.server = hit;
      const name = hit.humanizer ? 'Humanizer 12B' : shortModel(hit.model);
      const note = hit.humanizer ? '' : ' (a chat model; Humanizer 12B rewrites more naturally)';
      return { ok: true, code: 'ok', detail: `${name} on ${KIND_LABEL[hit.kind]} at ${hostOf(hit.base)}${note}`, server: hit.kind, model: hit.model, url: hit.base, humanizer: hit.humanizer, chatModel: hit.chat };
    }
    const order = ['loading', 'auth', 'no-model', 'cors', 'timeout', 'unknown', 'network'];
    const worst = found.slice().sort((a, b) => order.indexOf(a.why) - order.indexOf(b.why))[0];
    if (worst.why === 'timeout' || worst.why === 'network') {
      const now = local ? 'granted' : await permissionState(permissions(), space);
      if (now === 'denied') return { ok: false, code: 'lna-denied', detail: explain('lna-denied') };
      if (now === 'prompt' && worst.why === 'timeout') return { ok: false, code: 'lna-prompt', detail: explain('lna-prompt') };
    }
    const code = worst.why === 'timeout' || worst.why === 'unknown' || worst.why === 'network' ? 'not-running' : worst.why;
    return { ok: false, code, detail: explain(worst.why, worst.base, worst.kind) };
  }

  // A failed request: 'hard' means the server itself is unusable, so later requests would fail too.
  function httpError(srv, r, what) {
    const msg = errText(r.json, r.text);
    if (r.status === 503) return Object.assign(new EngineError('loading', `The local server is still loading the model${msg ? ` (${msg})` : ''}.`), { hard: true });
    if (r.status === 401 || r.status === 403) return Object.assign(new EngineError('auth', explain('auth', srv.base)), { hard: true });
    if (r.status === 404) return Object.assign(new EngineError('http', `The local server has no ${what} endpoint or model${msg ? ` (${msg})` : ''}.`), { hard: true });
    return new EngineError('http', `The local server answered HTTP ${r.status}${msg ? `: ${msg}` : ''}.`);
  }

  // srv is passed along, not read from st: a probe may run while a rewrite is under way
  async function post(srv, path, body, signal) {
    const r = await call(srv.base + path, { method: 'POST', body, signal, timeout: timeouts.candidate });
    if (!r.ok) throw httpError(srv, r, path);
    if (!r.json) throw new EngineError('bad-reply', 'The local server sent a reply that is not JSON.');
    return r.json;
  }

  // One raw completion of the humanizer prompt, on whichever API the server speaks.
  async function completeOnce(srv, text, maxTokens, signal) {
    const prompt = humanizerPrompt(text), n = humanizerTokens(text, maxTokens);
    const s = HUMANIZER_SAMPLING;
    // the model card: no stop strings ("###" can occur in real output); generation ends at EOS
    // "model" routes the request in llama-server's router mode; a single-model server ignores it
    if (srv.kind === 'llama-server') return str((await post(srv, '/completion', { model: srv.model, prompt, ...s, n_predict: n, stream: false }, signal)).content);
    if (srv.kind === 'ollama') {
      const options = { temperature: s.temperature, top_p: s.top_p, top_k: s.top_k, min_p: s.min_p, repeat_penalty: s.repeat_penalty, num_predict: n };
      return str((await post(srv, '/api/generate', { model: srv.model, prompt, raw: true, stream: false, options }, signal)).response);
    }
    return str((await post(srv, '/v1/completions', { model: srv.model, prompt, ...s, max_tokens: n, stream: false }, signal)).choices?.[0]?.text);
  }

  async function humanize(srv, text, maxTokens, signal) {
    for (let k = 0; k < LANG_TRIES; k++) {
      const out = (await completeOnce(srv, text, maxTokens, signal)).trim();
      if (!out || /### Rewritten:|^Rewrite the text below/.test(out)) return '';  // wrong endpoint or template
      if (!wrongLanguage(text, out)) return out;  // the model card: resample a Chinese reply to an English draft
    }
    return '';
  }

  async function chatOnce(srv, model, req, signal) {
    const qwen = isQwen3(model);
    const r = qwen ? forModel({ system: str(req.system), user: str(req.user) }, model) : req;
    const messages = [];
    if (str(r.system).trim()) messages.push({ role: 'system', content: str(r.system) });
    messages.push({ role: 'user', content: str(r.user) });
    const body = {
      model, messages, stream: false, top_p: CHAT_TOP_P,
      temperature: Number.isFinite(req.temperature) ? req.temperature : CHAT_TEMPERATURE,
      max_tokens: Math.max(16, Math.min(4096, Math.trunc(Number(req.maxTokens)) || 400)),
    };
    if (qwen && srv.kind === 'llama-server') body.chat_template_kwargs = { enable_thinking: false };
    const content = (await post(srv, '/v1/chat/completions', body, signal)).choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  }

  const forget = (srv) => { if (st.server?.base === srv.base) st.server = null; };  // the next run probes again

  async function generate(requests, { signal, onProgress } = {}) {
    if (signal?.aborted) throw abortError(signal);
    const reqs = [].concat(requests ?? []);
    if (!reqs.length) return [];
    let srv = st.server;
    if (!srv) {
      const p = await probe({ signal });
      if (!p.ok) throw new EngineError(p.code, p.detail);
      srv = { base: p.url, kind: p.server, model: p.model, humanizer: p.humanizer, chat: p.chatModel };
    }
    // the humanizer rewrites the draft itself (req.text); chat models follow the prompt (req.user),
    // so a request with no draft goes to a chat model on the same server when there is one
    const chatModel = srv.humanizer ? srv.chat : srv.model;
    const route = (r) => (!r || typeof r !== 'object' ? null : srv.humanizer && str(r.text).trim() ? 'humanize'
      : chatModel && str(r.user).trim() ? 'chat' : null);
    if (srv.humanizer && !reqs.some(route) && reqs.some((r) => str(r?.user).trim())) {
      throw new EngineError('needs-chat-model', 'The Humanizer model only rewrites text as it stands, so it cannot follow these instructions. Load a chat model in the local server, or use the in-browser model or a Claude chat.');
    }
    const report = (p) => { try { onProgress?.(p); } catch { /* the page's logger must not stop a rewrite */ } };
    const count = (r) => Math.max(1, Math.min(MAX_N, Math.trunc(Number(r?.n)) || 1));
    const total = reqs.reduce((a, r) => a + count(r), 0);
    const out = reqs.map(() => []);
    let done = 0, good = 0, failed = 0, hardInRow = 0, firstErr = null;
    const name = reqs.some((r) => route(r) === 'humanize') ? 'Humanizer 12B' : shortModel(chatModel);
    report({ message: `Writing ${total} version${total === 1 ? '' : 's'} with ${name} on ${KIND_LABEL[srv.kind]}…`, done, total });
    outer: for (let k = 0; k < reqs.length; k++) {
      const req = reqs[k];
      for (let c = 0; c < count(req); c++) {
        if (signal?.aborted) throw abortError(signal);
        try {
          const how = route(req);
          const t = !how ? '' : how === 'humanize' ? await humanize(srv, str(req.text), req.maxTokens, signal) : await chatOnce(srv, chatModel, req, signal);
          if (t) { out[k].push(t); good++; } else failed++;
          hardInRow = 0;
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) throw abortError(signal);
          failed++;
          firstErr = firstErr || err;
          // a dead or misconfigured server fails every request: stop after two in a row
          hardInRow = err?.hard || err?.code === 'network' || err?.code === 'timeout' ? hardInRow + 1 : 0;
          if (hardInRow >= 2) { forget(srv); break outer; }
        }
        done++;
        report({ done, total });
      }
    }
    if (!good && firstErr) {
      if (firstErr.code === 'network') {
        forget(srv);
        throw new EngineError('not-running', `The local server stopped answering at ${hostOf(srv.base)}. Check that it is still running, then try again.`);
      }
      if (firstErr.code === 'timeout') {
        throw new EngineError('timeout', `The local server at ${hostOf(srv.base)} took more than ${Math.round(timeouts.candidate / 60000)} minutes for one version. It may be running on the processor only (start it with -ngl 99), or the model may be too large for this computer.`);
      }
      throw firstErr;
    }
    if (failed) report({ message: `${failed} of ${total} version${total === 1 ? '' : 's'} could not be written and ${failed === 1 ? 'was' : 'were'} skipped.`, done, total });
    return out;
  }

  return {
    id: 'local',
    label: 'Local rewriter on this computer',
    probe,
    generate,
    configure({ baseUrl, ports } = {}) {
      st.base = normalizeBaseUrl(baseUrl);
      if (Array.isArray(ports) && ports.length) st.ports = validPorts(ports);
      st.server = null;
    },
    get server() { return st.server ? { ...st.server } : null; },
  };
}

// The model card's rule: about 2.5x the draft's tokens, between 256 and 2048. Three characters a
// token is generous on purpose: digits, ₹ and Indian grouping split into many tokens.
export function humanizerTokens(text, maxTokens = 0) {
  const est = Math.ceil(str(text).length / 3);
  return Math.max(256, Math.min(2048, Math.max(Math.ceil(est * 2.5), Math.trunc(Number(maxTokens)) || 0)));
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;  // kana, CJK ideographs, Hangul
const cjk = (s) => (str(s).match(CJK) || []).length;
// The model card: on short English drafts it sometimes answers in Chinese; more than a few characters means resample.
export const wrongLanguage = (draft, out) => cjk(draft) === 0 && cjk(out) > 3;

export function shortModel(id) {
  const s = str(id).split(/[\\/]/).pop().replace(/\.gguf$/i, '');
  return s || 'the loaded model';
}

export const engine = createLocalEngine();
export default engine;

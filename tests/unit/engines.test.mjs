import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as localMod from '../../ai-checker/src/rewrite/engines/local.mjs';
import * as webllmMod from '../../ai-checker/src/rewrite/engines/webllm.mjs';
import * as manualMod from '../../ai-checker/src/rewrite/engines/manual.mjs';
import { humanizerPrompt, batchVariantsPrompt } from '../../ai-checker/src/rewrite/prompts.mjs';

const {
  createLocalEngine, normalizeBaseUrl, humanizerTokens, wrongLanguage, shortModel, SETUP_COMMAND, DEFAULT_PORTS,
} = localMod;
const { chooseModel, smallerModels, readLimits, modelLabel, createWebLLMEngine, QWEN3_MODELS, WEBLLM_VERSION, FIT } = webllmMod;
const { createManualEngine } = manualMod;

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const ORIGIN = 'https://desk.example.github.io';
const SENT = 'Our GNPA fell to 1.5% in FY24, and we disbursed ₹1,00,000 crore through 1,200 DSAs.';
const HUMANIZER_ID = '/Users/me/Library/Caches/llama.cpp/jialinyyzz_humanizer_humanizer-12b-Q8_0.gguf';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------- a fake localhost: base URL -> handler({path, method, body, init}) ----------
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('404 page not found', { status: 404 });
const hang = (init) => new Promise((_, reject) => {
  const fail = () => reject(new DOMException('This operation was aborted', 'AbortError'));
  if (init.signal?.aborted) fail(); else init.signal?.addEventListener('abort', fail, { once: true });
});

function mockFetch(routes) {
  const log = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const base = `${u.protocol}//${u.host}`;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ url, base, path: u.pathname, method, body, init });
    if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    const h = routes[base];
    if (!h) throw new TypeError('Failed to fetch');  // nothing listens: connection refused
    // like real fetch, an abort rejects at once even if the server is still busy
    const r = await new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
      init.signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => h({ path: u.pathname, method, body, init })).then(resolve, reject)
        .finally(() => init.signal?.removeEventListener('abort', onAbort));
    });
    // a server without CORS headers: the browser hides the answer, but an opaque no-cors request succeeds
    if (r === 'cors') { if (init.mode === 'no-cors') return new Response(''); throw new TypeError('Failed to fetch'); }
    if (r === 'refused') throw new TypeError('Failed to fetch');
    return r;
  };
  return { fetch, log, posts: () => log.filter((x) => x.method === 'POST') };
}

function llama({ model = HUMANIZER_ID, healthStatus = 200, completion, chat, models } = {}) {
  let n = 0;
  return ({ path, method, body, init }) => {
    if (path === '/health') return healthStatus === 200 ? json({ status: 'ok' }) : json({ error: { code: healthStatus, message: 'Loading model', type: 'unavailable_error' } }, healthStatus);
    if (path === '/v1/models') return json({ object: 'list', data: models || [{ id: model, object: 'model', owned_by: 'llamacpp' }] });
    if (path === '/completion' && method === 'POST') return completion ? completion(body, n++, init) : json({ content: `\n Version ${n++} of the sentence. \n` });
    if (path === '/v1/chat/completions' && method === 'POST') return chat ? chat(body, n++) : json({ choices: [{ message: { role: 'assistant', content: ` Chat version ${n++}. ` } }] });
    return notFound();
  };
}

function ollama({ models = [{ id: 'humanizer:latest', owned_by: 'library' }, { id: 'qwen3:8b', owned_by: 'library' }], generate } = {}) {
  return ({ path, method, body }) => {
    if (path === '/v1/models') return json({ object: 'list', data: models });
    if (path === '/api/version') return json({ version: '0.12.3' });
    if (path === '/api/generate' && method === 'POST') return generate ? generate(body) : json({ model: body.model, response: ' Ollama version. ', done: true });
    if (path === '/v1/chat/completions' && method === 'POST') return json({ choices: [{ message: { content: 'Ollama chat version.' } }] });
    return notFound();
  };
}

function lmstudio({ models = [{ id: 'humanizer-12b', object: 'model', owned_by: 'organization_owner' }] } = {}) {
  return ({ path, method }) => {
    if (path === '/v1/models') return json({ data: models, object: 'list' });
    if (path === '/v1/completions' && method === 'POST') return json({ choices: [{ text: ' LM Studio version. ', index: 0 }] });
    if (path === '/v1/chat/completions' && method === 'POST') return json({ choices: [{ message: { content: 'LM Studio chat version.' } }] });
    return json({ error: 'Unexpected endpoint or method.' }, 200);  // LM Studio answers unknown GETs with an error body
  };
}

const perms = (states) => ({
  query: async ({ name }) => {
    if (!(name in states)) throw new TypeError(`'${name}' is not a valid enum value of type PermissionName.`);
    return { state: typeof states[name] === 'function' ? states[name]() : states[name] };
  },
});

const local = (routes, opts = {}) => {
  const m = mockFetch(routes);
  const eng = createLocalEngine({ fetch: m.fetch, permissions: null, origin: ORIGIN, platform: 'MacIntel', timeouts: { probe: 300, permission: 600, candidate: 2000 }, ...opts });
  return { eng, ...m };
};
const H = (text = SENT, extra = {}) => ({ system: 'sys', user: `Rewrite: ${text}`, n: 1, maxTokens: 220, text, ...extra });

// ======================================================================================
describe('local engine: helpers', () => {
  test('normalizeBaseUrl accepts ports, hosts and full URLs, and rejects junk', () => {
    assert.equal(normalizeBaseUrl('8080'), 'http://127.0.0.1:8080');
    assert.equal(normalizeBaseUrl(' 1234 '), 'http://127.0.0.1:1234');
    assert.equal(normalizeBaseUrl('localhost:11434'), 'http://localhost:11434');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/api/v1'), 'http://127.0.0.1:8080/api');
    assert.equal(normalizeBaseUrl('https://gpu-box.local:8443'), 'https://gpu-box.local:8443');
    assert.equal(normalizeBaseUrl('192.168.1.20:8080'), 'http://192.168.1.20:8080');
    for (const bad of ['', '   ', null, undefined, 'ftp://127.0.0.1:8080', 'http://', 'http://not a host']) assert.equal(normalizeBaseUrl(bad), null, String(bad));
  });

  test('humanizerTokens follows the model card: 2.5x the draft, between 256 and 2048', () => {
    assert.equal(humanizerTokens(''), 256);
    assert.equal(humanizerTokens('Short sentence.'), 256);
    const mid = 'x'.repeat(600);  // 200 tokens at 3 chars a token -> 500
    assert.equal(humanizerTokens(mid), 500);
    assert.equal(humanizerTokens('x'.repeat(20000)), 2048);
    assert.equal(humanizerTokens('Short.', 600), 600, 'a larger request maxTokens wins');
    assert.equal(humanizerTokens('Short.', 99999), 2048);
    assert.equal(humanizerTokens('Short.', 'junk'), 256);
    assert.equal(humanizerTokens(null), 256);
  });

  test('wrongLanguage flags Chinese replies to English drafts only', () => {
    assert.equal(wrongLanguage(SENT, 'Our GNPA fell to 1.5% in FY24.'), false);
    assert.equal(wrongLanguage(SENT, '我们的不良贷款率在2024财年降至1.5%。'), true);
    assert.equal(wrongLanguage(SENT, 'GNPA (不良) fell.'), false, 'a few characters are fine');
    assert.equal(wrongLanguage('我们的不良贷款率下降了。', '我们的不良贷款率下降了很多。'), false);
    assert.equal(wrongLanguage(SENT, '日本語の文章です'), true);
  });

  test('shortModel shows a file name, not a path', () => {
    assert.equal(shortModel(HUMANIZER_ID), 'jialinyyzz_humanizer_humanizer-12b-Q8_0');
    assert.equal(shortModel('C:\\models\\Qwen3-8B-Q4_K_M.gguf'), 'Qwen3-8B-Q4_K_M');
    assert.equal(shortModel('qwen3:8b'), 'qwen3:8b');
    assert.equal(shortModel(''), 'the loaded model');
  });

  test('module exports the engine the page looks for, plus the setup command', () => {
    assert.equal(localMod.engine.id, 'local');
    assert.equal(localMod.default, localMod.engine);
    assert.equal(typeof localMod.engine.probe, 'function');
    assert.equal(typeof localMod.engine.generate, 'function');
    assert.equal(typeof localMod.engine.configure, 'function');
    assert.ok(localMod.engine.label);
    assert.deepEqual(DEFAULT_PORTS, [8080, 1234, 11434]);
    assert.match(SETUP_COMMAND, /^llama-server --hf-repo jialinyyzz\/humanizer --hf-file humanizer-12b-Q8_0\.gguf /);
    assert.match(SETUP_COMMAND, /--port 8080/);
    // llama-server already answers every origin; a CORS flag would only narrow it
    assert.doesNotMatch(SETUP_COMMAND, /cors|--agent|--tools|--api-key/);
  });
});

// ======================================================================================
describe('local engine: probe', () => {
  test('finds llama-server with the Humanizer model', async () => {
    const { eng, log } = local({ 'http://127.0.0.1:8080': llama() });
    const p = await eng.probe();
    assert.equal(p.ok, true);
    assert.equal(p.server, 'llama-server');
    assert.equal(p.humanizer, true);
    assert.equal(p.model, HUMANIZER_ID);
    assert.equal(p.url, 'http://127.0.0.1:8080');
    assert.match(p.detail, /Humanizer 12B on llama-server at 127\.0\.0\.1:8080/);
    // every default port was tried, with GETs and the loopback address-space hint
    for (const port of DEFAULT_PORTS) assert.ok(log.some((x) => x.url === `http://127.0.0.1:${port}/health`), `port ${port}`);
    for (const x of log) {
      assert.equal(x.method, 'GET');
      assert.equal(x.init.targetAddressSpace, 'loopback');
      assert.equal(x.body, undefined);
    }
    assert.equal(eng.server.kind, 'llama-server');
  });

  test('prefers a humanizer model, then a loaded one, in a multi-model list', async () => {
    const models = [{ id: 'Qwen3-8B', status: { value: 'unloaded' } }, { id: 'gemma-3', status: { value: 'loaded' } }, { id: 'Humanizer-12B-Q6_K' }];
    let p = await local({ 'http://127.0.0.1:8080': llama({ models }) }).eng.probe();
    assert.equal(p.model, 'Humanizer-12B-Q6_K');
    assert.equal(p.humanizer, true);
    p = await local({ 'http://127.0.0.1:8080': llama({ models: models.slice(0, 2) }) }).eng.probe();
    assert.equal(p.model, 'gemma-3');
    assert.equal(p.humanizer, false);
    assert.match(p.detail, /chat model/);
  });

  test('a llama-server that is still loading says so', async () => {
    const p = await local({ 'http://127.0.0.1:8080': llama({ healthStatus: 503 }) }).eng.probe();
    assert.equal(p.ok, false);
    assert.equal(p.code, 'loading');
    assert.match(p.detail, /still loading the model/);
  });

  test('old llama-server without /v1/models: model from /props', async () => {
    const h = ({ path }) => (path === '/health' ? json({ status: 'ok' }) : path === '/props' ? json({ model_path: '/m/humanizer-12b-Q4_K_M.gguf' }) : notFound());
    const p = await local({ 'http://127.0.0.1:8080': h }).eng.probe();
    assert.equal(p.ok, true);
    assert.equal(p.model, '/m/humanizer-12b-Q4_K_M.gguf');
    assert.equal(p.humanizer, true);
  });

  test('a server with no model loaded', async () => {
    const p = await local({ 'http://127.0.0.1:8080': llama({ models: [] }) }).eng.probe();
    assert.equal(p.ok, false);
    assert.equal(p.code, 'no-model');
    assert.match(p.detail, /no model loaded/);
  });

  test('a server started with --api-key', async () => {
    const h = ({ path }) => (path === '/health' ? json({ status: 'ok' }) : json({ error: { code: 401, message: 'Invalid API Key', type: 'authentication_error' } }, 401));
    const p = await local({ 'http://127.0.0.1:8080': h }).eng.probe();
    assert.equal(p.code, 'auth');
    assert.match(p.detail, /--api-key/);
  });

  test('recognises Ollama and LM Studio', async () => {
    let p = await local({ 'http://127.0.0.1:11434': ollama() }).eng.probe();
    assert.equal(p.ok, true);
    assert.equal(p.server, 'ollama');
    assert.equal(p.model, 'humanizer:latest');
    assert.match(p.detail, /on Ollama at 127\.0\.0\.1:11434/);
    p = await local({ 'http://127.0.0.1:11434': ollama({ models: [{ id: 'qwen3:8b' }] }) }).eng.probe();
    assert.equal(p.model, 'qwen3:8b');
    assert.equal(p.humanizer, false);
    p = await local({ 'http://127.0.0.1:1234': lmstudio() }).eng.probe();
    assert.equal(p.server, 'lmstudio');
    assert.match(p.detail, /LM Studio/);
  });

  test('a configured address is tried first and wins over the defaults', async () => {
    const { eng, log } = local({ 'http://127.0.0.1:9090': llama({ model: 'my-chat-model' }), 'http://127.0.0.1:8080': llama() });
    eng.configure({ baseUrl: '9090' });
    const p = await eng.probe();
    assert.equal(p.url, 'http://127.0.0.1:9090');
    assert.equal(p.model, 'my-chat-model');
    assert.equal(log[0].base, 'http://127.0.0.1:9090');
    eng.configure({ baseUrl: undefined });
    assert.equal((await eng.probe()).url, 'http://127.0.0.1:8080');
  });

  test('a LAN address is tagged as a local (not loopback) request', async () => {
    const { eng, log } = local({ 'http://192.168.1.20:8080': llama() });
    eng.configure({ baseUrl: '192.168.1.20:8080' });
    assert.equal((await eng.probe()).ok, true);
    assert.equal(log.find((x) => x.base === 'http://192.168.1.20:8080').init.targetAddressSpace, 'local');
  });

  test('nothing running: a clear "start the server" message', async () => {
    const p = await local({}).eng.probe();
    assert.equal(p.ok, false);
    assert.equal(p.code, 'not-running');
    assert.match(p.detail, /No local rewriter answered/);
    assert.match(p.detail, /127\.0\.0\.1:8080, 127\.0\.0\.1:1234, 127\.0\.0\.1:11434/);
    assert.match(p.detail, /How to set it up/);
  });

  test('CORS: running but blocked, with advice for each server', async () => {
    let p = await local({ 'http://127.0.0.1:8080': () => 'cors' }).eng.probe();
    assert.equal(p.code, 'cors');
    assert.match(p.detail, /refuses requests from this site/);
    assert.match(p.detail, /--cors-origins https:\/\/desk\.example\.github\.io/);
    assert.match(p.detail, /accepts every site unless/);
    p = await local({ 'http://127.0.0.1:11434': () => 'cors' }).eng.probe();
    assert.match(p.detail, /OLLAMA_ORIGINS="https:\/\/desk\.example\.github\.io" ollama serve/);
    p = await local({ 'http://127.0.0.1:1234': () => 'cors' }).eng.probe();
    assert.match(p.detail, /Enable CORS/);
  });

  test('CORS check uses an opaque no-cors request only after the normal one fails', async () => {
    const { eng, log } = local({ 'http://127.0.0.1:8080': () => 'cors' });
    await eng.probe();
    const tries = log.filter((x) => x.base === 'http://127.0.0.1:8080');
    assert.deepEqual(tries.map((x) => x.init.mode || 'cors'), ['cors', 'no-cors']);
  });

  test('a working server beats a blocked one; loading beats CORS in the report', async () => {
    let p = await local({ 'http://127.0.0.1:8080': () => 'cors', 'http://127.0.0.1:11434': ollama() }).eng.probe();
    assert.equal(p.ok, true);
    assert.equal(p.server, 'ollama');
    p = await local({ 'http://127.0.0.1:8080': llama({ healthStatus: 503 }), 'http://127.0.0.1:11434': () => 'cors' }).eng.probe();
    assert.equal(p.code, 'loading');
  });

  test('Chrome local-network-access permission denied: no requests, clear steps', async () => {
    const { eng, log } = local({ 'http://127.0.0.1:8080': llama() }, { permissions: perms({ 'loopback-network': 'denied' }) });
    const p = await eng.probe();
    assert.equal(p.ok, false);
    assert.equal(p.code, 'lna-denied');
    assert.match(p.detail, /Apps on device/);
    assert.match(p.detail, /Allow/);
    assert.equal(log.length, 0);
  });

  test('older Chrome name "local-network-access" is understood too', async () => {
    const p = await local({}, { permissions: perms({ 'local-network-access': 'denied' }) }).eng.probe();
    assert.equal(p.code, 'lna-denied');
  });

  test('permission granted, or a browser without the permission: probe as usual', async () => {
    for (const permissions of [perms({ 'loopback-network': 'granted' }), perms({}), { query: async () => { throw new Error('boom'); } }, {}]) {
      const p = await local({ 'http://127.0.0.1:8080': llama() }, { permissions }).eng.probe();
      assert.equal(p.ok, true);
    }
  });

  test('while Chrome shows its prompt the probe waits longer for the answer', async () => {
    // the server answers after 150 ms: too slow for the 50 ms probe, fine for the 400 ms prompt wait
    const slow = (h) => async (req) => { await tick(150); return h(req); };
    const timeouts = { probe: 50, permission: 400, candidate: 2000 };
    let p = await local({ 'http://127.0.0.1:8080': slow(llama()) }, { timeouts, permissions: perms({ 'loopback-network': 'prompt' }) }).eng.probe();
    assert.equal(p.ok, true);
    p = await local({ 'http://127.0.0.1:8080': slow(llama()) }, { timeouts }).eng.probe();
    assert.equal(p.ok, false);
    assert.equal(p.code, 'not-running');
  });

  test('a prompt left unanswered: tell the user to choose Allow', async () => {
    const timeouts = { probe: 50, permission: 80, candidate: 2000 };
    const { eng } = local({ 'http://127.0.0.1:8080': ({ init }) => hang(init) }, { timeouts, permissions: perms({ 'loopback-network': 'prompt' }) });
    const p = await eng.probe();
    assert.equal(p.code, 'lna-prompt');
    assert.match(p.detail, /Choose Allow/);
  });

  test('the user blocks the prompt while the probe waits', async () => {
    let state = 'prompt';
    const { eng } = local({ 'http://127.0.0.1:8080': () => { state = 'denied'; return 'refused'; } }, { permissions: perms({ 'loopback-network': () => state }) });
    const p = await eng.probe();
    assert.equal(p.code, 'lna-denied');
  });

  test('a page served from localhost does not ask about the permission', async () => {
    let asked = 0;
    const permissions = { query: async () => { asked++; return { state: 'denied' }; } };
    const p = await local({ 'http://127.0.0.1:8080': llama() }, { permissions, origin: 'http://localhost:5173' }).eng.probe();
    assert.equal(p.ok, true);
    assert.equal(asked, 0);
  });

  test('probe never throws for odd servers', async () => {
    const odd = {
      'http://127.0.0.1:8080': () => new Response('<html>dev server</html>', { status: 200 }),
      'http://127.0.0.1:1234': () => json({ data: 'not a list' }),
      'http://127.0.0.1:11434': () => { throw new Error('socket hang up'); },
    };
    const p = await local(odd).eng.probe();
    assert.equal(p.ok, false);
    assert.equal(p.code, 'not-running');
  });
});

// ======================================================================================
describe('local engine: generate with the Humanizer model', () => {
  test('POSTs the exact humanizer prompt to /completion with the model card sampling', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama() });
    const out = await eng.generate([H(SENT, { n: 3 })]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], ['Version 0 of the sentence.', 'Version 1 of the sentence.', 'Version 2 of the sentence.']);
    const calls = posts();
    assert.equal(calls.length, 3, 'one request per version');
    for (const c of calls) {
      assert.equal(c.url, 'http://127.0.0.1:8080/completion');
      assert.equal(c.body.prompt, humanizerPrompt(SENT));
      assert.equal(c.body.temperature, 1);
      assert.equal(c.body.top_p, 0.95);
      assert.equal(c.body.top_k, 0);
      assert.equal(c.body.min_p, 0);
      assert.equal(c.body.repeat_penalty, 1);
      assert.equal(c.body.n_predict, humanizerTokens(SENT, 220));
      assert.ok(!('stop' in c.body), 'the model card: stop on EOS only');
      assert.ok(!('messages' in c.body));
      assert.equal(c.init.headers['Content-Type'], 'application/json');
      assert.equal(c.init.targetAddressSpace, 'loopback');
    }
  });

  test('the humanizer rewrites req.text, never the chat prompt', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama() });
    await eng.generate([{ system: 'SYSTEM RULES', user: 'USER PROMPT ⟦x⟧', text: SENT, n: 1 }]);
    const p = posts()[0].body.prompt;
    assert.ok(p.includes(SENT));
    assert.ok(!p.includes('SYSTEM RULES') && !p.includes('USER PROMPT'));
  });

  test('a Chinese reply to an English draft is sampled again (up to 3 tries)', async () => {
    const replies = ['我们的不良贷款率降至1.5%。', 'Our GNPA came down to 1.5% in FY24.'];
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ completion: (_, i) => json({ content: replies[i] }) }) });
    assert.deepEqual(await eng.generate([H()]), [['Our GNPA came down to 1.5% in FY24.']]);
    assert.equal(posts().length, 2);
  });

  test('three wrong-language replies: the version is skipped, not thrown', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ completion: () => json({ content: '我们的不良贷款率降至1.5%。' }) }) });
    assert.deepEqual(await eng.generate([H()]), [[]]);
    assert.equal(posts().length, 3);
  });

  test('echoed prompts and empty replies are skipped', async () => {
    const replies = ['Rewrite the text below so it reads like…', '   ', '### Rewritten:\n\nx', 'Fine version.'];
    const { eng } = local({ 'http://127.0.0.1:8080': llama({ completion: (_, i) => json({ content: replies[i] }) }) });
    assert.deepEqual(await eng.generate([H(SENT, { n: 4 })]), [['Fine version.']]);
  });

  test('a request without text cannot go to the humanizer (Interview mode needs a chat model)', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama() });
    await assert.rejects(eng.generate([{ system: 's', user: 'Rewrite this paragraph with my answers.', n: 3, maxTokens: 600 }]),
      (e) => e.code === 'needs-chat-model' && /chat model/.test(e.message));
    assert.equal(posts().length, 0);
  });

  test('Ollama: raw /api/generate with the same sampling', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:11434': ollama() });
    assert.deepEqual(await eng.generate([H()]), [['Ollama version.']]);
    const b = posts()[0];
    assert.equal(b.path, '/api/generate');
    assert.equal(b.body.model, 'humanizer:latest');
    assert.equal(b.body.raw, true);
    assert.equal(b.body.stream, false);
    assert.equal(b.body.prompt, humanizerPrompt(SENT));
    assert.deepEqual(b.body.options, { temperature: 1, top_p: 0.95, top_k: 0, min_p: 0, repeat_penalty: 1, num_predict: humanizerTokens(SENT, 220) });
  });

  test('LM Studio: /v1/completions with the full prompt', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:1234': lmstudio() });
    assert.deepEqual(await eng.generate([H()]), [['LM Studio version.']]);
    const b = posts()[0];
    assert.equal(b.path, '/v1/completions');
    assert.equal(b.body.model, 'humanizer-12b');
    assert.equal(b.body.prompt, humanizerPrompt(SENT));
    assert.equal(b.body.max_tokens, humanizerTokens(SENT, 220));
    assert.equal(b.body.temperature, 1);
  });
});

// ======================================================================================
describe('local engine: generate with a chat model', () => {
  test('POSTs system and user messages to /v1/chat/completions', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ model: 'gemma-3-12b-it.gguf' }) });
    const out = await eng.generate([{ system: 'SYS', user: 'USER', n: 2, maxTokens: 220 }, { system: '', user: 'ONLY USER', n: 1 }]);
    assert.deepEqual(out, [['Chat version 0.', 'Chat version 1.'], ['Chat version 2.']]);
    const [a, , c] = posts();
    assert.equal(a.path, '/v1/chat/completions');
    assert.deepEqual(a.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]);
    assert.equal(a.body.model, 'gemma-3-12b-it.gguf');
    assert.equal(a.body.max_tokens, 220);
    assert.equal(a.body.temperature, 0.8);
    assert.equal(a.body.stream, false);
    assert.ok(!('chat_template_kwargs' in a.body));
    assert.deepEqual(c.body.messages, [{ role: 'user', content: 'ONLY USER' }], 'an empty system prompt is left out');
    assert.equal(c.body.max_tokens, 400, 'default length');
  });

  test('Qwen3 on llama-server: thinking off both ways', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ model: 'Qwen3-8B-Q4_K_M.gguf' }) });
    await eng.generate([{ system: 'SYS', user: 'Rewrite it.', n: 1 }]);
    const b = posts()[0].body;
    assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
    assert.match(b.messages[1].content, /\/no_think$/);
  });

  test('Qwen3 on Ollama gets the /no_think switch only', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:11434': ollama({ models: [{ id: 'qwen3:8b' }] }) });
    await eng.generate([{ user: 'Rewrite it.', n: 1 }]);
    const b = posts()[0].body;
    assert.ok(!('chat_template_kwargs' in b));
    assert.match(b.messages[0].content, /\/no_think$/);
  });

  test('a reply without content (all thinking) is skipped', async () => {
    const chat = (_, i) => json({ choices: [{ message: i === 0 ? { content: '', reasoning_content: 'hmm' } : { content: 'Good.' } }] });
    const { eng } = local({ 'http://127.0.0.1:8080': llama({ model: 'gemma', chat }) });
    assert.deepEqual(await eng.generate([{ user: 'u', n: 2 }]), [['Good.']]);
  });
});

// ======================================================================================
describe('local engine: failures and abort', () => {
  test('one failed version is skipped; the rest come back', async () => {
    const completion = (_, i) => (i === 1 ? json({ error: { code: 500, message: 'slot unavailable' } }, 500) : json({ content: `ok ${i}` }));
    const { eng } = local({ 'http://127.0.0.1:8080': llama({ completion }) });
    const msgs = [];
    const out = await eng.generate([H(SENT, { n: 3 })], { onProgress: (p) => { if (p.message) msgs.push(p.message); } });
    assert.deepEqual(out, [['ok 0', 'ok 2']]);
    assert.match(msgs[0], /Writing 3 versions with Humanizer 12B on llama-server/);
    assert.match(msgs.at(-1), /1 of 3 versions could not be written and was skipped/);
  });

  test('every version failing with a server error throws that error', async () => {
    const completion = () => json({ error: { code: 500, message: 'model crashed' } }, 500);
    const { eng } = local({ 'http://127.0.0.1:8080': llama({ completion }) });
    await assert.rejects(eng.generate([H(SENT, { n: 2 })]), (e) => e.code === 'http' && /HTTP 500: model crashed/.test(e.message));
  });

  test('malformed JSON is a skipped version', async () => {
    const completion = (_, i) => (i === 0 ? new Response('<html>oops</html>', { status: 200 }) : json({ content: 'fine' }));
    const { eng } = local({ 'http://127.0.0.1:8080': llama({ completion }) });
    assert.deepEqual(await eng.generate([H(SENT, { n: 2 })]), [['fine']]);
  });

  test('the server going away mid-run: stop after two failures, keep what came back', async () => {
    let up = true;
    const completion = () => { if (!up) return 'refused'; up = false; return json({ content: 'first' }); };
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ completion }) });
    const out = await eng.generate([H(SENT, { n: 2 }), H(SENT, { n: 2 }), H(SENT, { n: 2 })]);
    assert.deepEqual(out, [['first'], [], []]);
    assert.equal(posts().length, 3, 'one success, then two refused connections');
    assert.equal(eng.server, null, 'the next run probes again');
  });

  test('server down from the start: a clear error, not empty lists', async () => {
    const { eng } = local({ 'http://127.0.0.1:8080': llama({ completion: () => 'refused' }) });
    await eng.probe();
    await assert.rejects(eng.generate([H(SENT, { n: 3 })]), (e) => e.code === 'not-running' && /stopped answering/.test(e.message));
  });

  test('model still loading during generation: stops early with that message', async () => {
    const completion = () => json({ error: { code: 503, message: 'Loading model' } }, 503);
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ completion }) });
    await assert.rejects(eng.generate([H(SENT, { n: 5 })]), (e) => e.code === 'loading');
    assert.equal(posts().length, 2);
  });

  test('a version that takes too long times out with advice', async () => {
    // the server never answers, so only our timeout ends the request
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ completion: (b, i, init) => hang(init) }) }, { timeouts: { probe: 300, permission: 600, candidate: 60 } });
    await assert.rejects(eng.generate([H(SENT, { n: 1 })]), (e) => e.code === 'timeout' && /-ngl 99/.test(e.message));
    await assert.rejects(eng.generate([H(SENT, { n: 4 })]), (e) => e.code === 'timeout');
    assert.equal(posts().length, 3, 'two timeouts in a row end the run');
  });

  test('generate probes first when needed, and throws the probe reason', async () => {
    const ok = local({ 'http://127.0.0.1:8080': llama() });
    assert.deepEqual(await ok.eng.generate([H()]), [['Version 0 of the sentence.']]);
    const down = local({});
    await assert.rejects(down.eng.generate([H()]), (e) => e.code === 'not-running');
    const cors = local({ 'http://127.0.0.1:8080': () => 'cors' });
    await assert.rejects(cors.eng.generate([H()]), (e) => e.code === 'cors' && /--cors-origins/.test(e.message));
  });

  test('empty input, odd requests and n limits', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ model: 'chat-model' }) });
    assert.deepEqual(await eng.generate([]), []);
    assert.deepEqual(await eng.generate(null), []);
    assert.equal(posts().length, 0, 'nothing to do, no requests');
    const out = await eng.generate([null, { user: '' }, { user: 'u', n: 0 }, { user: 'u', n: -3 }, { user: 'u', n: 'x' }]);
    assert.deepEqual(out.map((l) => l.length), [0, 0, 1, 1, 1]);
    const big = await eng.generate([{ user: 'u', n: 100 }]);
    assert.equal(big[0].length, 16, 'n is capped');
  });

  test('a throwing progress callback does not stop the run', async () => {
    const { eng } = local({ 'http://127.0.0.1:8080': llama() });
    const out = await eng.generate([H(SENT, { n: 2 })], { onProgress: () => { throw new Error('UI gone'); } });
    assert.equal(out[0].length, 2);
  });

  test('progress counts every version', async () => {
    const { eng } = local({ 'http://127.0.0.1:8080': llama() });
    const seen = [];
    await eng.generate([H(SENT, { n: 2 }), H(SENT, { n: 1 })], { onProgress: (p) => seen.push([p.done, p.total]) });
    assert.deepEqual(seen, [[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  test('an aborted signal stops before any request', async () => {
    const { eng, log } = local({ 'http://127.0.0.1:8080': llama() });
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(eng.generate([H()], { signal: ctl.signal }), { name: 'AbortError' });
    assert.equal(log.length, 0);
  });

  test('abort during a request rejects at once and sends nothing more', async () => {
    // the first version comes back, the second hangs until the user presses Stop
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ completion: (b, i, init) => (i === 0 ? json({ content: 'one' }) : hang(init)) }) });
    await eng.probe();
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = eng.generate([H(SENT, { n: 3 })], { signal: ctl.signal });
    await tick(30);
    ctl.abort(new Error('user pressed Stop'));
    await assert.rejects(p, (e) => e.name === 'AbortError');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(posts().length, 2);
    assert.ok(posts()[1].init.signal.aborted, 'the hanging request itself was cancelled');
  });

  test('abort during the probe inside generate', async () => {
    const ctl = new AbortController();
    const { eng } = local({ 'http://127.0.0.1:8080': ({ init }) => hang(init) }, { timeouts: { probe: 5000, permission: 5000, candidate: 5000 } });
    const p = eng.generate([H()], { signal: ctl.signal });
    await tick(20);
    ctl.abort();
    await assert.rejects(p, { name: 'AbortError' });
  });
});

// ======================================================================================
// Bugs found in review: each test failed (or crashed) before the fix.
describe('local engine: review fixes', () => {
  test('probe never throws when no usable port is configured; it falls back to the defaults', async () => {
    for (const make of [
      () => local({}, { ports: [] }).eng,
      () => { const e = local({}).eng; e.configure({ ports: ['abc', 0, 70000, 8080.5, -1] }); return e; },
    ]) {
      const p = await make().probe();
      assert.equal(p.ok, false);
      assert.equal(p.code, 'not-running');
      assert.match(p.detail, /127\.0\.0\.1:8080, 127\.0\.0\.1:1234, 127\.0\.0\.1:11434/);
    }
    const { eng, log } = local({ 'http://127.0.0.1:9000': llama() }, { ports: ['9000', 9000, '9000.5'] });
    assert.equal((await eng.probe()).url, 'http://127.0.0.1:9000');
    assert.deepEqual([...new Set(log.map((x) => x.base))], ['http://127.0.0.1:9000'], 'deduplicated, fractional port dropped');
  });

  test('llama-server router mode: /completion names the model so the router can route it', async () => {
    const models = [
      { id: 'ggml-org/gemma-3-4b-it-GGUF:Q4_K_M', status: { value: 'loaded' } },
      { id: 'jialinyyzz/humanizer:Q8_0', status: { value: 'unloaded' } },
    ];
    // the router refuses a POST without "model"
    const completion = (body) => (body.model ? json({ content: `Routed to ${body.model}.` }) : json({ error: { code: 400, message: 'model name is missing from the request' } }, 400));
    const { eng, posts } = local({ 'http://127.0.0.1:8080': llama({ models, completion }) });
    assert.deepEqual(await eng.generate([H()]), [['Routed to jialinyyzz/humanizer:Q8_0.']]);
    assert.equal(posts()[0].body.model, 'jialinyyzz/humanizer:Q8_0');
    assert.equal(posts()[0].body.prompt, humanizerPrompt(SENT));
  });

  test('router models that failed to load or are still downloading are not picked', async () => {
    const models = [
      { id: 'humanizer-12b-Q8_0', status: { value: 'unloaded', failed: true, exit_code: 1 } },
      { id: 'humanizer-12b-Q6_K', status: { value: 'incomplete', args: [] } },
      { id: 'humanizer-12b-Q4_K_M', status: { value: 'downloading', progress: {} } },
      { id: 'gemma-3-12b-it', status: { value: 'loaded' } },
    ];
    const p = await local({ 'http://127.0.0.1:8080': llama({ models }) }).eng.probe();
    assert.equal(p.model, 'gemma-3-12b-it');
    assert.equal(p.humanizer, false);
    const p2 = await local({ 'http://127.0.0.1:8080': llama({ models: [...models.slice(0, 3), { id: 'humanizer-12b-bf16', status: { value: 'unloaded' } }] }) }).eng.probe();
    assert.equal(p2.model, 'humanizer-12b-bf16', 'an unloaded humanizer is fine: the router loads it on demand');
  });

  test('embedding models listed by Ollama or LM Studio are never used to rewrite', async () => {
    let p = await local({ 'http://127.0.0.1:11434': ollama({ models: [{ id: 'nomic-embed-text:latest' }, { id: 'bge-m3:latest' }, { id: 'all-minilm:l6-v2' }, { id: 'qwen3:8b' }] }) }).eng.probe();
    assert.equal(p.model, 'qwen3:8b');
    p = await local({ 'http://127.0.0.1:1234': lmstudio({ models: [{ id: 'text-embedding-nomic-embed-text-v1.5', owned_by: 'organization_owner' }, { id: 'google/gemma-3-12b', owned_by: 'organization_owner' }] }) }).eng.probe();
    assert.equal(p.model, 'google/gemma-3-12b');
    p = await local({ 'http://127.0.0.1:11434': ollama({ models: [{ id: 'nomic-embed-text:latest' }] }) }).eng.probe();
    assert.equal(p.ok, false);
    assert.equal(p.code, 'no-model');
    // llama-server ids are file paths: a folder name is not the model
    p = await local({ 'http://127.0.0.1:8080': llama({ model: '/Users/embedded-team/models/humanizer-12b-Q6_K.gguf' }) }).eng.probe();
    assert.equal(p.ok, true);
    assert.equal(p.humanizer, true);
  });

  test('Interview mode with the humanizer: a chat model on the same server takes the request', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:11434': ollama() });  // humanizer:latest and qwen3:8b
    const p = await eng.probe();
    assert.equal(p.model, 'humanizer:latest');
    assert.equal(p.chatModel, 'qwen3:8b');
    const msgs = [];
    const out = await eng.generate([{ system: 'Only use my answers.', user: 'Rewrite the paragraph with: 1,200 DSAs.', n: 2, maxTokens: 600 }], { onProgress: (x) => x.message && msgs.push(x.message) });
    assert.deepEqual(out, [['Ollama chat version.', 'Ollama chat version.']]);
    for (const c of posts()) {
      assert.equal(c.path, '/v1/chat/completions');
      assert.equal(c.body.model, 'qwen3:8b');
      assert.match(c.body.messages.at(-1).content, /\/no_think$/, 'Qwen3 thinking off');
    }
    assert.match(msgs[0], /with qwen3:8b on Ollama/);
  });

  test('a mixed batch: drafts go to the humanizer, prompt-only requests to the chat model', async () => {
    const { eng, posts } = local({ 'http://127.0.0.1:11434': ollama() });
    const out = await eng.generate([H(), { user: 'Interview prompt', n: 1 }]);
    assert.deepEqual(out, [['Ollama version.'], ['Ollama chat version.']]);
    assert.deepEqual(posts().map((c) => [c.path, c.body.model]), [['/api/generate', 'humanizer:latest'], ['/v1/chat/completions', 'qwen3:8b']]);
  });

  test('plain-http LAN names are tagged "local" (mixed content); public names are not tagged', async () => {
    const cases = [
      ['gpu-box:8080', 'local'], ['http://gpu-box.lan:8080', 'local'], ['http://studio.home.arpa:8080', 'local'],
      ['http://ai.example.com:8080', undefined], ['https://llm.example.in', undefined], ['8.8.8.8:8080', undefined],
      ['10.0.0.5:8080', 'local'], ['http://mac-mini.local:8080', 'local'], ['localhost:8080', 'loopback'], ['[::1]:8080', 'loopback'],
    ];
    for (const [addr, want] of cases) {
      const base = normalizeBaseUrl(addr);
      const { eng, log } = local({ [base]: llama() });
      eng.configure({ baseUrl: addr });
      await eng.probe();
      assert.equal(log.find((x) => x.base === base).init.targetAddressSpace, want, addr);
    }
  });

  test('a browser that rejects the address-space value still reaches the server', async () => {
    const m = mockFetch({ 'http://127.0.0.1:8080': llama() });
    let refused = 0;
    const fetch = async (url, init) => {
      if ('targetAddressSpace' in init) {
        refused++;
        throw new TypeError("Failed to execute 'fetch' on 'Window': Failed to read the 'targetAddressSpace' property from 'RequestInit': The provided value 'loopback' is not a valid enum value of type IPAddressSpace.");
      }
      return m.fetch(url, init);
    };
    const eng = createLocalEngine({ fetch, permissions: null, origin: ORIGIN, timeouts: { probe: 300, permission: 600, candidate: 2000 } });
    const p = await eng.probe();
    assert.equal(p.ok, true);
    assert.equal(p.humanizer, true);
    const before = refused;
    assert.deepEqual(await eng.generate([H()]), [['Version 0 of the sentence.']]);
    assert.equal(refused, before, 'the option is not sent again');
    assert.ok(refused >= 1 && refused <= DEFAULT_PORTS.length);
  });

  test('Ollama CORS advice uses PowerShell syntax on Windows', async () => {
    let p = await local({ 'http://127.0.0.1:11434': () => 'cors' }, { platform: 'Win32' }).eng.probe();
    assert.match(p.detail, /PowerShell with: \$env:OLLAMA_ORIGINS="https:\/\/desk\.example\.github\.io"; ollama serve/);
    assert.doesNotMatch(p.detail, /OLLAMA_ORIGINS="[^"]*" ollama serve/);
    p = await local({ 'http://127.0.0.1:11434': () => 'cors' }, { platform: 'MacIntel' }).eng.probe();
    assert.match(p.detail, /Terminal with: OLLAMA_ORIGINS="https:\/\/desk\.example\.github\.io" ollama serve/);
  });
});

// ======================================================================================
describe('manual engine', () => {
  const items = [
    { index: 3, before: 'We lend to salaried buyers.', sentence: 'In FY24 we disbursed ₹1,00,000 crore at an LTV below 70%.', after: 'Collections stayed strong.' },
    { index: 7, before: '', sentence: 'Our GNPA must stay below 1.5% as RBI tightens norms.', after: '' },
  ];

  test('buildRequest is the batch prompt for the given items', () => {
    const eng = createManualEngine();
    const text = eng.buildRequest(items, { voice: 'Plain, direct.', samples: ['My sample.'], n: 3 });
    assert.equal(text, batchVariantsPrompt({ items, voice: 'Plain, direct.', samples: ['My sample.'], n: 3 }));
    assert.match(text, /\[id "3"\]/);
    assert.match(text, /\[id "7"\]/);
    assert.ok(text.includes('₹1,00,000 crore'));
    assert.match(text, /write 3 different versions/);
  });

  test('buildRequest drops items with no sentence or id', () => {
    const eng = createManualEngine();
    const text = eng.buildRequest([...items, { index: 9, sentence: '   ' }, { sentence: 'No id here.' }, null]);
    assert.doesNotMatch(text, /\[id "9"\]/);
    assert.doesNotMatch(text, /No id here/);
  });

  test('parseReply round trip keeps number ids as numbers', () => {
    const eng = createManualEngine();
    eng.buildRequest(items, { n: 2 });
    const reply = 'Sure, here they are:\n```json\n{"3": ["In FY24 we lent ₹1,00,000 crore, keeping LTV under 70%.", "We disbursed ₹1,00,000 crore in FY24, all below 70% LTV."], "7": ["RBI is tightening, so our GNPA must stay below 1.5%."]}\n```\nHope this helps!';
    const m = eng.parseReply(reply, [3, 7]);
    assert.ok(m instanceof Map);
    assert.deepEqual([...m.keys()], [3, 7]);
    assert.equal(m.get(3).length, 2);
    assert.equal(m.get(7)[0], 'RBI is tightening, so our GNPA must stay below 1.5%.');
    // ids default to the last request's
    assert.deepEqual(eng.parseReply(reply), m);
    assert.deepEqual(eng.parseReply(reply, null), m);
  });

  test('parseReply on junk gives empty lists for every id, never throws', () => {
    const eng = createManualEngine();
    for (const junk of ['', 'I cannot help with that.', '{"3": ', null, undefined]) {
      const m = eng.parseReply(junk, [3, 7]);
      assert.deepEqual([...m.entries()], [[3, []], [7, []]]);
    }
  });

  test('generate refuses with code "manual" and explains copy/paste', async () => {
    const eng = createManualEngine();
    await assert.rejects(eng.generate([{ user: 'u', n: 2 }]), (e) => e.code === 'manual' && /copy/.test(e.message) && /paste/.test(e.message));
  });

  test('probe is always ok, and the module exports the engine', async () => {
    assert.equal((await manualMod.engine.probe()).ok, true);
    assert.equal(manualMod.engine.id, 'manual');
    assert.equal(manualMod.default, manualMod.engine);
    assert.equal(typeof manualMod.engine.buildRequest, 'function');
    assert.equal(typeof manualMod.engine.parseReply, 'function');
  });
});

// ======================================================================================
describe('webllm: chooseModel', () => {
  const lim = (bufGiB, mem, f16 = true, extra = {}) => ({ maxBufferSize: bufGiB * GiB, maxStorageBufferBindingSize: Math.min(bufGiB, 2) * GiB, shaderF16: f16, deviceMemory: mem, ...extra });

  test('8B only with clear room: big buffers and 16 GB reported', () => {
    const c = chooseModel(lim(4, 16));
    assert.equal(c.model, 'Qwen3-8B-q4f16_1-MLC');
    assert.equal(c.fits, true);
    assert.equal(c.vramMB, 5695.78);
    assert.match(c.reason, /Qwen3 8B fits/);
  });

  test('Chrome caps deviceMemory at 8 GB, so 8 GB means 4B (conservative)', () => {
    assert.equal(chooseModel(lim(4, 8)).model, 'Qwen3-4B-q4f16_1-MLC');
    assert.equal(chooseModel(lim(2, 8)).model, 'Qwen3-4B-q4f16_1-MLC');
  });

  test('smaller limits step down to 1.7B, then to nothing', () => {
    assert.equal(chooseModel(lim(1, 8)).model, 'Qwen3-1.7B-q4f16_1-MLC');
    assert.equal(chooseModel(lim(4, 4)).model, 'Qwen3-1.7B-q4f16_1-MLC');
    const none = chooseModel(lim(4, 2));
    assert.equal(none.model, null);
    assert.equal(none.fits, false);
    assert.match(none.reason, /not have enough graphics memory/);
    assert.match(none.reason, /Qwen3 1\.7B needs about 2\.0 GB/);
    assert.equal(chooseModel(lim(0.5, 8)).model, null);
  });

  test('no shader-f16: the q4f32_1 builds, which need more memory', () => {
    assert.equal(chooseModel(lim(4, 16, false)).model, 'Qwen3-8B-q4f32_1-MLC');
    assert.equal(chooseModel(lim(2, 8, false)).model, 'Qwen3-1.7B-q4f32_1-MLC', '4B f32 needs 4.3 GB');
    assert.equal(chooseModel({ ...lim(4, 16), shaderF16: undefined }).model, 'Qwen3-8B-q4f32_1-MLC', 'unknown f16 counts as missing');
  });

  test('unknown memory counts as 8 GB; nothing known still gives a safe choice', () => {
    assert.equal(chooseModel(lim(4, undefined)).model, 'Qwen3-4B-q4f16_1-MLC');
    assert.equal(chooseModel({ shaderF16: true }).model, 'Qwen3-4B-q4f16_1-MLC');
    assert.equal(chooseModel({}).model, 'Qwen3-1.7B-q4f32_1-MLC');
    assert.equal(chooseModel(null).model, 'Qwen3-1.7B-q4f32_1-MLC');
    assert.equal(chooseModel({}).budgetMB, FIT.unknownMemoryGB * 1024 * FIT.memoryShare);
  });

  test('an explicit vramMB replaces the estimate', () => {
    assert.equal(chooseModel(lim(1, 2, true, { vramMB: 12000 })).model, 'Qwen3-8B-q4f16_1-MLC');
    assert.equal(chooseModel(lim(4, 16, true, { vramMB: 3000 })).model, 'Qwen3-1.7B-q4f16_1-MLC');
  });

  test('software adapters and tiny limits are refused', () => {
    assert.equal(chooseModel(lim(4, 16, true, { isFallbackAdapter: true })).model, null);
    assert.match(chooseModel(lim(4, 16, true, { isFallbackAdapter: true })).reason, /processor/);
    assert.equal(chooseModel({ ...lim(4, 16), maxBufferSize: 128 * MiB }).model, null);
    assert.equal(chooseModel({ ...lim(4, 16), maxStorageBufferBindingSize: 64 * MiB }).model, null);
  });

  test('override by size or id wins, and says whether it fits', () => {
    let c = chooseModel(lim(1, 4), QWEN3_MODELS, { override: '8B' });
    assert.equal(c.model, 'Qwen3-8B-q4f16_1-MLC');
    assert.equal(c.override, true);
    assert.equal(c.fits, false);
    c = chooseModel(lim(4, 16), QWEN3_MODELS, { override: '1.7b' });
    assert.equal(c.model, 'Qwen3-1.7B-q4f16_1-MLC');
    assert.equal(c.fits, true);
    c = chooseModel(lim(4, 16, false), QWEN3_MODELS, { override: '4' });
    assert.equal(c.model, 'Qwen3-4B-q4f32_1-MLC', 'a size follows the GPU’s quantisation');
    c = chooseModel(lim(4, 16, false), QWEN3_MODELS, { override: 'qwen3-4b-q4f16_1-mlc' });
    assert.equal(c.model, 'Qwen3-4B-q4f16_1-MLC', 'an exact id is taken as given');
    c = chooseModel(lim(4, 16, true, { isFallbackAdapter: true }), QWEN3_MODELS, { override: '1.7B' });
    assert.equal(c.model, 'Qwen3-1.7B-q4f16_1-MLC');
  });

  test('an unknown override is ignored', () => {
    assert.equal(chooseModel(lim(4, 16), QWEN3_MODELS, { override: 'Llama-99B' }).model, 'Qwen3-8B-q4f16_1-MLC');
    assert.equal(chooseModel(lim(4, 16), QWEN3_MODELS, { override: '  ' }).model, 'Qwen3-8B-q4f16_1-MLC');
  });

  test('only Qwen3 8B/4B/1.7B q4 builds are candidates (not Qwen3.5, 0.6B or q0)', () => {
    const list = [
      { model_id: 'Qwen3.5-9B-q4f16_1-MLC', vram_required_MB: 100 },
      { model_id: 'Qwen3-0.6B-q4f16_1-MLC', vram_required_MB: 100 },
      { model_id: 'Qwen3-0.6B-q0f16-MLC', vram_required_MB: 100 },
      { model_id: 'Qwen3-14B-q4f16_1-MLC', vram_required_MB: 100 },
      { model_id: 'Qwen3-1.7B-q4f16_1-MLC', vram_required_MB: 2036.66 },
      { model_id: 'Qwen3-4B-q4f16_1-MLC' },
      null, 'junk',
    ];
    assert.equal(chooseModel(lim(4, 16), list).model, 'Qwen3-1.7B-q4f16_1-MLC');
    assert.equal(chooseModel(lim(4, 16), []).model, null);
    assert.match(chooseModel(lim(4, 16), []).reason, /no Qwen3 model/);
    assert.equal(chooseModel(lim(4, 16), undefined).model, 'Qwen3-8B-q4f16_1-MLC', 'defaults to the built-in table');
  });

  test('smallerModels lists the fallbacks in order, same quantisation', () => {
    assert.deepEqual(smallerModels('Qwen3-8B-q4f16_1-MLC'), ['Qwen3-4B-q4f16_1-MLC', 'Qwen3-1.7B-q4f16_1-MLC']);
    assert.deepEqual(smallerModels('Qwen3-4B-q4f32_1-MLC'), ['Qwen3-1.7B-q4f32_1-MLC']);
    assert.deepEqual(smallerModels('Qwen3-1.7B-q4f16_1-MLC'), []);
    assert.deepEqual(smallerModels('Llama-3.2-3B-Instruct-q4f16_1-MLC'), []);
  });

  test('readLimits reads a GPUAdapter', () => {
    const adapter = { limits: { maxBufferSize: 4 * GiB, maxStorageBufferBindingSize: 2 * GiB }, features: new Set(['shader-f16']), info: { vendor: 'apple', isFallbackAdapter: false } };
    assert.deepEqual(readLimits(adapter, { deviceMemory: 8 }), { maxBufferSize: 4 * GiB, maxStorageBufferBindingSize: 2 * GiB, shaderF16: true, isFallbackAdapter: false, deviceMemory: 8, vendor: 'apple' });
    const bare = readLimits({ limits: {}, features: new Set() }, {});
    assert.equal(bare.shaderF16, false);
    assert.equal(bare.deviceMemory, undefined);
    assert.equal(readLimits({ isFallbackAdapter: true }, undefined).isFallbackAdapter, true, 'older adapters carry the flag themselves');
    assert.doesNotThrow(() => readLimits(null, null));
  });

  test('modelLabel', () => {
    assert.equal(modelLabel('Qwen3-8B-q4f16_1-MLC'), 'Qwen3 8B');
    assert.equal(modelLabel('Qwen3-1.7B-q4f32_1-MLC'), 'Qwen3 1.7B');
    assert.equal(modelLabel(null), '');
  });
});

// ======================================================================================
// The site build copies node_modules/@mlc-ai/web-llm/lib/index.js to vendor/web-llm/index.js unchanged.
describe('webllm: the library the build ships', () => {
  const PKG = fileURLToPath(new URL('../../node_modules/@mlc-ai/web-llm/', import.meta.url));

  test('the pinned browser ESM build and its licence are installed, unchanged', () => {
    assert.ok(existsSync(`${PKG}lib/index.js`), 'run npm ci');
    assert.match(readFileSync(`${PKG}LICENSE`, 'utf8'), /Apache License/);
    const sha = createHash('sha256').update(readFileSync(`${PKG}lib/index.js`)).digest('hex');
    assert.equal(sha, 'ae2642e73a4a9896c21efb3a067c4666446f8b49cbe2012f4b576f5d83d5f206', 'web-llm 0.2.86 lib/index.js from npm');
    const src = readFileSync(`${PKG}lib/index.js`, 'utf8');
    assert.doesNotMatch(src, /^\s*import\s[^;]*from\s*['"]/m, 'no bare imports: it must load from the same origin as is');
  });

  test('its prebuiltAppConfig matches the built-in Qwen3 table, and chooseModel agrees', async () => {
    const lib = await import('../../node_modules/@mlc-ai/web-llm/lib/index.js');
    assert.equal(lib.modelVersion, `v${WEBLLM_VERSION.replace(/\./g, '_')}/base`);
    assert.equal(typeof lib.CreateWebWorkerMLCEngine, 'function');
    assert.equal(typeof lib.WebWorkerMLCEngineHandler, 'function');
    const list = lib.prebuiltAppConfig.model_list;
    for (const m of QWEN3_MODELS) {
      const r = list.find((x) => x.model_id === m.model_id);
      assert.ok(r, m.model_id);
      assert.equal(r.vram_required_MB, m.vram_required_MB, m.model_id);
    }
    const limits = { maxBufferSize: 4 * GiB, maxStorageBufferBindingSize: 2 * GiB, shaderF16: true, deviceMemory: 16 };
    assert.deepEqual(chooseModel(limits, list), chooseModel(limits, QWEN3_MODELS));
    assert.deepEqual(chooseModel({ ...limits, deviceMemory: 8 }, list), chooseModel({ ...limits, deviceMemory: 8 }, QWEN3_MODELS));
  });

  test('the worker and the engine point at the files the build ships', () => {
    const worker = readFileSync(fileURLToPath(new URL('../../ai-checker/workers/llm.mjs', import.meta.url)), 'utf8');
    assert.match(worker, /import \{ WebWorkerMLCEngineHandler \} from '\.\.\/vendor\/web-llm\/index\.js'/);
    assert.match(worker, /handler\.onmessage\(msg\)/);
    const eng = readFileSync(fileURLToPath(new URL('../../ai-checker/src/rewrite/engines/webllm.mjs', import.meta.url)), 'utf8');
    const build = readFileSync(fileURLToPath(new URL('../../tools/build_artifact.py', import.meta.url)), 'utf8');
    for (const rel of eng.match(/'\.\.\/\.\.\/\.\.\/[^']+'/g)) {
      const r = rel.slice(1, -1);
      if (r.endsWith('vendor/web-llm/index.js')) { assert.match(build, /'vendor\/web-llm\/index\.js'/, 'the build copies web-llm'); continue; }
      const p = fileURLToPath(new URL(r, new URL('../../ai-checker/src/rewrite/engines/', import.meta.url)));
      assert.ok(existsSync(p), rel);
    }
  });

  test('no regex lookbehind in the engines (older Safari)', () => {
    for (const f of ['local.mjs', 'webllm.mjs', 'manual.mjs']) {
      const src = readFileSync(fileURLToPath(new URL(`../../ai-checker/src/rewrite/engines/${f}`, import.meta.url)), 'utf8');
      assert.doesNotMatch(src, /\(\?<[=!]/, f);
    }
  });
});

// ======================================================================================
// A fake web-llm: the engine runs in a "worker" that is just an object here.
function fakeWebLLM({ failLoad = {}, reply, hangLoad = false } = {}) {
  const calls = { loads: [], create: [], interrupts: 0, workers: [] };
  let i = 0;
  const lib = {
    prebuiltAppConfig: { model_list: [...QWEN3_MODELS, { model_id: 'Qwen3.5-9B-q4f16_1-MLC', vram_required_MB: 6433.01 }] },
    async CreateWebWorkerMLCEngine(worker, id, cfg) {
      calls.loads.push({ worker, id, cfg });
      for (let k = 1; k <= 20; k++) cfg.initProgressCallback?.({ progress: k / 20, text: `Fetching param cache[${k}/20]: ${k * 100}MB fetched.` });
      cfg.initProgressCallback?.({ progress: 1, text: 'Finish loading on WebGPU - apple' });
      if (hangLoad) await new Promise(() => {});
      if (failLoad[id]) throw failLoad[id];
      return {
        chat: { completions: { create: async (req) => { calls.create.push(req); return reply ? reply(req, i++) : { choices: [{ message: { role: 'assistant', content: ` Version ${i++}. ` } }] }; } } },
        interruptGenerate() { calls.interrupts++; },
      };
    },
  };
  const makeWorker = () => { const w = { terminated: false, terminate() { this.terminated = true; } }; calls.workers.push(w); return w; };
  return { lib, calls, makeWorker };
}
const fakeGpu = (limits = { maxBufferSize: 4 * GiB, maxStorageBufferBindingSize: 2 * GiB }, features = ['shader-f16']) => ({
  requestAdapter: async () => ({ limits, features: new Set(features), info: { vendor: 'apple' } }),
});
const webllm = (fake, opts = {}) => createWebLLMEngine({ gpu: fakeGpu(), navigator: { deviceMemory: 16 }, loadLib: async () => fake.lib, makeWorker: fake.makeWorker, ...opts });

describe('webllm engine: probe', () => {
  test('no WebGPU: ok=false with a clear reason', async () => {
    for (const gpu of [undefined, null, {}]) {
      const p = await createWebLLMEngine({ gpu, makeWorker: () => ({}) }).probe();
      assert.equal(p.ok, false);
      assert.equal(p.code, 'no-webgpu');
      assert.match(p.detail, /no WebGPU/);
      assert.match(p.detail, /Chrome or Edge/);
    }
  });

  test('WebGPU without an adapter', async () => {
    for (const requestAdapter of [async () => null, async () => { throw new Error('blocked'); }]) {
      const p = await createWebLLMEngine({ gpu: { requestAdapter }, makeWorker: () => ({}) }).probe();
      assert.equal(p.code, 'no-adapter');
      assert.match(p.detail, /chrome:\/\/gpu/);
    }
  });

  test('a capable GPU: ok with the chosen model, and nothing downloaded yet', async () => {
    const fake = fakeWebLLM();
    let loaded = 0;
    const eng = webllm(fake, { loadLib: async () => { loaded++; return fake.lib; } });
    const p = await eng.probe();
    assert.equal(p.ok, true);
    assert.equal(p.model, 'Qwen3-8B-q4f16_1-MLC');
    assert.match(p.detail, /Qwen3 8B fits/);
    assert.match(p.detail, /first use downloads it once/);
    assert.equal(loaded, 0, 'probe never loads the 6.8 MB library');
    assert.equal(fake.calls.workers.length, 0);
  });

  test('a small device: ok=false with the memory reason', async () => {
    const p = await webllm(fakeWebLLM(), { navigator: { deviceMemory: 2 } }).probe();
    assert.equal(p.ok, false);
    assert.equal(p.code, 'too-small');
    assert.match(p.detail, /not have enough graphics memory/);
  });

  test('a software adapter is refused', async () => {
    const gpu = { requestAdapter: async () => ({ limits: { maxBufferSize: 4 * GiB }, features: new Set(), info: { isFallbackAdapter: true } }) };
    assert.equal((await webllm(fakeWebLLM(), { gpu }).probe()).ok, false);
  });

  test('configure({model}) overrides the choice; empty goes back to automatic', async () => {
    const eng = webllm(fakeWebLLM());
    eng.configure({ model: '1.7B' });
    let p = await eng.probe();
    assert.equal(p.model, 'Qwen3-1.7B-q4f16_1-MLC');
    assert.match(p.detail, /chosen by hand/);
    eng.configure({ model: '8B' });
    p = await createWebLLMEngine({ gpu: fakeGpu(), navigator: { deviceMemory: 2 }, makeWorker: () => ({}), model: '8B' }).probe();
    assert.equal(p.ok, true);
    assert.match(p.detail, /may not fit/);
    eng.configure({ model: '' });
    assert.equal((await eng.probe()).model, 'Qwen3-8B-q4f16_1-MLC');
  });

  test('module exports the engine the page looks for', () => {
    assert.equal(webllmMod.engine.id, 'webllm');
    assert.equal(webllmMod.default, webllmMod.engine);
    assert.ok(webllmMod.engine.label);
    assert.equal(WEBLLM_VERSION, '0.2.86');
  });
});

describe('webllm engine: generate', () => {
  test('loads once in a worker and writes n versions with thinking off', async () => {
    const fake = fakeWebLLM();
    const eng = webllm(fake);
    const out = await eng.generate([{ system: 'SYS', user: 'USER', n: 3, maxTokens: 220 }, { user: 'U2', n: 1 }]);
    assert.deepEqual(out, [['Version 0.', 'Version 1.', 'Version 2.'], ['Version 3.']]);
    assert.equal(fake.calls.loads.length, 1);
    assert.equal(fake.calls.loads[0].id, 'Qwen3-8B-q4f16_1-MLC');
    assert.equal(fake.calls.loads[0].worker, fake.calls.workers[0]);
    assert.equal(typeof fake.calls.loads[0].cfg.initProgressCallback, 'function');
    assert.equal(fake.calls.loads[0].cfg.appConfig, fake.lib.prebuiltAppConfig);
    const r = fake.calls.create[0];
    assert.deepEqual(r.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]);
    assert.deepEqual(r.extra_body, { enable_thinking: false });
    assert.equal(r.temperature, 0.8);
    assert.equal(r.top_p, 0.95);
    assert.equal(r.n, 1);
    assert.equal(r.stream, false);
    assert.equal(r.max_tokens, 220);
    assert.deepEqual(fake.calls.create[3].messages, [{ role: 'user', content: 'U2' }]);
    assert.equal(fake.calls.create[3].max_tokens, 400);
    assert.equal(eng.model, 'Qwen3-8B-q4f16_1-MLC');
    // the second run reuses the loaded engine
    await eng.generate([{ user: 'again', n: 1 }]);
    assert.equal(fake.calls.loads.length, 1);
    assert.match((await eng.probe()).detail, /Loaded and ready/);
  });

  test('uses the library’s own model list (Qwen3, never Qwen3.5)', async () => {
    const fake = fakeWebLLM();
    await webllm(fake, { navigator: { deviceMemory: 64 }, gpu: fakeGpu({ maxBufferSize: 16 * GiB, maxStorageBufferBindingSize: 2 * GiB }) }).generate([{ user: 'u' }]);
    assert.equal(fake.calls.loads[0].id, 'Qwen3-8B-q4f16_1-MLC');
  });

  test('download progress is reported, at most one line per 10%', async () => {
    const msgs = [], all = [];
    await webllm(fakeWebLLM()).generate([{ user: 'u' }], { onProgress: (p) => { all.push(p); if (p.message) msgs.push(p.message); } });
    assert.ok(all.some((p) => p.stage === 'download' && p.progress === 1));
    const dl = msgs.filter((m) => /^Downloading Qwen3 8B: \d+%$/.test(m));
    assert.ok(dl.length >= 5 && dl.length <= 11, String(dl.length));
    assert.ok(msgs.some((m) => /Starting Qwen3 8B/.test(m)));
    assert.ok(msgs.some((m) => /Writing 1 version with Qwen3 8B/.test(m)));
  });

  test('two runs at once share one download', async () => {
    const fake = fakeWebLLM();
    const eng = webllm(fake);
    const [a, b] = await Promise.all([eng.generate([{ user: 'a' }]), eng.generate([{ user: 'b' }])]);
    assert.equal(fake.calls.loads.length, 1);
    assert.equal(a[0].length + b[0].length, 2);
  });

  test('out of graphics memory while loading: falls back to the next smaller model', async () => {
    const lost = Object.assign(new Error('The WebGPU device was lost while loading the model.'), { name: 'DeviceLostError' });
    const fake = fakeWebLLM({ failLoad: { 'Qwen3-8B-q4f16_1-MLC': lost } });
    const msgs = [];
    const out = await webllm(fake).generate([{ user: 'u' }], { onProgress: (p) => p.message && msgs.push(p.message) });
    assert.deepEqual(fake.calls.loads.map((l) => l.id), ['Qwen3-8B-q4f16_1-MLC', 'Qwen3-4B-q4f16_1-MLC']);
    assert.equal(fake.calls.workers[0].terminated, true);
    assert.equal(fake.calls.workers[1].terminated, false);
    assert.equal(out[0].length, 1);
    assert.ok(msgs.some((m) => /Qwen3 8B did not fit .*trying Qwen3 4B/.test(m)));
  });

  test('every size out of memory: a clear error', async () => {
    const lost = () => Object.assign(new Error('Device was lost'), { name: 'DeviceLostError' });
    const fake = fakeWebLLM({ failLoad: Object.fromEntries(QWEN3_MODELS.map((m) => [m.model_id, lost()])) });
    await assert.rejects(webllm(fake).generate([{ user: 'u' }]), (e) => e.code === 'gpu-memory' && /ran out of memory/.test(e.message));
    assert.equal(fake.calls.loads.length, 3);
  });

  test('a failed download is explained, and the next run tries again', async () => {
    const fake = fakeWebLLM({ failLoad: { 'Qwen3-8B-q4f16_1-MLC': new TypeError('Failed to fetch') } });
    const eng = webllm(fake);
    await assert.rejects(eng.generate([{ user: 'u' }]), (e) => e.code === 'download' && /huggingface\.co/.test(e.message));
    await assert.rejects(eng.generate([{ user: 'u' }]), (e) => e.code === 'download');
    assert.equal(fake.calls.loads.length, 2, 'not stuck on the first failure');
  });

  test('no WebGPU at generate time throws the probe reason', async () => {
    await assert.rejects(createWebLLMEngine({ gpu: undefined, makeWorker: () => ({}) }).generate([{ user: 'u' }]), (e) => e.code === 'no-webgpu');
  });

  test('one failed version is skipped; all failing throws', async () => {
    const fake = fakeWebLLM({ reply: (req, i) => { if (i === 1) throw new Error('decode error'); return { choices: [{ message: { content: `v${i}` } }] }; } });
    const msgs = [];
    const out = await webllm(fake).generate([{ user: 'u', n: 3 }], { onProgress: (p) => p.message && msgs.push(p.message) });
    assert.deepEqual(out, [['v0', 'v2']]);
    assert.match(msgs.at(-1), /1 of 3 versions could not be written/);
    const bad = fakeWebLLM({ reply: () => { throw new Error('context window size exceeded'); } });
    await assert.rejects(webllm(bad).generate([{ user: 'u', n: 2 }]), (e) => e.code === 'too-long');
  });

  test('empty replies and empty requests are skipped', async () => {
    const fake = fakeWebLLM({ reply: (req, i) => ({ choices: [{ message: { content: i === 0 ? '   ' : 'ok' } }] }) });
    const out = await webllm(fake).generate([{ user: 'u', n: 2 }, { user: '' }, null]);
    assert.deepEqual(out, [['ok'], [], []]);
    assert.equal(fake.calls.create.length, 2);
    assert.deepEqual(await webllm(fake).generate([]), []);
  });

  test('a lost device mid-run stops the run and reloads next time', async () => {
    const fake = fakeWebLLM({ reply: (req, i) => { if (i === 1) throw Object.assign(new Error('Device was lost'), { name: 'DeviceLostError' }); return { choices: [{ message: { content: `v${i}` } }] }; } });
    const eng = webllm(fake);
    const out = await eng.generate([{ user: 'u', n: 4 }]);
    assert.deepEqual(out, [['v0']]);
    assert.equal(fake.calls.create.length, 2);
    assert.equal(fake.calls.workers[0].terminated, true);
    await eng.generate([{ user: 'u' }]);
    assert.equal(fake.calls.loads.length, 2);
  });

  test('abort while writing interrupts the engine', async () => {
    const fake = fakeWebLLM({ reply: () => new Promise(() => {}) });
    const eng = webllm(fake);
    const ctl = new AbortController();
    const p = eng.generate([{ user: 'u', n: 3 }], { signal: ctl.signal });
    await tick(20);
    ctl.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(fake.calls.interrupts, 1);
    assert.equal(fake.calls.create.length, 1, 'no further versions after the abort');
  });

  test('abort while downloading ends the worker; the next run starts a fresh one', async () => {
    const fake = fakeWebLLM({ hangLoad: true });
    const eng = webllm(fake);
    const ctl = new AbortController();
    const msgs = [];
    const p = eng.generate([{ user: 'u' }], { signal: ctl.signal, onProgress: (x) => x.message && msgs.push(x.message) });
    await tick(20);
    ctl.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(fake.calls.workers[0].terminated, true);
    const before = msgs.length;
    const fake2 = fakeWebLLM();
    fake.lib.CreateWebWorkerMLCEngine = fake2.lib.CreateWebWorkerMLCEngine;
    assert.deepEqual(await eng.generate([{ user: 'u' }]), [['Version 0.']]);
    assert.equal(fake.calls.workers.length, 2);
    assert.equal(msgs.length, before, 'the stopped load reports nothing more');
  });

  test('a run waiting on a load that another run stopped is released, not left hanging', async () => {
    const fake = fakeWebLLM({ hangLoad: true });
    const eng = webllm(fake);
    const ctl = new AbortController();
    const first = eng.generate([{ user: 'a' }], { signal: ctl.signal });
    const second = eng.generate([{ user: 'b' }]);
    await tick(20);
    ctl.abort();
    await assert.rejects(first, { name: 'AbortError' });
    await assert.rejects(second, (e) => e.code === 'stopped');
    assert.equal(fake.calls.loads.length, 1);
  });

  test('unloading while a version is being written ends that run instead of hanging', async () => {
    const fake = fakeWebLLM({ reply: (req, i) => (i === 0 ? { choices: [{ message: { content: 'first' } }] } : new Promise(() => {})) });
    const eng = webllm(fake);
    const p = eng.generate([{ user: 'u', n: 3 }]);
    await tick(20);
    eng.unload();
    await assert.rejects(p, (e) => e.code === 'stopped');
  });

  test('an already aborted signal does nothing', async () => {
    const fake = fakeWebLLM();
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(webllm(fake).generate([{ user: 'u' }], { signal: ctl.signal }), { name: 'AbortError' });
    assert.equal(fake.calls.workers.length, 0);
  });

  test('unload ends the worker; the next run loads again', async () => {
    const fake = fakeWebLLM();
    const eng = webllm(fake);
    await eng.generate([{ user: 'u' }]);
    eng.unload();
    assert.equal(fake.calls.workers[0].terminated, true);
    assert.equal(eng.model, null);
    await eng.generate([{ user: 'u' }]);
    assert.equal(fake.calls.loads.length, 2);
  });

  test('changing the model in settings drops the loaded one', async () => {
    const fake = fakeWebLLM();
    const eng = webllm(fake);
    await eng.generate([{ user: 'u' }]);
    eng.configure({ model: '4B' });
    await eng.generate([{ user: 'u' }]);
    assert.deepEqual(fake.calls.loads.map((l) => l.id), ['Qwen3-8B-q4f16_1-MLC', 'Qwen3-4B-q4f16_1-MLC']);
    eng.configure({ model: '4B' });
    await eng.generate([{ user: 'u' }]);
    assert.equal(fake.calls.loads.length, 2, 'same setting, same engine');
  });
});

// Bugs found in review. Through the worker, web-llm rejects with err.toString(), a plain string
// (WebWorkerMLCEngine.getPromise: reject(msg.content)), never an Error object.
describe('webllm engine: review fixes', () => {
  const LOST = 'DeviceLostError: The WebGPU device was lost while loading the model. This issue often occurs due to running out of memory (OOM). To resolve this, try reloading with a model that has fewer parameters or uses a smaller context length.';

  test('the worker rejects with strings, as the real library does', () => {
    const src = readFileSync(fileURLToPath(new URL('../../node_modules/@mlc-ai/web-llm/lib/index.js', import.meta.url)), 'utf8');
    assert.match(src, /const errStr = err\.toString\(\);/);
    assert.match(src, /reject\(msg\.content\);/);
  });

  test('an out-of-memory string while loading falls back to the next smaller model', async () => {
    const fake = fakeWebLLM({ failLoad: { 'Qwen3-8B-q4f16_1-MLC': LOST } });
    const msgs = [];
    const out = await webllm(fake).generate([{ user: 'u' }], { onProgress: (p) => p.message && msgs.push(p.message) });
    assert.deepEqual(fake.calls.loads.map((l) => l.id), ['Qwen3-8B-q4f16_1-MLC', 'Qwen3-4B-q4f16_1-MLC']);
    assert.equal(out[0].length, 1);
    assert.ok(msgs.some((m) => /did not fit .*trying Qwen3 4B/.test(m)));
  });

  test('every size failing with the out-of-memory string: the memory message', async () => {
    const fake = fakeWebLLM({ failLoad: Object.fromEntries(QWEN3_MODELS.map((m) => [m.model_id, LOST])) });
    await assert.rejects(webllm(fake).generate([{ user: 'u' }]), (e) => e.code === 'gpu-memory' && typeof e.cause === 'string');
    assert.equal(fake.calls.loads.length, 3);
  });

  test('a device lost mid-run (string) stops the run and reloads next time', async () => {
    const fake = fakeWebLLM({ reply: (req, i) => { if (i === 1) return Promise.reject('Error: Device was lost. This can happen due to insufficient memory or other GPU constraints.'); return { choices: [{ message: { content: `v${i}` } }] }; } });
    const eng = webllm(fake);
    assert.deepEqual(await eng.generate([{ user: 'u', n: 4 }]), [['v0']]);
    assert.equal(fake.calls.create.length, 2, 'nothing more is sent to a lost device');
    assert.equal(fake.calls.workers[0].terminated, true);
    await eng.generate([{ user: 'u' }]);
    assert.equal(fake.calls.loads.length, 2);
  });

  test('load errors are explained by what they say, as strings', async () => {
    const cases = [
      ['ShaderF16SupportError: This model requires WebGPU extension shader-f16, which is not enabled in this browser.', 'gpu-feature'],
      ['QuotaExceededError: The quota has been exceeded.', 'storage'],
      ['TypeError: Failed to fetch', 'download'],
      ['Error: Cannot fetch https://huggingface.co/mlc-ai/Qwen3-8B-q4f16_1-MLC/resolve/main/params_shard_0.bin: HTTP 404', 'download'],
      // a WebGPU limit is not a full disk, and a size that contains 404 is not a missing file
      ['Error: Cannot initialize runtime because of requested maxStorageBufferBindingSize exceeds limit. requested=128MB, limit=64MB. ', 'webllm'],
      ['Error: Cannot initialize runtime because of requested maxBufferSize exceeds limit. requested=1404MB, limit=1024MB.', 'webllm'],
    ];
    for (const [err, code] of cases) {
      const fake = fakeWebLLM({ failLoad: { 'Qwen3-8B-q4f16_1-MLC': err } });
      await assert.rejects(webllm(fake).generate([{ user: 'u' }]), (e) => e.code === code, `${code}: ${err}`);
      assert.equal(fake.calls.loads.length, 1, err);
    }
    const long = fakeWebLLM({ reply: () => Promise.reject('ContextWindowSizeExceededError: Prompt tokens exceed context window size: number of prompt tokens: 4210; context window size: 4096') });
    await assert.rejects(webllm(long).generate([{ user: 'u', n: 2 }]), (e) => e.code === 'too-long' && /4,000 tokens/.test(e.message));
  });

  test('a worker whose script fails to load rejects instead of hanging, and the next run starts fresh', async () => {
    const fake = fakeWebLLM({ hangLoad: true });
    const workers = [];
    const makeWorker = () => {
      const w = Object.assign(new EventTarget(), { terminated: false, terminate() { this.terminated = true; } });
      workers.push(w);
      return w;
    };
    const eng = webllm(fake, { makeWorker });
    const p = eng.generate([{ user: 'u' }]);
    await tick(20);
    workers[0].dispatchEvent(Object.assign(new Event('error', { cancelable: true }), { message: "Uncaught SyntaxError: Cannot use import statement outside a module" }));
    await assert.rejects(p, (e) => e.code === 'worker' && /could not start/.test(e.message) && /SyntaxError/.test(e.message));
    assert.equal(workers[0].terminated, true);
    fake.lib.CreateWebWorkerMLCEngine = fakeWebLLM().lib.CreateWebWorkerMLCEngine;
    assert.deepEqual(await eng.generate([{ user: 'u' }]), [['Version 0.']]);
    assert.equal(workers.length, 2);
  });

  test('after falling back to a smaller model, probe reports the model that is loaded', async () => {
    const fake = fakeWebLLM({ failLoad: { 'Qwen3-8B-q4f16_1-MLC': LOST } });
    const eng = webllm(fake);
    await eng.generate([{ user: 'u' }]);
    const p = await eng.probe();
    assert.equal(p.ok, true);
    assert.equal(p.model, 'Qwen3-4B-q4f16_1-MLC');
    assert.match(p.detail, /^Qwen3 4B runs in this browser\. Loaded and ready\.$/);
    eng.unload();
    assert.equal((await eng.probe()).model, 'Qwen3-8B-q4f16_1-MLC', 'unloaded: back to the first choice');
  });

  test('a worker that cannot be created is a clear error, not a crash', async () => {
    const fake = fakeWebLLM();
    const makeWorker = () => { throw new DOMException("Failed to construct 'Worker'", 'SecurityError'); };
    await assert.rejects(webllm(fake, { makeWorker }).generate([{ user: 'u' }]), (e) => e.code === 'webllm' && /Worker/.test(e.message));
  });
});

// Copy/paste rewriter: one request for a Claude chat (or any chat app) holding every flagged
// sentence, and a parser for the reply. Nothing runs automatically, so generate() refuses with
// code 'manual' and the page shows the copy/paste box instead.
import { batchVariantsPrompt, parseVariantsReply } from '../prompts.mjs';

const MANUAL_HOWTO = 'The Claude chat rewriter works by copy and paste: copy the request into a Claude chat, then paste the whole reply back here. The checks and the choice of versions still run on this page.';

const idOf = (it) => it?.id ?? it?.index;

export function createManualEngine() {
  let lastIds = [];
  return {
    id: 'manual',
    label: 'Claude chat (copy and paste)',
    async probe() { return { ok: true, code: 'ok', detail: 'Always available: copy one request into Claude, paste the reply back.' }; },
    async generate() {
      const err = new Error(MANUAL_HOWTO);
      err.name = 'ManualEngineError';
      err.code = 'manual';
      throw err;
    },
    // items: [{index | id, before, sentence, after}] -> the text to paste into the chat
    buildRequest(items, { voice = '', samples = [], n = 4 } = {}) {
      const list = [].concat(items ?? []).filter((it) => it && idOf(it) != null && String(it.sentence ?? '').trim());
      lastIds = list.map(idOf);
      return batchVariantsPrompt({ items: list, voice, samples, n });
    },
    // -> Map<id, string[]> keyed by the ids as given (numbers stay numbers); ids default to the last request's
    parseReply(text, ids = lastIds) {
      return parseVariantsReply(text, ids == null ? lastIds : ids);
    },
  };
}

export const engine = createManualEngine();
export default engine;

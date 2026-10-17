// In-browser rewriter: runs @mlc-ai/web-llm's engine (Qwen3 on WebGPU) off the main thread.
// The page talks to it through web-llm's own WebWorkerMLCEngine (src/rewrite/engines/webllm.mjs),
// which sends the load, generate and interrupt messages; progress comes back the same way.
import { WebWorkerMLCEngineHandler } from '../vendor/web-llm/index.js';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);

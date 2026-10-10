// Tiny synchronous event bus. See ARCHITECTURE.md "Events" for the catalogue of event names + payloads.

export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(name, fn) {
    let list = this._handlers.get(name);
    if (!list) this._handlers.set(name, (list = []));
    list.push(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }

  off(name, fn) {
    const list = this._handlers.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** Emit synchronously. A throwing handler is logged and does not stop other handlers. */
  emit(name, payload) {
    const list = this._handlers.get(name);
    if (!list || list.length === 0) return;
    for (const fn of list.slice()) {
      try { fn(payload); } catch (e) { console.error(`[event ${name}] handler error:`, e); }
    }
  }
}

/* GPU7: persistent plan-phase worker pool. makePool(urlFor, size) spawns `size`
   plan-workers and routes call(i, msg, transfer) to worker i, resolving with its
   reply. Used inside compute-worker (nested workers) so the per-pixel/row-band
   phases run across cores while buildPlan stays a single async pipeline. */
(function (root) {
  const CS = root.CS = root.CS || {};

  function makePool(urlFor, size, callTimeoutMs) {
    const workers = [];
    const dead = new Array(size).fill(false);
    const pending = new Map(); // id -> { resolve, reject, worker, timer }
    let seq = 0;
    const TIMEOUT = callTimeoutMs || 120000;
    // R3: a worker that errors is permanently dead — reject its in-flight calls and
    // fail every later call fast instead of hanging until the outer timeout.
    function failWorker(i, err) {
      dead[i] = true;
      for (const [id, p] of pending) {
        if (p.worker !== i) continue;
        pending.delete(id); if (p.timer) clearTimeout(p.timer); p.reject(err);
      }
    }
    for (let i = 0; i < size; i++) {
      const w = new Worker(urlFor('plan-worker.js'));
      w.onmessage = (e) => {
        const d = e.data || {};
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id); if (p.timer) clearTimeout(p.timer);
        if (d.ok) p.resolve(d); else p.reject(new Error(d.error || 'plan-worker error'));
      };
      w.onerror = (e) => { failWorker(i, new Error((e && e.message) || 'plan-worker failed')); };
      workers.push(w);
    }
    function call(i, msg, transfer) {
      return new Promise((resolve, reject) => {
        if (dead[i]) { reject(new Error('plan-worker ' + i + ' permanently failed')); return; }
        const id = ++seq;
        const timer = setTimeout(() => {
          const p = pending.get(id);
          if (p) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error('plan-worker ' + i + ' call timeout')); }
          failWorker(i, new Error('plan-worker ' + i + ' unresponsive'));
        }, TIMEOUT);
        pending.set(id, { resolve, reject, worker: i, timer });
        try { workers[i].postMessage(Object.assign({ id }, msg), transfer || []); }
        catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
      });
    }
    return {
      size, workers, call,
      destroy() {
        for (const [id, p] of pending) { pending.delete(id); if (p.timer) clearTimeout(p.timer); p.reject(new Error('pool destroyed')); }
        for (const w of workers) { try { w.terminate(); } catch (e) { /* ignore */ } }
      }
    };
  }

  CS.parallel = { makePool };
})(typeof globalThis !== 'undefined' ? globalThis : this);
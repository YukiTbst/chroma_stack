/* GPU7: persistent plan-phase worker pool. makePool(urlFor, size) spawns `size`
   plan-workers and routes call(i, msg, transfer) to worker i, resolving with its
   reply. Used inside compute-worker (nested workers) so the per-pixel/row-band
   phases run across cores while buildPlan stays a single async pipeline. */
(function (root) {
  const CS = root.CS = root.CS || {};

  function makePool(urlFor, size) {
    const workers = [];
    const pending = new Map();
    let seq = 0;
    for (let i = 0; i < size; i++) {
      const w = new Worker(urlFor('plan-worker.js'));
      w.onmessage = (e) => {
        const d = e.data || {};
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        if (d.ok) p.resolve(d); else p.reject(new Error(d.error || 'plan-worker error'));
      };
      w.onerror = (e) => {
        const err = new Error((e && e.message) || 'plan-worker failed');
        for (const [id, p] of pending) { pending.delete(id); p.reject(err); }
      };
      workers.push(w);
    }
    function call(i, msg, transfer) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        try { workers[i].postMessage(Object.assign({ id }, msg), transfer || []); }
        catch (e) { pending.delete(id); reject(e); }
      });
    }
    return {
      size, workers, call,
      destroy() { for (const w of workers) { try { w.terminate(); } catch (e) { /* ignore */ } } }
    };
  }

  CS.parallel = { makePool };
})(typeof globalThis !== 'undefined' ? globalThis : this);
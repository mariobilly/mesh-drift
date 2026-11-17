// Undo / redo of whole-gradient snapshots, and the Recent list kept in localStorage.

export class History {
  constructor(limit = 120) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }

  /** Call with the state *before* a change. Identical consecutive snapshots are stored once. */
  record(doc) {
    const s = JSON.stringify(doc);
    if (this.past[this.past.length - 1] === s) return;
    this.past.push(s);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current) {
    if (!this.past.length) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(this.past.pop());
  }

  redo(current) {
    if (!this.future.length) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(this.future.pop());
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

/** Recent gradients: newest first, no duplicates (same seed + same points), capped. Storage can be missing. */
export class Recent {
  constructor(storage, key = 'mesh-drift.recent', limit = 24) {
    this.storage = storage;
    this.key = key;
    this.limit = limit;
    this.items = this.load();
  }

  load() {
    try {
      const v = JSON.parse(this.storage.getItem(this.key) || '[]');
      return Array.isArray(v) ? v.filter((x) => x && x.doc) : [];
    } catch {
      return [];
    }
  }

  save() {
    // Thumbnails are small, but if storage is full drop the oldest until it fits.
    for (let n = this.items.length; n >= 0; n--) {
      try {
        this.storage.setItem(this.key, JSON.stringify(this.items.slice(0, n)));
        this.items = this.items.slice(0, n);
        return;
      } catch { /* quota: retry with fewer */ }
    }
  }

  static fingerprint(doc) {
    return JSON.stringify([doc.seed, doc.points.map((p) => [p.x, p.y, p.color]), doc.shape, doc.motion.mode]);
  }

  add(doc, thumb = '') {
    const fp = Recent.fingerprint(doc);
    this.items = this.items.filter((it) => Recent.fingerprint(it.doc) !== fp);
    this.items.unshift({ doc: JSON.parse(JSON.stringify(doc)), thumb, at: Date.now() });
    this.items = this.items.slice(0, this.limit);
    this.save();
  }

  remove(index) {
    this.items.splice(index, 1);
    this.save();
  }

  clear() {
    this.items = [];
    this.save();
  }
}

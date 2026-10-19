'use strict';
// Browse state for one slot: a stack of menu nodes, as Crestron Home's IMenu sees it.
// Node: { title, functions? } plus either
//   items: Item[] | () => Promise<Item[]>              (small, fully materialised lists)
//   count: () => Promise<number>, page: (start, n) => Promise<Item[]>   (large lists, fetched on demand; start is 0-based)
// Item: { l1, l2?, art?, open?: () => Node, play?: () => void, context?: () => Node }
// Levels: home is 0, open() goes one deeper, a context menu (PressAndHold) stays at the same level.

const DEFAULT_FUNCTIONS = ['Favorites', 'BackToTop'];

class Menu {
  constructor(home) { this.home = home; this.stack = []; }

  async init() { this.stack = [await this._enter(this.home, 0)]; return this; }
  async _enter(node, level) {
    if (node.page) {
      const total = await node.count();
      return { node, total, level, get: (start, n) => node.page(start, n) };
    }
    const items = typeof node.items === 'function' ? await node.items() : node.items;
    return { node, total: items.length, level, get: async (start, n) => items.slice(start, start + n) };
  }
  get top() { return this.stack[this.stack.length - 1]; }

  get props() {
    const t = this.top;
    return { Title: t.node.title, ItemCnt: t.total, Level: t.level, ListSpecificFunctions: t.node.functions || DEFAULT_FUNCTIONS };
  }

  // item is 1-based as in the protocol
  async data(item, count) {
    const start = Math.max(0, item - 1), n = Math.max(0, Math.min(count, this.top.total - start));
    return n ? (await this.top.get(start, n)).map(i => ({ L1: i.l1, L2: i.l2 || '', art: i.art || '' })) : [];
  }
  async _item(n) { return n >= 1 && n <= this.top.total ? (await this.top.get(n - 1, 1))[0] : undefined; }

  // -> 'navigated' | 'played' | null (bad index / nothing to do)
  async select(n) {
    const it = await this._item(n);
    if (!it) return null;
    if (it.open) { this.stack.push(await this._enter(await it.open(), this.top.level + 1)); return 'navigated'; }
    if (it.play) { await it.play(); return 'played'; }
    return null;
  }
  async pressAndHold(n) {
    const it = await this._item(n);
    if (!it || !it.context) return null;
    const node = await it.context();
    node.title = node.title || it.l1;
    this.stack.push(await this._enter(node, this.top.level));
    return 'navigated';
  }
  // jump straight to a list one level below home (Favorites / QuickList buttons)
  async goto(node) { this.stack = [this.stack[0], await this._enter(node, 1)]; }
  // plus button: the open long-press menu's own action (add that item to the queue)
  async create() { const f = this.top.node.create; if (!f) return false; await f(); return true; }
  back() { if (this.stack.length > 1) { this.stack.pop(); return true; } return false; }
  async backToTop() { this.stack = [await this._enter(this.home, 0)]; }
}

module.exports = { Menu };

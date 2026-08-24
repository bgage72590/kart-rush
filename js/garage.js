// ---------------------------------------------------------------------------
// Garage: coin wallet, kart part upgrades, paint. Persisted in localStorage.
// ---------------------------------------------------------------------------
import { CFG } from './config.js';
import * as Store from './store.js';

export const PARTS = {
  engine: { label: 'ENGINE', tiers: ['Stock', 'Turbo V6', 'Nitro X'], cost: [0, 60, 150], desc: '+ top speed' },
  tires: { label: 'TIRES', tiers: ['Stock', 'Slicks', 'All-Terrain'], cost: [0, 60, 150], desc: '+ grip, tier 3 shrugs off grass' },
  spoiler: { label: 'SPOILER', tiers: ['Stock', 'Carbon', 'Sky Wing'], cost: [0, 60, 150], desc: '+ drift charge speed' },
};

export const PAINTS = [
  -1, 0xe8443c, 0xff7a30, 0xffd94d, 0x46c46a, 0x18e0ff, 0x3d8ef2, 0xa45ce8, 0xff4fd8, 0x23252e,
];

const KEY = 'kartrush2.garage';

export const Garage = {
  coins: 0,
  equipped: { engine: 0, tires: 0, spoiler: 0 },
  owned: { engine: [true, false, false], tires: [true, false, false], spoiler: [true, false, false] },
  paint: -1,

  load() {
    try {
      const d = JSON.parse(Store.get(KEY));
      if (d) {
        this.coins = d.coins | 0;
        if (d.equipped) this.equipped = { ...this.equipped, ...d.equipped };
        if (d.owned) this.owned = { ...this.owned, ...d.owned };
        if (typeof d.paint === 'number') this.paint = d.paint;
      }
    } catch (e) { /* fresh start */ }
  },

  save() {
    Store.set(KEY, JSON.stringify({
      coins: this.coins, equipped: this.equipped, owned: this.owned, paint: this.paint,
    }));
  },

  addCoins(n) {
    this.coins = Math.max(0, this.coins + n);
    this.save();
  },

  buyOrEquip(part, tier) {
    if (this.owned[part][tier]) {
      this.equipped[part] = tier;
      this.save();
      return 'equipped';
    }
    const cost = PARTS[part].cost[tier];
    if (this.coins < cost) return 'poor';
    this.coins -= cost;
    this.owned[part][tier] = true;
    this.equipped[part] = tier;
    this.save();
    return 'bought';
  },

  setPaint(i) {
    this.paint = PAINTS[i] === -1 ? -1 : PAINTS[i];
    this.save();
  },

  // physics modifiers for the player's kart
  mods() {
    const e = this.equipped;
    return {
      top: 1 + e.engine * 0.022,
      steer: 1 + e.tires * 0.055,
      grass: e.tires === 2 ? 0.72 : CFG.grassFactor,
      drift: 1 + e.spoiler * 0.16,
      tiers: { ...e },
      paint: this.paint,
    };
  },
};

Garage.load();

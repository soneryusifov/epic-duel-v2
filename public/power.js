// EPIC DUEL power rating. ONE source file: the server requires it and the game page embeds the same text, so both always compute the same number.
// The rating is computed only from validated inputs (class, skill points, gear, weapon tiers, upgrades); a client can never send its own rating.
(function (root) {
  const T = {"BHP":{"tank":825,"vampire":450,"mage":510,"warrior":630,"support":735,"elf":560,"assassin":525,"ninja":580,"engineer":745,"paladin":760,"dragon":765,"necro":620,"monk":725,"pirate":750,"chrono":790},"MXB":{"mage":40,"support":40,"engineer":20,"necro":40,"chrono":40},"ARM":{"tank":0.75,"assassin":1.1,"paladin":0.88},"WM":{"sword":30,"pistol":45,"bazooka":60},"CP":{"tank":[2.3,0.8184],"vampire":[3.02,1.1093],"mage":[3,1.1671],"warrior":[2.575,1.2842],"support":[1.75,1.2381],"elf":[4.4,0.9388],"assassin":[3.77,1.211],"ninja":[3.12,1.1703],"engineer":[2.45,1.0667],"paladin":[2.515,0.9679],"dragon":[3.625,0.8558],"necro":[3.205,0.9691],"monk":[3.09,0.9972],"pirate":[4.76,0.7107],"chrono":[3.1167,0.8203]}};
  const GBH = { armor: [4, 7, 11, 16, 22, 26, 30, 34, 38, 42], helmet: [2, 4, 6, 9, 12, 14, 16, 18, 20, 22], boots: [2, 3, 5, 7, 10, 12, 14, 16, 18, 20] }, GBD = { gloves: [2, 4, 6, 9, 12, 14, 16, 18, 20, 22], pauldron: [2, 3, 5, 8, 11, 13, 15, 17, 19, 21], cape: [1, 2, 4, 6, 9, 11, 13, 15, 17, 19] };
  const UPS = ['sword', 'pistol', 'bazooka'], UPM = 5;
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const gear = g => { let h = 0, d = 0; if (g) { for (const k in GBH) { const v = g[k]; if (int(v, 0, 9)) h += GBH[k][v]; } for (const k in GBD) { const v = g[k]; if (int(v, 0, 9)) d += GBD[k][v]; } } return { hp: h / 100, dm: d / 100 }; };
  const cleanUp = u => { const o = {}; UPS.forEach(k => { const a = u && Array.isArray(u[k]) ? u[k] : []; o[k] = [0, 1, 2].map(i => int(a[i], 0, UPM) ? a[i] : 0); }); return o; };
  const bon = i => i < 0 ? 0 : .10 + .90 * i / 9;
  // s = { cls, al:{dmg,dx,hp,ls,mp,df,dm}, wt:{sword,pistol,bazooka}, gr:{slot:design}, up:{sword:[p,s,e],...} }
  function powerCalc(s) {
    const cls = T.CP[s.cls] ? s.cls : 'mage', al = s.al || {}, A = k => al[k] | 0, gb = gear(s.gr), up = cleanUp(s.up), wt = s.wt || {};
    const pd = 1 - Math.min(.5, .02 * A('df')), md = 1 - Math.min(.5, .02 * A('dm'));
    const mhp = Math.round(T.BHP[cls] * (1 + gb.hp) + 27 * A('hp')), mmp = cls == 'warrior' ? 0 : 100 + 4 * A('mp') + (T.MXB[cls] || 0);
    const lsr = (cls == 'vampire' ? .5 + .02 * up.sword[1] : 0) + .03 * A('ls'), arm = T.ARM[cls] || 1;
    const b = k => T.WM[k] * (1 + bon(wt[k] == null ? -1 : wt[k])) * (1 + .04 * A('dmg')) * (1 + gb.dm) * (1 + .03 * up[k][0]);
    const ehp = mhp / (((pd + md) / 2) * arm) * (1 + lsr * .6);
    const top = b('sword') * (1 + .05 * A('dx')) * T.CP[cls][0], off = (top + (b('pistol') + b('bazooka')) * .5) * (1 + Math.max(0, mmp - 100) / 300) * T.CP[cls][1];
    return Math.round(Math.sqrt(ehp * off) * 10 / 3);
  }
  // progression: one XP curve for every class, independent of the level cap (raising MAXL later never slows the early levels)
  const XP = { c0: 40, c1: 5.6, p: 1.9, MAXL: 100 };
  const xpNeed = L => Math.round(XP.c0 + XP.c1 * Math.pow(L - 1, XP.p));
  const levelOf = xp => { let L = 1, need = 0; while (L < XP.MAXL) { need += xpNeed(L); if (xp < need) break; L++; } return L; };
  const ptsOf = L => 30 + (L - 1) + 2 * Math.floor(L / 10);
  const api = { XP, xpNeed, levelOf, ptsOf, T, powerCalc, gear, cleanUp, bon, int, GBH, GBD, UPS, UPM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EDPOWER = api;
})(typeof window !== 'undefined' ? window : globalThis);

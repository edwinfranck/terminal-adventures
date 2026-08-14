/* progress.js — XP et rangs. Les noms de rangs viennent de l'univers (JSON),
   jamais du moteur : « Mousse → Yonko » ou « E Rank → Monarch », c'est du contenu. */

import { t } from './core.js';

export function rankFor(ranks = [], xp = 0) {
  let current = ranks[0] || { name: '—', xp: 0 };
  let next = null;
  for (const r of ranks) {
    if (xp >= r.xp) current = r;
    else { next = r; break; }
  }
  const from = current.xp;
  const to = next ? next.xp : current.xp;
  const ratio = next ? Math.min(1, (xp - from) / Math.max(1, to - from)) : 1;
  return { name: t(current.name), next: next && t(next.name), ratio, xp };
}

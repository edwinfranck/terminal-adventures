/* save.js — persistance. Un seul objet dans localStorage, versionné.
   Si le format change, on bump VERSION et l'ancienne sauvegarde est ignorée sans crash. */

const KEY = 'terminal-adventures';
const VERSION = 1;

const blank = () => ({ version: VERSION, universes: {}, prefs: {} });

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw?.version === VERSION) return raw;
  } catch { /* sauvegarde corrompue : on repart proprement */ }
  return blank();
}

let data = read();

function write() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* mode privé : on joue sans sauver */ }
}

/* État d'un univers : { xp, done: [levelId] } */
export function universeState(id) {
  return data.universes[id] ||= { xp: 0, done: [] };
}

export function isDone(universeId, levelId) {
  return universeState(universeId).done.includes(levelId);
}

export function markDone(universeId, levelId, xp = 0) {
  const st = universeState(universeId);
  if (!st.done.includes(levelId)) { st.done.push(levelId); st.xp += xp; }
  write();
}

/* Préférences d'affichage : elles survivent à un #reset de la progression. */
export function pref(key, value) {
  data.prefs ||= {};
  if (value === undefined) return data.prefs[key];
  data.prefs[key] = value;
  write();
  return value;
}

export function resetAll() {
  const keep = data.prefs || {};
  data = blank();
  data.prefs = keep;
  write();
}

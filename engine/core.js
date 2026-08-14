/* core.js — les primitives partagées : bus d'événements, i18n, helpers DOM.
   Aucun autre module du moteur n'a le droit de connaître le DOM global ailleurs qu'ici. */

/* ---------------- bus d'événements ----------------
   Le moteur et les plugins ne s'appellent jamais directement : ils publient.  */
const listeners = new Map();

export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, payload) {
    (listeners.get(event) || []).forEach(fn => fn(payload));
  }
};

/* ---------------- i18n ----------------
   t() accepte une string ("Salut") OU un objet ({fr:'Salut', en:'Hi'}).
   Tout le contenu passe par là : ajouter une langue ne demande aucun code. */
export let LANG = 'fr';
export const setLang = l => { LANG = l; bus.emit('lang:change', l); };

export function t(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  return value[LANG] ?? value.fr ?? value.en ?? fallback;
}

/* ---------------- helpers DOM ---------------- */
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  children.flat().forEach(c => c != null && node.append(c));
  return node;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Résout un chemin d'image. Dans le build autonome les fichiers sont embarqués en
   data-URI : asset() renvoie alors la donnée au lieu du chemin. */
export const asset = path => globalThis.__ASSETS?.[path] || path;

/* Charge une feuille de style une seule fois (utilisé par les plugins). */
const loaded = new Set();
export function loadCSS(href) {
  if (loaded.has(href)) return;
  loaded.add(href);
  document.head.append(el('link', { rel: 'stylesheet', href }));
}

/* Charge un JSON avec un message d'erreur qui dit quoi faire.
   Dans le build autonome (build.py), tout le contenu est déjà embarqué dans __DATA. */
export async function loadJSON(url) {
  if (globalThis.__DATA?.[url]) return structuredClone(globalThis.__DATA[url]);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(
      `Impossible de charger ${url}.\n` +
      `Le jeu doit être servi en HTTP (ES modules + fetch) : lance ./serve.sh`
    );
  }
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/* ---------------- icônes ----------------
   Des SVG au trait, jamais d'emoji : un emoji est dessiné par le système (donc
   différent sur chaque machine, et souvent en couleur) — il ne peut pas suivre la
   charte. Ceux-ci héritent de `currentColor` et restent nets à toute taille. */
const svg = body => `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  /* cadenas fermé : anse au trait, corps plein */
  lock: svg(
    '<path d="M5 7.5V5a3 3 0 0 1 6 0v2.5" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<path d="M2.75 7.5h10.5v6.75H2.75z" fill="currentColor"/>' +
    '<path d="M8 9.6v2.6" stroke="var(--panel2)" stroke-width="1.6" stroke-linecap="square"/>'),
  /* coche : deux segments, bouts carrés — aucun arrondi */
  check: svg('<path d="M2.8 8.4l3.6 3.6L13.2 5" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter"/>'),
  /* cadenas ouvert : l'anse se relève — pour un chapitre accessible */
  unlock: svg(
    '<path d="M5 7.5V5a3 3 0 0 1 5.8-1.1" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<path d="M2.75 7.5h10.5v6.75H2.75z" fill="currentColor"/>')
};

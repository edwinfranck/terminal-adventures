/* objectives.js — les critères de réussite, côté moteur.
   Un critère dans le JSON du niveau ressemble à :
     { "label":"Le dossier ship_repairs existe", "check":"dirExists", "args":["ship_repairs"] }
   Le moteur ne sait pas ce que « dirExists » veut dire : il le demande au plugin
   via instance.test(check, args). C'est tout le principe. */

import { $, t, el, bus } from './core.js';

let current = { criteria: [], instance: null, onWin: null, won: false, was: [] };

export function mount(level, instance, onWin) {
  current = { criteria: level.criteria || [], instance, onWin, won: false, was: [] };
  const list = $('#criteriaList');
  list.innerHTML = '';
  // Le libellé est enveloppé : le <li> est un conteneur flex (à cause de la case à cocher),
  // donc un <code class="p"> posé directement dedans deviendrait une colonne au lieu d'une ligne.
  current.criteria.forEach((c, idx) =>
    list.append(el('li', { 'data-i': idx }, el('div', { class: 'ct', html: t(c.label) })))
  );
  // Premier passage SILENCIEUX : certains critères sont déjà vrais au départ (une contrainte
  // du genre « n'y touche pas »). Sans ça, le mentor féliciterait avant qu'on ait rien fait.
  refresh(true);
}

/* Appelé par le plugin (api.changed()) à chaque mutation du monde. */
export function refresh(silent = false) {
  if (!current.instance) return;
  let done = 0;

  current.criteria.forEach((c, idx) => {
    let ok = false;
    try {
      ok = !!current.instance.test(c.check, c.args || []);
    } catch (e) {
      console.warn(`[objectives] test("${c.check}") a échoué :`, e.message);
    }
    const li = $(`#criteriaList li[data-i="${idx}"]`);
    if (li) li.classList.toggle('done', ok);
    // un objectif qui vient de basculer : le mentor a quelque chose à dire
    if (ok && !current.was[idx] && !silent) bus.emit('criterion:done', idx);
    current.was[idx] = ok;
    if (ok) done++;
  });

  // combien il en reste : la réponse à « où j'en suis ? » doit être visible sans réfléchir
  const count = $('#critCount');
  if (count) {
    count.textContent = current.criteria.length ? `${done}/${current.criteria.length}` : '';
    count.classList.toggle('full', done === current.criteria.length);
  }

  if (!current.won && current.criteria.length && done === current.criteria.length) {
    current.won = true;
    current.onWin?.();
  }
}

export function unmount() {
  current = { criteria: [], instance: null, onWin: null, won: false };
  $('#criteriaList').innerHTML = '';
}

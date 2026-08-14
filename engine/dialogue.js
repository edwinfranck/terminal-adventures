/* dialogue.js — le moteur de dialogue façon Pokémon : portrait, nom, texte tapé, choix.
   Format attendu (dans le JSON du niveau) :
     [ { "who":"Luffy", "face":"🏴‍☠️", "text":"Oi !" },
       { "who":"Luffy", "text":"Tu sais utiliser un terminal ?",
         "choices":[ {"label":"Oui"}, {"label":"Pas encore"} ] } ]
   play() rend une Promise résolue quand le dialogue est terminé. */

import { $, t, el, asset } from './core.js';

const SPEED = 18; // ms par caractère

/* Le portrait accepte une image (chemin) ou un emoji. Aucune animation dessus :
   c'est une consigne de charte, le personnage ne doit pas bouger. */
function setPortrait(host, face) {
  host.innerHTML = '';
  if (!face) return;
  if (/[./]/.test(face)) host.append(el('img', { src: asset(face), alt: '' }));
  else host.append(document.createTextNode(face));
}

export function play(lines = [], defaults = {}) {
  const box      = $('#vnBox');
  const nameEl   = $('#vnName');
  const textEl   = $('#vnText');
  const faceEl   = $('#vnPortrait');
  const nextEl   = $('#vnNext');
  const choicesEl= $('#vnChoices');
  const scene    = $('[data-scene="dialogue"]');

  return new Promise(resolve => {
    let i = 0;
    let typing = null;     // timer en cours
    let full = '';         // texte complet de la ligne courante
    let waiting = false;   // en attente d'un choix

    function typeLine(str) {
      full = str;
      textEl.textContent = '';
      nextEl.hidden = true;
      let k = 0;
      clearInterval(typing);
      typing = setInterval(() => {
        textEl.textContent = str.slice(0, ++k);
        if (k >= str.length) { clearInterval(typing); typing = null; nextEl.hidden = false; }
      }, SPEED);
    }

    function renderChoices(choices) {
      waiting = true;
      nextEl.hidden = true;
      choices.forEach(c => choicesEl.append(el('button', {
        class: 'vn-choice',
        onclick: ev => { ev.stopPropagation(); choicesEl.innerHTML = ''; waiting = false; step(); }
      }, t(c.label))));
    }

    function step() {
      choicesEl.innerHTML = '';
      if (i >= lines.length) return finish();
      const line = lines[i++];
      nameEl.textContent = t(line.who ?? defaults.who ?? '');
      nameEl.hidden = !nameEl.textContent;
      setPortrait(faceEl, t(line.face ?? defaults.face ?? ''));
      typeLine(t(line.text));
      if (line.choices) {
        // on attend la fin de la frappe avant d'afficher les choix
        const wait = setInterval(() => {
          if (!typing) { clearInterval(wait); renderChoices(line.choices); }
        }, 40);
      }
    }

    function advance() {
      if (waiting) return;
      if (typing) { clearInterval(typing); typing = null; textEl.textContent = full; nextEl.hidden = false; return; }
      step();
    }

    function onKey(e) {
      if (['Enter', ' ', 'Spacebar'].includes(e.key)) { e.preventDefault(); advance(); }
    }

    function finish() {
      scene.removeEventListener('click', advance);
      document.removeEventListener('keydown', onKey);
      clearInterval(typing);
      resolve();
    }

    scene.addEventListener('click', advance);
    document.addEventListener('keydown', onKey);
    box.hidden = false;
    step();
  });
}

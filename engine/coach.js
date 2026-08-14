/* coach.js — le coup de main automatique.

   Un joueur bloqué deux minutes sans rien qui bouge abandonne. Personne ne clique sur
   « indice » quand ça coûte de l'XP et qu'on ne sait même pas ce qu'on cherche.
   Alors c'est le jeu qui vient : le mentor pose une QUESTION qui débloque, gratuitement.

   Il se déclenche sur deux signaux, jamais sur une horloge seule :
     · plus rien ne progresse depuis un moment ALORS QUE le joueur agit
     · plusieurs erreurs de suite

   Les relances viennent du niveau (`mentor.nudge`). Quand elles sont épuisées, il propose
   l'indice payant — mais c'est le joueur qui décide. */

import { bus } from './core.js';

const IDLE_MS = 70_000;      // sans progrès, alors qu'on tape
const ERRORS_MAX = 3;        // erreurs d'affilée

let timer = null;
let errors = 0;
let used = 0;
let nudges = [];
let armed = false;           // on n'embête personne avant sa première action

function fire(reason) {
  clearTimeout(timer);
  timer = null;
  errors = 0;
  if (used < nudges.length) {
    bus.emit('coach:say', { text: nudges[used++], offerHint: used >= nudges.length, reason });
  } else {
    bus.emit('coach:say', {
      text: 'Tu tournes en rond, et ce n’est pas grave — ça arrive à tout le monde. '
          + 'Prends l’indice : il coûte un peu d’XP, il ne coûte pas ta soirée.',
      offerHint: true, reason
    });
  }
}

function rearm() {
  clearTimeout(timer);
  if (!armed || used > nudges.length) return;
  timer = setTimeout(() => fire('inactif'), IDLE_MS);
}

/** Démarre la surveillance pour un niveau. */
export function watch(levelNudges = []) {
  stop();
  nudges = levelNudges.map(String);
  errors = 0;
  used = 0;
  armed = false;
}

export function stop() {
  clearTimeout(timer);
  timer = null;
  armed = false;
  nudges = [];
}

/* Le joueur agit → on arme et on repart de zéro sur le compte à rebours. */
bus.on('player:action', () => { armed = true; rearm(); });

/* Un objectif tombe → il avance, on le laisse tranquille. */
bus.on('criterion:done', () => { errors = 0; rearm(); });

/* Trop d'erreurs de suite → on n'attend pas la fin du minuteur. */
bus.on('player:error', () => {
  if (++errors >= ERRORS_MAX) fire('erreurs');
  else rearm();
});

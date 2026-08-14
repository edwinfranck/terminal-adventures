/* app.js — point d'entrée. On enregistre les plugins, on câble l'UI, on affiche le menu.
   Ajouter un gameplay = 1 import + 1 register. Rien d'autre dans le moteur ne change. */

import { register } from './registry.js';
import * as game from './game.js';
import './coach.js';   // se branche tout seul sur le bus   // se branche tout seul sur le bus

import terminal from '../plugins/terminal/index.js';
import algo from '../plugins/algo/index.js';

register(terminal);
register(algo);

game.wire();
game.boot();

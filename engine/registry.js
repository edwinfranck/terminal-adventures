/* registry.js — le contrat de plugin. C'est LE fichier qui garde le moteur ignorant.
   Le moteur ne sait pas ce qu'est `mkdir` ni ce que veut dire `moveRight()`.
   Il sait seulement demander à un plugin : « monte-toi, charge ce niveau, ce critère est-il rempli ? »

   ------------------------------------------------------------------
   UN PLUGIN EXPORTE :
   {
     id:    'terminal',                       // référencé par universe.json → "plugin"
     label: 'Terminal',                       // affiché dans l'UI
     create(host, api) -> instance            // host = l'élément DOM à remplir
   }

   UNE INSTANCE EXPOSE :
   {
     load(world, level)   // construit le monde depuis level.world (forme libre)
     reset()              // remet le niveau à zéro
     test(check, args)    // -> bool : le moteur évalue les critères par ici
     arsenal(level)       // -> [{cmd, desc, fresh}] : ce qui s'affiche dans « Arsenal »
     help()               // -> [{title, text?, commands?}] : l'écran d'aide (? Aide)
     destroy()            // nettoie tout (listeners, timers, DOM)
   }

   L'API QUE LE MOTEUR DONNE AU PLUGIN :
   {
     changed()            // « le monde a bougé » -> le moteur ré-évalue les critères
     t(value)             // i18n
     level                // le niveau courant (lecture seule)
   }
   ------------------------------------------------------------------ */

const plugins = new Map();

export function register(plugin) {
  if (!plugin?.id) throw new Error('Plugin sans id');
  for (const fn of ['create']) {
    if (typeof plugin[fn] !== 'function') throw new Error(`Plugin ${plugin.id} : ${fn}() manquant`);
  }
  plugins.set(plugin.id, plugin);
}

export function getPlugin(id) {
  const p = plugins.get(id);
  if (!p) throw new Error(`Plugin inconnu : "${id}". Enregistré : ${[...plugins.keys()].join(', ') || '(aucun)'}`);
  return p;
}

export const listPlugins = () => [...plugins.values()];

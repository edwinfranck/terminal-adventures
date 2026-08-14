/* plugins/terminal/index.js — PLUGIN « TERMINAL ».
   Gameplay : le joueur tape de vraies commandes, le monde est un système de fichiers.
   Univers qui l'utilisent : One Piece (et plus tard Cyberpunk, DevOps…).

   Le niveau décrit son monde ainsi :
     "world": {
       "fs":       { "cale": { "carnet.txt": "..." } },   // arbre de départ
       "commands": ["pwd","ls","cd","mkdir"],             // ce qui est autorisé
       "new":      ["mkdir"],                             // marqué NEW dans l'arsenal
       "motd":     "Le pont du Sunny craque sous tes pieds."
     } */

import { el, loadCSS, t, bus } from '../../engine/core.js';
import { VFS, canRead, canWrite, canExec } from './vfs.js';
import { run, DOC, commandsIn } from './shell.js';

loadCSS('plugins/terminal/terminal.css');

/* help et clear marchent dans tous les niveaux : elles doivent donc apparaître
   dans l'arsenal et dans l'aide, même si le niveau ne les déclare pas. */
const usable = level => {
  const list = [...(level?.world?.commands || [])];
  for (const c of ['help', 'clear']) if (!list.includes(c)) list.push(c);
  return list.filter(c => DOC[c]);
};

export default {
  id: 'terminal',
  label: 'Terminal',

  create(host, api) {
    /* ---------------- vue ----------------
       Présentation reprise de piscine.html : une barre de fenêtre, puis un corps
       où l'invite est UNE LIGNE DU FLUX (.cur). La sortie s'insère AVANT elle :
       l'historique monte, l'invite reste toujours au bout — comme un vrai terminal. */
    const title  = el('span', { class: 'tt' });
    const bar    = el('div', { class: 'tbar' },
      el('i', { class: 'd1' }), el('i', { class: 'd2' }), el('i', { class: 'd3' }), title);

    const prompt = el('span', { class: 'pr' });
    // La première consigne, c'est « help » : elle apprend à se débrouiller seul plutôt
    // qu'à attendre qu'on lui dise quoi taper. Et elle disparaît dès la première commande.
    const PROMPT_HINT = 'tape help pour commencer';
    const input  = el('input', {
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      placeholder: PROMPT_HINT
    });
    const cur    = el('div', { class: 'l cur' }, prompt, input);
    const body   = el('div', { class: 'tbody' }, cur);
    const term   = el('div', { class: 'term' }, bar, body);
    host.append(term);

    /* ---------------- état ---------------- */
    let fs = new VFS({});
    let allowed = new Set();
    let ran = new Set();          // commandes déjà utilisées (pour le critère ranCommand)
    const history = [];
    let hpos = 0;

    const promptText = () => `${t(api.universe.prompt || 'user@quest')}:${fs.cwdPath}$`;

    /** Insère une ligne AVANT l'invite : l'historique se construit au-dessus. */
    function emit(cls, fill) {
      const node = el('div', { class: cls ? `l ${cls}` : 'l' });
      fill(node);
      body.insertBefore(node, cur);
      body.scrollTop = body.scrollHeight;
      return node;
    }

    const printText = (text, cls) => { if (text) emit(cls, n => { n.textContent = text; }); };
    const printHTML = (html, cls) => { if (html) emit(cls, n => { n.innerHTML = html; }); };

    /** Rejoue la commande tapée, invite comprise, comme un vrai terminal. */
    function echoCommand(raw) {
      emit('', n => {
        n.append(el('span', { class: 'ps' }, promptText()));
        n.append(document.createTextNode(' '));
        n.append(el('span', { class: 'cmd' }, raw));
      });
    }

    function refreshPrompt() { prompt.textContent = promptText(); }

    function submit(raw) {
      input.placeholder = '';           // vu une fois, ça suffit
      echoCommand(raw);
      commandsIn(raw).forEach(c => ran.add(c));   // tubes et && compris

      if (raw.trim()) bus.emit('player:action');
      const res = run(fs, raw, allowed);
      if (res.clear) [...body.querySelectorAll('.l:not(.cur)')].forEach(n => n.remove());
      else if (res.err) { printText(res.err, 'err'); bus.emit('player:error', res.err); }
      else if (res.html) printHTML(res.html);
      else printText(res.out);

      refreshPrompt();
      api.changed();               // → le moteur ré-évalue les critères
    }

    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const raw = input.value;
      input.value = '';
      if (raw.trim()) { history.push(raw); hpos = history.length; }
      submit(raw);
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp')   { e.preventDefault(); if (hpos > 0) input.value = history[--hpos] ?? ''; }
      if (e.key === 'ArrowDown') { e.preventDefault(); hpos = Math.min(history.length, hpos + 1); input.value = history[hpos] ?? ''; }
      if (e.key === 'Tab')       { e.preventDefault(); complete(); }
    });

    /* ---------------- complétion Tab ----------------
       Premier mot = une commande. Ensuite = un fichier ou un dossier du niveau.
       Un seul candidat → on complète ; plusieurs → on affiche la liste, comme un vrai shell. */
    function complete() {
      const value = input.value;
      const cut = value.lastIndexOf(' ') + 1;
      const token = value.slice(cut);

      let options, decorate = s => s;
      if (cut === 0) {
        options = usable(api.level).filter(c => c.startsWith(token));
      } else {
        const slash = token.lastIndexOf('/') + 1;
        const dir = token.slice(0, slash) || '.';
        const partial = token.slice(slash);
        const listing = fs.ls(dir);
        if (listing.err) return;
        options = listing.entries
          .filter(e => e.name.startsWith(partial))
          .map(e => token.slice(0, slash) + e.name + (e.type === 'dir' ? '/' : ''));
        decorate = s => s;
      }
      if (!options.length) return;

      if (options.length === 1) {
        input.value = value.slice(0, cut) + decorate(options[0]) + (cut === 0 ? ' ' : '');
        return;
      }
      // plusieurs candidats : on complète le préfixe commun et on montre la liste
      const common = options.reduce((a, b) => {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return a.slice(0, i);
      });
      input.value = value.slice(0, cut) + common;
      printHTML(options.map(o => `<span class="${o.endsWith('/') ? 'd' : 'f'}">${o}</span>`).join('   '));
    }

    // On écrit ses commandes soi-même : coller ne fait rien apprendre.
    input.addEventListener('paste', e => {
      e.preventDefault();
      printText('Écris-le toi-même — c’est comme ça que ça rentre.', 'dimc');
    });
    input.addEventListener('drop', e => e.preventDefault());

    // cliquer n'importe où dans le terminal redonne le focus — sauf si on sélectionne du texte
    term.addEventListener('click', e => {
      if (e.target.tagName !== 'INPUT' && !window.getSelection()?.toString()) input.focus();
    });

    /* ---------------- contrat de plugin ---------------- */
    return {
      load(world) {
        fs = new VFS(world.fs || {});
        allowed = new Set(world.commands || []);
        ran = new Set();
        [...body.querySelectorAll('.l:not(.cur)')].forEach(n => n.remove());
        input.placeholder = PROMPT_HINT;
        title.textContent = `terminal — ${t(api.universe.title).toLowerCase()}`;
        if (world.motd) printText(t(world.motd), 'dimc');
        refreshPrompt();
        setTimeout(() => input.focus(), 50);
      },

      reset() { this.load(api.level.world || {}); },

      /* Le moteur pose des questions, le plugin répond. Il n'y a que ça de spécifique. */
      test(check, args) {
        const [a, b] = args;
        switch (check) {
          case 'dirExists':    return fs.get(a)?.type === 'dir';
          case 'fileExists':   return fs.get(a)?.type === 'file';
          case 'pathMissing':  return fs.get(a) == null;
          case 'cwdIs':        return fs.cwdPath === (a.startsWith('~') ? a : `~/${a}`.replace(/\/$/, ''));
          case 'ranCommand':   return ran.has(a);
          case 'fileContains': {
            const n = fs.get(a);
            return n?.type === 'file' && n.content.toLowerCase().includes(String(b).toLowerCase());
          }
          case 'fileEquals': {
            const n = fs.get(a);
            return n?.type === 'file' && n.content.trim() === String(b).trim();
          }
          case 'fileLacks': {
            const n = fs.get(a);
            return n?.type === 'file' && !n.content.toLowerCase().includes(String(b).toLowerCase());
          }
          case 'dirContains': {
            const n = fs.get(a);
            if (n?.type !== 'dir') return false;
            return Object.values(n.children).some(c =>
              c.type === 'file' && c.content.toLowerCase().includes(String(b).toLowerCase()));
          }
          /* lget : on veut LE LIEN, pas ce qu'il désigne — sinon un lien juste
             est indiscernable d'une copie du fichier. */
          case 'isLink': {
            const n = fs.lget(a);
            if (n?.type !== 'link') return false;
            return b == null || fs.resolve(n.target).join('/') === fs.resolve(b).join('/');
          }
          case 'linkWorks':    return fs.lget(a)?.type === 'link' && fs.get(a) != null;
          case 'hasRight': {
            const n = fs.lget(a);
            if (!n) return false;
            const has = { r: canRead, w: canWrite, x: canExec };
            return [...String(b)].every(l => has[l] && has[l](n));
          }
          case 'lacksRight': {
            const n = fs.lget(a);
            if (!n) return false;
            const has = { r: canRead, w: canWrite, x: canExec };
            return [...String(b)].every(l => has[l] && !has[l](n));
          }
          case 'allLinks':     return args.every(p => fs.lget(p)?.type === 'link');
          case 'isArchive':    return fs.get(a)?.archive != null;
          case 'archiveHas': {
            const r = fs.listArchive(a);
            return !r.err && r.entries.some(e => e.toLowerCase().includes(String(b).toLowerCase()));
          }
          case 'archiveLacks': {
            const r = fs.listArchive(a);
            return !r.err && !r.entries.some(e => e.toLowerCase().includes(String(b).toLowerCase()));
          }
          case 'countIn': {
            const n = fs.get(a);
            return n?.type === 'dir' && Object.keys(n.children).length >= Number(b);
          }
          default:
            console.warn(`[terminal] critère inconnu : ${check}`);
            return false;
        }
      },

      arsenal(level) {
        const fresh = new Set(level.world?.new || []);
        return usable(level).map(c => ({
          cmd: DOC[c]?.usage || c,
          desc: DOC[c]?.desc || '',
          fresh: fresh.has(c)
        }));
      },

      /* Contenu de l'écran d'aide. Le moteur ne fait que l'habiller. */
      help() {
        return [
          {
            title: 'Comment on joue',
            text:
              'Tu ne cliques sur rien : tu <b>tapes des commandes</b> dans le terminal, comme un vrai ' +
              'développeur. La ligne de saisie est <b>toujours la dernière</b> : ce que tu tapes s’ajoute ' +
              'au-dessus d’elle, et l’historique monte.\n' +
              'Chaque commande agit sur un <b>monde de fichiers</b> : des dossiers (des lieux) et des ' +
              'fichiers (des objets). Rien n’est simulé à moitié — si tu crées un dossier, il existe.\n' +
              'À gauche, la liste <b>Objectifs</b> se coche toute seule dès que le monde correspond. ' +
              'Quand tout est coché, le niveau est gagné. Personne ne corrige : c’est le résultat qui parle.'
          },
          {
            title: 'Les commandes disponibles ici',
            commands: usable(api.level).map(c => ({
              cmd: DOC[c].usage, desc: DOC[c].desc, ex: DOC[c].ex
            }))
          },
          {
            title: 'Se repérer',
            commands: [
              { cmd: '~',  desc: 'ton point de départ (la « maison »)',        ex: 'cd ~' },
              { cmd: '.',  desc: 'là où tu es en ce moment',                    ex: 'ls .' },
              { cmd: '..', desc: 'le lieu juste au-dessus',                     ex: 'cd ..' },
              { cmd: 'a/b', desc: 'un chemin : b se trouve dans a',             ex: 'cd cale/ship_repairs' }
            ]
          },
          {
            title: 'Combiner : c\'est là que le terminal devient puissant',
            commands: [
              { cmd: '*', desc: 'remplace n’importe quoi : agit sur tous les fichiers d’un coup',
                ex: 'cat courrier/*   ·   grep Marine courrier/*' },
              { cmd: '|', desc: 'envoie le résultat de gauche dans la commande de droite',
                ex: 'ls | wc -l   ·   cat journal.txt | tail -3' },
              { cmd: '&&', desc: 'enchaîne : la seconde ne part que si la première a réussi',
                ex: 'mkdir preuves && cd preuves' }
            ]
          },
          {
            title: 'Les trois droits : r, w, x',
            text:
              'Chaque fichier et chaque dossier porte trois droits. <b>r</b> = le lire, <b>w</b> = le modifier, ' +
              '<b>x</b> = l’<i>exécuter</i> pour un fichier, le <i>traverser</i> pour un dossier.\n' +
              '<code>ls -l</code> les affiche devant le nom : <code>drwxr-xr-x</code> — le <code>d</code> dit ' +
              '« dossier », puis viennent r, w, x. Un tiret à la place d’une lettre, c’est un droit absent.\n' +
              'Attention : lister un dossier (r) et y entrer (x) sont <b>deux droits différents</b>. On peut voir ' +
              'sans pouvoir entrer.'
          },
          {
            title: 'Deux réflexes qui font gagner du temps',
            commands: [
              { cmd: 'Tab',   desc: 'complète ce que tu as commencé à taper : une commande, un dossier, un fichier',
                ex: 'mkd → Tab → mkdir' },
              { cmd: '↑ ↓',   desc: 'retrouver une commande déjà tapée' },
              { cmd: '>  >>', desc: '> écrit dans un fichier (et écrase), >> ajoute à la fin', ex: 'echo "note" >> journal.txt' }
            ]
          }
        ];
      },

      destroy() { host.innerHTML = ''; }
    };
  }
};

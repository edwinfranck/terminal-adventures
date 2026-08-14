/* shell.js — l'interpréteur. Il traduit une ligne tapée en opérations sur le VFS.
   Volontairement limité aux commandes qu'on enseigne : pas de vraie exécution, jamais.
   Retourne { out, err } — deux chaînes, le rendu est le problème de la vue. */

const HELP_ORDER = ['pwd','ls','cd','mkdir','touch','echo','cat','cp','mv','rm','find','grep','wc','head','tail','ln','chmod','tar','help','clear'];

/* help et clear ne sont pas des compétences à débloquer : elles marchent toujours,
   dans tous les niveaux. Les verrouiller n'apprend rien à personne. */
const ALWAYS = new Set(['help', 'clear']);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const DOC = {
  pwd:   { usage: 'pwd',                            desc: 'Où suis-je ?',                     ex: 'pwd' },
  ls:    { usage: 'ls [chemin]',                    desc: 'Regarder autour de soi',           ex: 'ls   ·   ls -a   ·   ls cale' },
  cd:    { usage: 'cd <dossier>',                   desc: 'Se déplacer',                      ex: 'cd cale   ·   cd ..   ·   cd ~' },
  mkdir: { usage: 'mkdir [-p] <nom>',               desc: 'Construire un lieu',               ex: 'mkdir atelier   ·   mkdir -p a/b/c' },
  touch: { usage: 'touch <fichier>',                desc: 'Créer un objet vide',              ex: 'touch plan.txt' },
  echo:  { usage: 'echo "texte" [> fichier]',       desc: 'Dire quelque chose — ou l’écrire',  ex: 'echo "bois" > plan.txt' },
  cat:   { usage: 'cat <fichier>',                  desc: 'Lire',                             ex: 'cat plan.txt' },
  cp:    { usage: 'cp [-r] <source> <dest>',        desc: 'Dupliquer',                        ex: 'cp plan.txt ~/cabine' },
  mv:    { usage: 'mv <source> <dest>',             desc: 'Déplacer ou renommer',             ex: 'mv vieux.txt neuf.txt' },
  rm:    { usage: 'rm [-r] <cible>',                desc: 'Détruire',                         ex: 'rm note.txt   ·   rm -r dossier' },
  find:  { usage: 'find [motif]',                   desc: 'Chercher partout',                 ex: 'find .txt' },
  grep:  { usage: 'grep [-i] <motif> [fichier…]',   desc: 'Ne garder que les lignes qui contiennent', ex: 'grep Marine courrier/*' },
  wc:    { usage: 'wc [-l] [fichier]',              desc: 'Compter lignes, mots, caractères',  ex: 'ls | wc -l' },
  head:  { usage: 'head [-n N] [fichier]',          desc: 'Les premières lignes',              ex: 'head -3 journal.txt' },
  tail:  { usage: 'tail [-n N] [fichier]',          desc: 'Les dernières lignes',              ex: 'tail -3 journal.txt' },
  ln:    { usage: 'ln -s <cible> <nom>',            desc: 'Créer un raccourci vers un fichier',  ex: 'ln -s cale/plan.txt plan' },
  chmod: { usage: 'chmod <droits> <cible>',         desc: 'Ouvrir ou fermer un accès',           ex: 'chmod +x script   ·   chmod 000 secret.txt' },
  tar:   { usage: 'tar -czf <arch> <dossier>',      desc: 'Emballer, lister ou déballer',        ex: 'tar -czf wano.tgz coffre   ·   tar -xzf wano.tgz' },
  help:  { usage: 'help',                           desc: 'La liste de ce que tu sais faire',  ex: 'help' },
  clear: { usage: 'clear',                          desc: 'Nettoyer l’écran',                 ex: 'clear' }
};

import { modeString } from './vfs.js';

/* Découpe une ligne en respectant les guillemets : echo "hello world" → ['echo','hello world'] */
export function tokenize(line) {
  const out = [];
  let cur = '', quote = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/* Extrait une redirection > / >> de la fin des arguments. */
function extractRedirect(args) {
  const i = args.findIndex(a => a === '>' || a === '>>');
  if (i === -1) return { args, redirect: null };
  const target = args[i + 1];
  return {
    args: args.slice(0, i),
    redirect: target ? { target, append: args[i] === '>>' } : { error: 'redirection sans fichier cible' }
  };
}

const splitFlags = args => ({
  flags: args.filter(a => /^-[A-Za-z]+$/.test(a)).join(''),
  rest:  args.filter(a => !/^-[A-Za-z]+$/.test(a) && !/^-\d+$/.test(a)),
  num:   Number((args.find(a => /^-\d+$/.test(a)) || '').slice(1)) || null
});

/** Découpe sur un séparateur en ignorant ce qui est entre guillemets. */
function splitTop(line, sep) {
  const parts = [];
  let cur = '', quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (line.startsWith(sep, i)) { parts.push(cur); cur = ''; i += sep.length - 1; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Les jokers : `courrier/*` devient la liste des fichiers du dossier. */
function expand(fs, args) {
  const out = [];
  for (const a of args) {
    if (!a.includes('*')) { out.push(a); continue; }
    const slash = a.lastIndexOf('/');
    const dir = slash === -1 ? '.' : (a.slice(0, slash) || '/');
    const pattern = a.slice(slash + 1);
    const listing = fs.ls(dir);
    if (listing.err) { out.push(a); continue; }
    const rx = new RegExp('^' + pattern.split('*')
      .map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const hit = listing.entries.filter(e => rx.test(e.name))
      .map(e => (slash === -1 ? '' : a.slice(0, slash + 1)) + e.name);
    out.push(...(hit.length ? hit : [a]));   // sans correspondance : motif laissé tel quel
  }
  return out;
}

/** Toutes les commandes d'une ligne, tubes et `&&` compris.
   Sans ça, `ls | wc -l` ne compterait que `ls` comme utilisée. */
export function commandsIn(line) {
  return splitTop(line, '&&')
    .flatMap(chain => splitTop(chain, '|'))
    .map(seg => tokenize(seg.trim())[0])
    .filter(Boolean);
}

/**
 * Point d'entrée : gère les enchaînements `&&` et les tubes `|`, puis délègue à exec().
 * @param {VFS} fs
 * @param {string} line
 * @param {Set<string>} allowed  commandes débloquées pour ce niveau (vide = tout)
 */
export function run(fs, line, allowed) {
  if (!line.trim()) return { out: '' };
  if (line.includes('||')) return { err: '|| n’est pas géré ici. Un seul tube à la fois : |' };

  let last = { out: '' };
  for (const chain of splitTop(line, '&&')) {
    if (!chain.trim()) return { err: '&& attend une commande de chaque côté.' };

    const stages = splitTop(chain, '|');   // la sortie de gauche devient l'entrée de droite
    let stdin = null;
    for (let i = 0; i < stages.length; i++) {
      if (!stages[i].trim()) return { err: '| attend une commande de chaque côté.' };
      last = exec(fs, stages[i], allowed, stdin, i < stages.length - 1);
      if (last.err || last.clear) return last;
      stdin = last.out;
    }
  }
  return last;
}

/**
 * Exécute UNE commande.
 * @param {string|null} stdin  ce que la commande de gauche a produit
 * @param {boolean} piped      il y a une commande à droite : la sortie reste en lignes
 */
function exec(fs, segment, allowed, stdin, piped) {
  const tokens = tokenize(segment.trim());
  if (!tokens.length) return { out: '' };

  const cmd = tokens[0];
  let { args, redirect } = extractRedirect(tokens.slice(1));
  args = expand(fs, args);
  const { flags, rest, num } = splitFlags(args);

  /** Le texte à traiter : les fichiers donnés, sinon ce qui arrive du tube. */
  const input = () => {
    if (!rest.length) {
      return stdin == null
        ? { err: `${cmd} : il manque un fichier (ou quelque chose avant le tube).` }
        : { text: stdin };
    }
    const parts = [];
    for (const f of rest) {
      const r = fs.read(f);
      if (r.err) return { err: r.err.replace(/^cat:/, `${cmd}:`) };
      parts.push(r.content);
    }
    return { text: parts.join('\n') };
  };

  if (!DOC[cmd]) return { err: `${cmd} : commande inconnue. Tape \`help\` pour voir ce que tu sais faire.` };
  if (allowed?.size && !allowed.has(cmd) && !ALWAYS.has(cmd)) {
    // Ne jamais laisser sur un mur : dire ce qu'on sait faire À LA PLACE.
    return { err: `${cmd} : pas encore débloquée. Tape \`help\` — l'arsenal, à droite, liste tout ce que tu sais faire ici.` };
  }
  if (redirect?.error) return { err: redirect.error };

  let out = '', err = null, html = null;

  switch (cmd) {
    case 'pwd':
      out = fs.cwdPath;
      break;

    case 'ls': {
      const r = fs.ls(rest[0] || '.');
      if (r.err) { err = r.err; break; }
      const show = flags.includes('a')
        ? [{ name: '.', type: 'dir' }, { name: '..', type: 'dir' }, ...r.entries]
        : r.entries;
      const long = flags.includes('l');
      const sep = (long || piped) ? '\n' : '   ';
      const label = e => e.type === 'dir' ? `${e.name}/`
                       : e.type === 'link' ? `${e.name} -> ${e.node?.target ?? '?'}`
                       : e.name;
      const cls = e => e.type === 'dir' ? 'd' : e.type === 'link' ? 'lnk' : 'f';
      // -l ajoute les droits devant : c'est comme ça qu'on apprend à les lire
      const rights = e => (long && e.node) ? modeString(e.node) + '  ' : '';
      out = show.map(e => rights(e) + label(e)).join(sep);
      html = show.map(e =>
        `<span class="dimc">${esc(rights(e))}</span><span class="${cls(e)}">${esc(label(e))}</span>`
      ).join(sep);
      break;
    }

    case 'cd':
      err = fs.cd(rest[0] || '~');
      break;

    case 'mkdir':
      if (!rest.length) { err = 'mkdir : il manque un nom de dossier'; break; }
      for (const p of rest) { err = fs.mkdir(p, { parents: flags.includes('p') }); if (err) break; }
      break;

    case 'touch':
      if (!rest.length) { err = 'touch : il manque un nom de fichier'; break; }
      for (const p of rest) { err = fs.touch(p); if (err) break; }
      break;

    case 'echo':
      out = rest.join(' ');
      break;

    case 'cat': {
      const src = input();
      if (src.err) { err = src.err; break; }
      // un fichier se termine par un saut de ligne : ne pas l'afficher comme une ligne vide
      out = src.text.replace(/\n$/, '');
      break;
    }

    case 'grep': {
      const motif = rest.shift();
      if (motif == null) { err = 'grep : il manque le motif à chercher'; break; }
      const ci = flags.includes('i');
      const needle = ci ? motif.toLowerCase() : motif;
      const keep = l => (ci ? l.toLowerCase() : l).includes(needle);

      // Sur PLUSIEURS fichiers, le vrai grep annonce d'où vient chaque ligne : sans ça,
      // on trouve la ligne coupable sans jamais savoir dans quel fichier elle était.
      if (rest.length > 1) {
        const lines = [];
        for (const f of rest) {
          const r = fs.read(f);
          if (r.err) { err = r.err.replace(/^cat:/, 'grep:'); break; }
          r.content.split('\n').filter(keep).forEach(l => lines.push(`${f}:${l}`));
        }
        if (err) break;
        out = lines.join('\n');
        break;
      }

      const src = input();
      if (src.err) { err = src.err; break; }
      out = src.text.split('\n').filter(keep).join('\n');
      break;
    }

    case 'wc': {
      const src = input();
      if (src.err) { err = src.err; break; }
      const text = src.text.replace(/\n$/, '');
      const lines = text === '' ? 0 : text.split('\n').length;
      const words = text.split(/\s+/).filter(Boolean).length;
      if (flags.includes('l')) out = String(lines);
      else if (flags.includes('w')) out = String(words);
      else if (flags.includes('c')) out = String(text.length);
      else out = `${lines} ${words} ${text.length}`;
      break;
    }

    case 'head':
    case 'tail': {
      // le nombre peut venir de `-3` ou de `-n 3` : dans le second cas il est DANS rest,
      // il faut le retirer avant de lire les fichiers
      let n = num;
      if (n == null && flags.includes('n')) {
        const i = rest.findIndex(a => /^\d+$/.test(a));
        if (i !== -1) n = Number(rest.splice(i, 1)[0]);
      }
      n = n ?? 10;
      const src = input();
      if (src.err) { err = src.err; break; }
      const lines = src.text.replace(/\n$/, '').split('\n');
      out = (cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n');
      break;
    }

    case 'cp':
      if (rest.length < 2) { err = 'cp : il faut une source et une destination'; break; }
      err = fs.copy(rest[0], rest[1], { recursive: flags.includes('r') || flags.includes('R') });
      break;

    case 'mv':
      if (rest.length < 2) { err = 'mv : il faut une source et une destination'; break; }
      err = fs.move(rest[0], rest[1]);
      break;

    case 'rm':
      if (!rest.length) { err = 'rm : il manque une cible'; break; }
      for (const p of rest) { err = fs.rm(p, { recursive: flags.includes('r') }); if (err) break; }
      break;

    case 'find': {
      const motif = rest[0];
      out = fs.walk()
        .filter(e => !motif || e.path.includes(motif))
        .map(e => './' + e.path)
        .join('\n') || '(rien trouvé)';
      break;
    }

    case 'ln': {
      if (!flags.includes('s')) { err = 'ln : ici on ne fait que des raccourcis. Utilise -s.'; break; }
      if (rest.length < 2) { err = 'ln : il faut une cible et un nom de raccourci'; break; }
      err = fs.link(rest[0], rest[1]);
      break;
    }

    case 'chmod': {
      // les droits arrivent parfois en drapeau (+x est lu comme une option)
      const spec = rest.length >= 2 ? rest[0]
                 : args.find(a => /^[+-][rwx]+$/.test(a) || /^[ugoa]*[+-][rwx]+$/.test(a));
      const target = rest.length >= 2 ? rest[1] : rest[0];
      if (!spec || !target) { err = 'chmod : il faut des droits et une cible. Ex : chmod +x script'; break; }
      err = fs.chmod(target, spec);
      break;
    }

    case 'tar': {
      const arch = rest[0], src = rest[1];
      if (!arch) { err = 'tar : il manque le nom de l’archive'; break; }
      if (flags.includes('c')) {
        if (!src) { err = 'tar : il manque le dossier à emballer'; break; }
        err = fs.pack(src, arch);
      } else if (flags.includes('x')) {
        err = fs.unpack(arch);
      } else if (flags.includes('t')) {
        const r = fs.listArchive(arch);
        if (r.err) { err = r.err; break; }
        out = r.entries.join('\n');
        html = r.entries.map(e => `<span class="${e.endsWith('/') ? 'd' : 'f'}">${esc(e)}</span>`).join('\n');
      } else {
        err = 'tar : dis ce que tu veux faire — -c emballer, -x déballer, -t lister';
      }
      break;
    }

    case 'help': {
      const names = allowed?.size
        ? HELP_ORDER.filter(c => allowed.has(c) || ALWAYS.has(c))
        : HELP_ORDER;
      out = names.map(c => `  ${c.padEnd(7)} ${DOC[c].desc}`).join('\n');
      html = names.map(c =>
        `  <span class="d">${c.padEnd(7)}</span> <span class="dimc">${esc(DOC[c].desc)}</span>`
      ).join('\n');
      break;
    }

    case 'clear':
      return { clear: true };
  }

  if (err) return { err };

  // redirection : la sortie va dans un fichier au lieu de l'écran
  if (redirect) {
    const werr = fs.write(redirect.target, out + (out ? '\n' : ''), { append: redirect.append });
    return werr ? { err: werr } : { out: '' };
  }
  return { out, html };
}

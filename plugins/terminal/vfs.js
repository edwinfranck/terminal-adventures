/* vfs.js — système de fichiers virtuel. Aucune dépendance, aucun accès au vrai disque.
   Un dossier  : { type:'dir',  children:{} }
   Un fichier  : { type:'file', content:'' }

   Le niveau décrit l'arbre de départ en JSON, façon raccourci :
     { "cartes": { "east-blue.txt": "Rien à signaler." }, "cale": {} }
   → objet = dossier, string = fichier. */

export const dirNode  = () => ({ type: 'dir',  children: {}, mode: 0o755 });
export const fileNode = (content = '') => ({ type: 'file', content, mode: 0o644 });
/** Un lien ne contient rien : il DÉSIGNE une autre place. */
export const linkNode = target => ({ type: 'link', target, mode: 0o777 });
/** Une archive est un fichier qui porte un arbre replié. */
export const archiveNode = tree => ({ type: 'file', content: '', archive: tree, mode: 0o644 });

/* Droits : on n'expose que ceux du propriétaire — trois lettres, c'est déjà une leçon.
   Par défaut tout est permis ; seul un niveau qui appelle chmod peut fermer une porte. */
export const canRead  = n => (n.mode ?? 0o644) & 0o400;
export const canWrite = n => (n.mode ?? 0o644) & 0o200;
export const canExec  = n => (n.mode ?? 0o644) & 0o100;

/** `rwxr-xr-x` — la forme que `ls -l` affiche et que chmod modifie. */
export function modeString(node) {
  const m = node.mode ?? (node.type === 'dir' ? 0o755 : 0o644);
  const bit = (b, ch) => (m & b) ? ch : '-';
  return (node.type === 'dir' ? 'd' : node.type === 'link' ? 'l' : '-')
    + bit(0o400, 'r') + bit(0o200, 'w') + bit(0o100, 'x')
    + bit(0o040, 'r') + bit(0o020, 'w') + bit(0o010, 'x')
    + bit(0o004, 'r') + bit(0o002, 'w') + bit(0o001, 'x');
}

function fromSeed(seed = {}) {
  const node = dirNode();
  for (const [name, value] of Object.entries(seed)) {
    if (typeof value === 'string') { node.children[name] = fileNode(value); continue; }
    // formes explicites, pour qu'un niveau puisse poser un lien ou fermer un droit
    if (value && value.$link)  { node.children[name] = linkNode(value.$link); continue; }
    // { "$tar": { "coffre": { … } } } — une archive déjà scellée, à ouvrir en jeu
    if (value && value.$tar) {
      const [root, tree] = Object.entries(value.$tar)[0];
      node.children[name] = archiveNode({
        name: root,
        node: typeof tree === 'string' ? fileNode(tree) : fromSeed(tree)
      });
      continue;
    }
    if (value && value.$file != null) {
      const f = fileNode(value.$file);
      if (value.$mode != null) f.mode = parseInt(String(value.$mode), 8);
      node.children[name] = f; continue;
    }
    const dir = fromSeed(value.$dir || value);
    if (value.$mode != null) dir.mode = parseInt(String(value.$mode), 8);
    node.children[name] = dir;
  }
  return node;
}

export class VFS {
  constructor(seed) {
    this.root = fromSeed(seed);
    this.cwd = [];               // chemin courant, relatif à la racine (= ~)
  }

  /* ---------------- chemins ---------------- */

  /** Transforme un chemin utilisateur en tableau de segments normalisé (absolu depuis ~). */
  resolve(path) {
    if (!path || path === '.') return [...this.cwd];
    let parts;
    if (path === '~' || path.startsWith('~/')) parts = path.slice(2).split('/');
    else if (path.startsWith('/'))            parts = path.slice(1).split('/');
    else                                      parts = [...this.cwd, ...path.split('/')];

    const out = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return out;
  }

  #norm(parts) {
    const out = [];
    for (const p of parts) { if (!p || p === '.') continue; if (p === '..') out.pop(); else out.push(p); }
    return out;
  }

  /** Marche dans l'arbre en SUIVANT les liens. La profondeur borne les boucles. */
  #walk(parts, depth = 0) {
    if (depth > 8) return null;                  // lien qui pointe en rond
    let node = this.root, dir = [];
    for (const part of parts) {
      if (node?.type !== 'dir') return null;
      node = node.children[part];
      if (!node) return null;
      if (node.type === 'link') {
        const t = node.target;
        const abs = t.startsWith('~/') ? t.slice(2)
                  : t.startsWith('/')  ? t.slice(1)
                  : [...dir, t].join('/');       // un lien relatif part de SON dossier
        node = this.#walk(this.#norm(abs.split('/')), depth + 1);
        if (!node) return null;
      }
      dir = [...dir, part];
    }
    return node;
  }

  get(path) { return this.#walk(this.resolve(path)); }

  /** Le nœud SANS suivre un lien final — pour l'afficher, le déplacer ou l'effacer. */
  lget(path) {
    const { parent, name } = this.locate(path);
    return parent ? parent.children[name] ?? null : null;
  }

  /** { parent, name } pour créer/supprimer une entrée. parent=null si le chemin est invalide. */
  locate(path) {
    const parts = this.resolve(path);
    if (!parts.length) return { parent: null, name: null }; // on ne touche pas à la racine
    const name = parts.pop();
    const node = this.#walk(parts);
    return { parent: node?.type === 'dir' ? node : null, name };
  }

  pathOf(parts = this.cwd) { return '~' + (parts.length ? '/' + parts.join('/') : ''); }
  get cwdPath() { return this.pathOf(this.cwd); }

  /* ---------------- opérations ---------------- */

  cd(path) {
    const node = this.get(path);
    if (!node) return `cd: ${path}: aucun dossier de ce nom`;
    if (node.type !== 'dir') return `cd: ${path}: ce n'est pas un dossier`;
    if (!canExec(node)) return `cd: ${path}: permission refusée (il manque le droit x)`;
    this.cwd = this.resolve(path);
    return null;
  }

  ls(path = '.') {
    // un lien vers un FICHIER se montre lui-même (l… nom -> cible) ; un lien vers un
    // dossier se traverse, comme le vrai ls.
    const direct = this.lget(path);
    if (direct?.type === 'link' && this.get(path)?.type !== 'dir')
      return { entries: [{ name: path, type: 'link', node: direct }] };
    const node = this.get(path);
    if (!node) return { err: `ls: ${path}: aucun fichier ou dossier de ce nom` };
    if (node.type === 'file') return { entries: [{ name: path, type: 'file', node }] };
    if (!canRead(node)) return { err: `ls: ${path}: permission refusée (il manque le droit r)` };
    return {
      entries: Object.entries(node.children)
        .map(([name, n]) => ({ name, type: n.type, node: n }))
        .sort((a, b) => a.name.localeCompare(b.name))
    };
  }

  mkdir(path, { parents = false } = {}) {
    const parts = this.resolve(path);
    if (!parts.length) return `mkdir: nom de dossier manquant`;
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const last = i === parts.length - 1;
      const child = node.children[name];
      if (child) {
        if (child.type !== 'dir') return `mkdir: ${name}: un fichier porte déjà ce nom`;
        if (last && !parents) return `mkdir: ${path}: ce dossier existe déjà`;
        node = child;
      } else {
        if (!last && !parents) return `mkdir: ${path}: dossier parent introuvable (essaie -p)`;
        node = node.children[name] = dirNode();
      }
    }
    return null;
  }

  touch(path) {
    const { parent, name } = this.locate(path);
    if (!parent) return `touch: ${path}: dossier parent introuvable`;
    if (!parent.children[name]) parent.children[name] = fileNode('');
    return null;
  }

  write(path, content, { append = false } = {}) {
    const { parent, name } = this.locate(path);
    if (!parent) return `${path}: dossier parent introuvable`;
    const existing = parent.children[name];
    if (existing?.type === 'dir') return `${path}: c'est un dossier`;
    if (existing && !canWrite(existing)) return `${path}: permission refusée (il manque le droit w)`;
    if (append && existing) existing.content += content;
    else parent.children[name] = fileNode(content);
    return null;
  }

  read(path) {
    const node = this.get(path);
    if (!node) return { err: `cat: ${path}: aucun fichier de ce nom` };
    if (node.type === 'dir') return { err: `cat: ${path}: c'est un dossier` };
    if (!canRead(node)) return { err: `cat: ${path}: permission refusée (il manque le droit r)` };
    return { content: node.content };
  }

  rm(path, { recursive = false } = {}) {
    const { parent, name } = this.locate(path);
    const node = parent?.children[name];
    if (!node) return `rm: ${path}: aucun fichier ou dossier de ce nom`;
    if (node.type === 'dir' && !recursive) return `rm: ${path}: c'est un dossier (essaie -r)`;
    delete parent.children[name];
    return null;
  }

  copy(src, dest, { recursive = false } = {}) {
    const node = this.get(src);
    if (!node) return `cp: ${src}: aucun fichier ou dossier de ce nom`;
    if (node.type === 'dir' && !recursive) return `cp: ${src}: c'est un dossier (essaie -r)`;
    return this.#place(dest, src, clone(node));
  }

  move(src, dest) {
    const node = this.get(src);
    if (!node) return `mv: ${src}: aucun fichier ou dossier de ce nom`;
    const err = this.#place(dest, src, node);
    if (err) return err;
    const from = this.locate(src);
    delete from.parent.children[from.name];
    return null;
  }

  /** Dépose `node` sur `dest`. Si dest est un dossier existant, on garde le nom d'origine. */
  #place(dest, src, node) {
    const target = this.get(dest);
    if (target?.type === 'dir') {
      target.children[src.split('/').filter(Boolean).pop()] = node;
      return null;
    }
    const { parent, name } = this.locate(dest);
    if (!parent) return `${dest}: dossier parent introuvable`;
    parent.children[name] = node;
    return null;
  }

  /** Pose un lien symbolique : `nom` désignera `cible`. */
  link(target, name) {
    const { parent, name: leaf } = this.locate(name);
    if (!parent) return `ln: ${name}: dossier parent introuvable`;
    if (parent.children[leaf]) return `ln: ${name}: ce nom est déjà pris`;
    parent.children[leaf] = linkNode(target);
    return null;
  }

  /** chmod : soit un nombre en octal (644), soit du symbolique (+x, u-w, a+r). */
  chmod(path, spec) {
    const node = this.lget(path);
    if (!node) return `chmod: ${path}: aucun fichier ou dossier de ce nom`;

    if (/^[0-7]{3}$/.test(spec)) { node.mode = parseInt(spec, 8); return null; }

    const m = /^([ugoa]*)([+-])([rwx]+)$/.exec(spec);
    if (!m) return `chmod: « ${spec} » : attendu 644, ou +x, ou u-w`;
    const [, whoRaw, sign, letters] = m;
    const who = (whoRaw === '' || whoRaw === 'a') ? 'ugo' : whoRaw;
    const SHIFT = { u: 6, g: 3, o: 0 };
    const BIT = { r: 4, w: 2, x: 1 };

    let mask = 0;
    for (const w of who) for (const l of letters) mask |= BIT[l] << SHIFT[w];
    node.mode = sign === '+' ? (node.mode | mask) : (node.mode & ~mask);
    return null;
  }

  /** Replie un dossier ou un fichier dans une archive. */
  pack(source, dest) {
    const node = this.get(source);
    if (!node) return `tar: ${source}: aucun fichier ou dossier de ce nom`;
    const leaf = source.split('/').filter(Boolean).pop();
    const { parent, name } = this.locate(dest);
    if (!parent) return `tar: ${dest}: dossier parent introuvable`;
    parent.children[name] = archiveNode({ name: leaf, node: clone(node) });
    return null;
  }

  /** Déplie une archive dans le dossier courant. */
  unpack(source) {
    const node = this.get(source);
    if (!node) return `tar: ${source}: aucune archive de ce nom`;
    if (!node.archive) return `tar: ${source}: ce n'est pas une archive`;
    const here = this.#walk(this.cwd);
    here.children[node.archive.name] = clone(node.archive.node);
    return null;
  }

  /** Ce que contient une archive, sans la déplier. */
  listArchive(source) {
    const node = this.get(source);
    if (!node) return { err: `tar: ${source}: aucune archive de ce nom` };
    if (!node.archive) return { err: `tar: ${source}: ce n'est pas une archive` };
    const { name, node: root } = node.archive;
    const out = [];
    const walk = (n, prefix) => {
      out.push(n.type === 'dir' ? `${prefix}/` : prefix);
      if (n.type === 'dir') for (const [k, v] of Object.entries(n.children)) walk(v, `${prefix}/${k}`);
    };
    walk(root, name);
    return { entries: out };
  }

  /** Liste récursive de tous les chemins, pour les critères et `find`. */
  walk(node = this.root, prefix = '') {
    let out = [];
    for (const [name, child] of Object.entries(node.children)) {
      const p = prefix ? `${prefix}/${name}` : name;
      out.push({ path: p, type: child.type, node: child });
      if (child.type === 'dir') out = out.concat(this.walk(child, p));
    }
    return out;
  }
}

function clone(node) {
  if (node.type === 'link') return linkNode(node.target);
  if (node.type === 'file') {
    const f = fileNode(node.content);
    f.mode = node.mode;
    if (node.archive) f.archive = { name: node.archive.name, node: clone(node.archive.node) };
    return f;
  }
  const d = dirNode();
  d.mode = node.mode;
  for (const [k, v] of Object.entries(node.children)) d.children[k] = clone(v);
  return d;
}

/* world.js — le donjon : une grille, un héros, des entités. Aucun DOM ici.
   Le niveau donne une carte en ASCII :
     "map": ["#####",
             "#H.G#",
             "#####"]
   #  mur      .  sol       H  héros     G  faille (sortie)
   M  ombre    C  essence   K  clé       D  porte verrouillée
   S  dalle    B  boss (plusieurs points de vie)   X  piques (mortelles)
   P  dalle à poids (ne reste enfoncée que si quelqu'un se tient dessus)
   Q  ombre POSTÉE sur une dalle à poids — abats-la, relève-la, elle tient la dalle
      (une case ne porte qu'un glyphe : Q est le seul moyen d'empiler les deux)
   N  chasseur à protéger (une ombre à côté de lui, et il meurt)

   MATÉRIAUX — la règle : MAJUSCULE = entité, symbole = matériau.
   Bloquants   : %  pilier    ^  rocher     :  pierre sombre
   Traversables: =  ossements |  échelle
   Un matériau ne change QUE l'image de la case : il se DESSINE PAR-DESSUS le sol
   ou le mur normal (la plupart de ces tuiles sont des objets à fond transparent).
   Le moteur ne connaît que « bloquant » ou « traversable » : la collision, les
   conditions et les critères sont donc identiques à ceux d'un `#` ou d'un `.`.

   Les dalles s'activent en marchant dessus ; quand toutes le sont, les portes cèdent.

   apply() renvoie un événement que la vue anime. Le monde ne sait pas qu'il est affiché. */

const DIRS = {
  moveUp:    { dx: 0,  dy: -1, face: 'up' },
  moveDown:  { dx: 0,  dy: 1,  face: 'down' },
  moveLeft:  { dx: -1, dy: 0,  face: 'left' },
  moveRight: { dx: 1,  dy: 0,  face: 'right' }
};

/* Matériaux. Pour en ajouter un : une entrée ici, une règle `.cell.m-<nom>`
   dans algo.css, et il apparaît dans l'éditeur de niveaux (il lit ces tables). */
export const WALL_MATS = {
  '#': null,            // le mur standard : relief automatique (dessus / face)
  '%': 'pillar',
  '^': 'rock',
  ':': 'dark'
};
export const FLOOR_MATS = {
  '.': null,            // le sol standard : 4 variantes réparties par empreinte
  '=': 'bones',         // planks.png — ce sont en réalité des ossements
  '|': 'ladder'
};

/* Glyphes réservés aux entités : un matériau importé ne peut pas les voler,
   sinon un niveau existant perdrait son héros ou sa faille sans prévenir. */
export const ENTITY_GLYPHS = new Set(['H', 'G', 'M', 'B', 'C', 'K', 'D', 'S', 'X', 'P', 'N', 'Q']);

/** Identifiant CSS sûr pour un matériau importé (devient `.mat.m-<id>`). */
export const matId = (glyph, name) => {
  const slug = String(name || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || `g${glyph.charCodeAt(0)}`;
};

/**
 * Fusionne les matériaux importés (materials.json → `tiles`) avec ceux du moteur.
 * Chaque entrée : { src, blocks, name }. Renvoie les deux tables à passer à World.
 * Les glyphes invalides sont ignorés AVEC un avertissement — un niveau ne doit
 * jamais se rendre à moitié en silence.
 */
export function resolveMats(custom = {}) {
  const walls = { ...WALL_MATS }, floors = { ...FLOOR_MATS };
  for (const [glyph, def] of Object.entries(custom)) {
    if (typeof glyph !== 'string' || [...glyph].length !== 1) {
      console.warn(`[algo] matériau ignoré : « ${glyph} » n'est pas un seul caractère.`);
      continue;
    }
    if (ENTITY_GLYPHS.has(glyph)) {
      console.warn(`[algo] matériau ignoré : « ${glyph} » est réservé à une entité.`);
      continue;
    }
    if (glyph === '#' || glyph === '.') {
      console.warn(`[algo] matériau ignoré : « ${glyph} » est le mur ou le sol de base.`);
      continue;
    }
    const id = def.id || matId(glyph, def.name);
    if (def.blocks) { delete floors[glyph]; walls[glyph] = id; }
    else            { delete walls[glyph];  floors[glyph] = id; }
  }
  return { walls, floors };
}

/**
 * Choisit la tuile d'un mur d'après son VOISINAGE.
 *
 * Le tileset d'origine dessine une pièce complète : le mur du haut se voit par sa face
 * inférieure, les murs latéraux sont des bandes VERTICALES, le mur du bas par sa face
 * avant. N'utiliser qu'un « dessus » et une « face » pour tout plaquait des bandes
 * horizontales sur les côtés — c'est ce qui rendait les bords laids.
 *
 * ⚠ On nomme par le RÔLE du mur, pas par la position du sol : du sol à DROITE veut dire
 * que cette case est le mur GAUCHE de la pièce. L'inverse est la première erreur qu'on
 * fait ici, et elle donne un rendu en miroir difficile à diagnostiquer.
 *
 * Les côtés priment sur le haut et le bas : à la jonction d'un mur haut et d'un mur
 * latéral, c'est la bande verticale qui doit continuer, sinon l'horizontale déborde
 * et l'angle se casse.
 *
 * @param floorAt (dx,dy) => booléen — la case voisine est-elle traversable ?
 */
/**
 * Variante de sol pour une case. La dalle NUE domine largement ; le détail est rare.
 *
 * Une répartition uniforme sur quatre variantes marquées couvrait la carte de joints
 * et la faisait lire comme un mur de briques. Le tileset d'origine, lui, garde ses
 * pièces presque unies avec quelques marques éparses — c'est ce qu'on reproduit.
 * Déterministe : même carte, même rendu, donc captures et tests stables.
 */
export function floorVariant(x, y) {
  const h = ((x * 73856093 ^ y * 19349663) >>> 0) % 16;
  return h < 11 ? 0 : h < 13 ? 1 : h < 15 ? 2 : 3;   // 11/16 nue, puis 2, 2, 1
}

export function wallClass(floorAt) {
  const up = floorAt(0, -1), down = floorAt(0, 1);
  const left = floorAt(-1, 0), right = floorAt(1, 0);

  if (up && right) return 'w-sw';   // sol au-dessus ET à droite → angle bas-gauche
  if (up && left)  return 'w-se';   // angle bas-droit
  if (right) return 'w-w';          // sol à droite → mur GAUCHE
  if (left)  return 'w-e';          // sol à gauche → mur DROIT
  if (up)    return 'w-s';          // sol au-dessus → mur du BAS, on voit sa face
  if (down)  return 'w-n';          // sol en dessous → mur du HAUT
  return 'w-solid';                 // aucun sol autour : intérieur uni
}

export const COMMAND_DOC = {
  moveUp:    { desc: 'Monter d’une case',                    ex: 'moveUp()   ·   moveUp(3)' },
  moveDown:  { desc: 'Descendre d’une case',                 ex: 'moveDown()   ·   moveDown(2)' },
  moveLeft:  { desc: 'Aller à gauche',                       ex: 'moveLeft(4)' },
  moveRight: { desc: 'Aller à droite',                       ex: 'moveRight()   ·   moveRight(8)' },
  attack:    { desc: 'Frapper la case devant toi',           ex: 'attack()' },
  pickup:    { desc: 'Ramasser ce qu’il y a sous tes pieds',  ex: 'pickup()' },
  open:      { desc: 'Ouvrir la porte devant toi (avec une clé)', ex: 'open()' },
  wait:      { desc: 'Ne rien faire pendant un tour',        ex: 'wait()' },
  summon:    { desc: 'Relever l’ombre tombée devant toi — elle devient ton soldat',
               ex: 'attack()   puis   summon()' }
};

/* Les conditions utilisables dans if / while — expliquées dans l'aide. */
export const COND_DOC = {
  enemy: 'il y a une ombre juste devant toi',
  wall:  'il y a un mur juste devant toi',
  door:  'il y a une porte fermée juste devant toi',
  chest: 'il y a quelque chose à ramasser sous tes pieds',
  goal:  'tu es sur la faille',
  spikes: 'il y a des piques juste devant toi',
  clear: 'la case devant toi est libre (ni mur, ni ombre, ni porte)',
  corpse: 'une ombre est tombée devant toi : elle peut être relevée'
};

/* Compteurs du monde, lisibles dans une condition ou un argument — comme des
   variables que le jeu tient à jour pour toi : if (army > 2), moveRight(essences). */
export const WORLD_VALUES = {
  army:     'le nombre d’ombres que tu as relevées',
  kills:    'le nombre d’ombres que tu as abattues',
  essences: 'le nombre d’essences ramassées'
};

export class World {
  /** @param mats tables de matériaux (resolveMats). Par défaut : celles du moteur. */
  constructor(map = [], bossHp = 3, mats = null) {
    const { walls: WALLS, floors: FLOORS } = mats || { walls: WALL_MATS, floors: FLOOR_MATS };
    this.rows = map.length;
    this.cols = Math.max(0, ...map.map(r => r.length));
    this.tiles = [];              // 'wall' | 'floor'  — la seule chose qui compte au jeu
    this.mats = [];               // matériau de rendu, ou null  — jamais lu par la logique
    this.monsters = new Set();    // "x,y"
    this.chests = new Set();
    this.keys = new Set();
    this.doors = new Set();
    this.plates = new Set();      // dalles à activer
    this.weighted = new Set();    // dalles à POIDS : il faut rester dessus (ou y poster une ombre)
    this.spikes = new Set();      // piques : on ne marche pas dessus
    this.npc = null;              // le chasseur à protéger
    this.boss = null;             // { x, y, hp }
    this.goal = null;
    this.start = { x: 0, y: 0 };

    map.forEach((row, y) => {
      this.tiles[y] = [];
      this.mats[y] = [];
      for (let x = 0; x < this.cols; x++) {
        const ch = row[x] ?? '#';
        const blocking = ch in WALLS;
        this.tiles[y][x] = blocking ? 'wall' : 'floor';
        this.mats[y][x] = blocking ? WALLS[ch] : (FLOORS[ch] ?? null);
        const k = `${x},${y}`;
        if (ch === 'H') this.start = { x, y };
        if (ch === 'M') this.monsters.add(k);
        if (ch === 'C') this.chests.add(k);
        if (ch === 'K') this.keys.add(k);
        if (ch === 'D') this.doors.add(k);
        if (ch === 'S') this.plates.add(k);
        if (ch === 'P') this.weighted.add(k);
        if (ch === 'Q') { this.weighted.add(k); this.monsters.add(k); }
        if (ch === 'N') this.npc = { x, y };
        if (ch === 'X') this.spikes.add(k);
        if (ch === 'B') this.boss = { x, y };
        if (ch === 'G') this.goal = { x, y };
      }
    });

    this.totalWeighted = this.weighted.size;
    this.totalChests = this.chests.size;
    this.totalMonsters = this.monsters.size;
    this.totalPlates = this.plates.size;
    this.bossHp = bossHp;
    this.reset();
  }

  reset() {
    this.hero = { ...this.start, face: 'right' };
    this.alive = true;
    this.bag = { keys: 0, chests: 0 };
    this.killed = 0;
    this.corpses = new Set();     // ombres abattues, encore relevables
    this.allies = new Set();      // ombres relevées : elles ne bougent plus, elles occupent
    this.opened = new Set();
    this.live = {
      monsters: new Set(this.monsters),
      chests: new Set(this.chests),
      keys: new Set(this.keys),
      doors: new Set(this.doors),
      plates: new Set(this.plates)     // celles qui restent À activer
    };
    this.sealed = true;              // les portes ne s'ouvrent qu'une fois le sceau réuni
    this.hp = this.boss ? this.bossHp : 0;
    this.reached = false;
  }

  /** Compteur du monde lisible depuis le code du joueur. null = ce nom n'existe pas. */
  value(name) {
    switch (name) {
      case 'army':     return this.allies.size;
      case 'kills':    return this.killed;
      case 'essences': return this.bag.chests;
      default:         return null;
    }
  }

  /** Le chasseur est perdu si une ombre vivante le touche. */
  npcSafe() {
    if (!this.npc) return true;
    return ![[0, -1], [0, 1], [-1, 0], [1, 0]]
      .some(([dx, dy]) => this.live.monsters.has(this.key(this.npc.x + dx, this.npc.y + dy)));
  }

  /** Une dalle à poids n'est tenue que si le héros ou une ombre s'y trouve. */
  #heldAll() {
    return [...this.weighted].every(k =>
      k === this.key(this.hero.x, this.hero.y) || this.allies.has(k));
  }

  /** Sceau réuni (dalles enfoncées ET dalles à poids tenues) → les portes cèdent. */
  #checkSeal() {
    if (!this.sealed) return [];
    if (this.live.plates.size || !this.#heldAll()) return [];
    if (!this.plates.size && !this.weighted.size) return [];
    const opened = [...this.live.doors];
    opened.forEach(d => this.live.doors.delete(d));
    this.opened = new Set([...this.opened, ...opened]);
    this.sealed = false;
    return opened;
  }

  key(x, y) { return `${x},${y}`; }
  isWall(x, y) { return x < 0 || y < 0 || x >= this.cols || y >= this.rows || this.tiles[y][x] === 'wall'; }

  /** La case devant le héros, selon son orientation. */
  ahead() {
    const d = Object.values(DIRS).find(d => d.face === this.hero.face);
    return { x: this.hero.x + d.dx, y: this.hero.y + d.dy };
  }

  /** Conditions utilisables dans if / while. */
  test(cond) {
    const { x, y } = this.ahead();
    const here = this.key(this.hero.x, this.hero.y);
    switch (cond) {
      case 'enemy':  return this.live.monsters.has(this.key(x, y));
      case 'corpse': return this.corpses.has(this.key(x, y));
      case 'ally':   return this.allies.has(this.key(x, y));
      case 'wall':   return this.isWall(x, y);
      case 'door':   return this.live.doors.has(this.key(x, y));
      case 'chest':  return this.live.chests.has(here) || this.live.keys.has(here);
      case 'goal':   return !!this.goal && this.goal.x === this.hero.x && this.goal.y === this.hero.y;
      case 'boss':   return !!this.boss && this.hp > 0 && this.boss.x === x && this.boss.y === y;
      case 'spikes': return this.spikes.has(this.key(x, y));
      case 'clear':  return !this.isWall(x, y)
                          && !this.spikes.has(this.key(x, y))
                          && !this.live.monsters.has(this.key(x, y))
                          && !this.allies.has(this.key(x, y))
                          && !(this.npc && this.npc.x === x && this.npc.y === y)
                          && !this.live.doors.has(this.key(x, y))
                          && !(this.boss && this.hp > 0 && this.boss.x === x && this.boss.y === y);
      default:       return false;
    }
  }

  /** Exécute UNE instruction. Renvoie { type, ...détails } — jamais d'exception. */
  apply(name) {
    if (!this.alive) return { type: 'dead' };

    if (DIRS[name]) {
      const d = DIRS[name];
      this.hero.face = d.face;
      const nx = this.hero.x + d.dx, ny = this.hero.y + d.dy;
      const k = this.key(nx, ny);

      if (this.isWall(nx, ny))        return { type: 'blocked', reason: 'Tu fonces dans un mur.' };
      if (this.live.doors.has(k))     return { type: 'blocked', reason: 'Cette porte est verrouillée. Ouvre-la d’abord.' };
      if (this.live.monsters.has(k)) {
        this.alive = false;
        return { type: 'died', reason: 'Tu marches droit sur une ombre. Frappe-la avant d’avancer.' };
      }
      if (this.boss && this.hp > 0 && this.boss.x === nx && this.boss.y === ny) {
        this.alive = false;
        return { type: 'died', reason: 'Tu marches sur le Monarque. Il fallait l’abattre d’abord.' };
      }
      if (this.allies.has(k))         return { type: 'blocked', reason: 'Ton ombre tient cette case. Passe ailleurs.' };
      if (this.npc && this.npc.x === nx && this.npc.y === ny)
        return { type: 'blocked', reason: 'Le chasseur est là. Ne lui marche pas dessus.' };
      if (this.spikes.has(k)) {
        this.alive = false;
        return { type: 'died', reason: 'Des piques. Il fallait passer ailleurs.' };
      }

      this.hero.x = nx; this.hero.y = ny;
      const wasPlate = this.live.plates.delete(k);
      const opened = this.#checkSeal();
      if (this.goal && nx === this.goal.x && ny === this.goal.y) this.reached = true;
      if (wasPlate || this.weighted.has(k) || opened.length) {
        return { type: 'plate', x: nx, y: ny, face: d.face,
                 left: this.live.plates.size, weighted: this.weighted.has(k), opened };
      }
      return { type: 'move', x: nx, y: ny, face: d.face };
    }

    if (name === 'attack') {
      const { x, y } = this.ahead();
      const k = this.key(x, y);
      if (this.boss && this.hp > 0 && this.boss.x === x && this.boss.y === y) {
        this.hp--;
        return { type: 'attack', hit: true, boss: true, dead: this.hp === 0, hp: this.hp, x, y };
      }
      if (this.live.monsters.has(k)) {
        this.live.monsters.delete(k);
        this.corpses.add(k);          // elle reste au sol : relevable tant qu'on ne l'a pas fait
        this.killed++;
        return { type: 'attack', hit: true, x, y, corpse: true };
      }
      return { type: 'attack', hit: false, x, y };
    }

    if (name === 'pickup') {
      const k = this.key(this.hero.x, this.hero.y);
      if (this.live.chests.has(k)) { this.live.chests.delete(k); this.bag.chests++; return { type: 'pickup', what: 'chest', ...this.hero }; }
      if (this.live.keys.has(k))   { this.live.keys.delete(k);   this.bag.keys++;   return { type: 'pickup', what: 'key', ...this.hero }; }
      return { type: 'pickup', what: null, reason: 'Il n’y a rien à ramasser ici.' };
    }

    if (name === 'open') {
      const { x, y } = this.ahead();
      const k = this.key(x, y);
      if (!this.live.doors.has(k)) return { type: 'open', ok: false, reason: 'Aucune porte devant toi.' };
      if (this.bag.keys < 1)       return { type: 'open', ok: false, reason: 'Il te faut une clé.' };
      this.bag.keys--;
      this.live.doors.delete(k);
      this.opened.add(k);
      return { type: 'open', ok: true, x, y };
    }

    if (name === 'summon') {
      const { x, y } = this.ahead();
      const k = this.key(x, y);
      if (!this.corpses.has(k)) {
        return { type: 'summon', ok: false,
                 reason: 'Il n’y a aucune ombre tombée devant toi. Abats-la d’abord.' };
      }
      this.corpses.delete(k);
      this.allies.add(k);
      const opened = this.#checkSeal();   // une ombre postée sur une dalle la tient
      return { type: 'summon', ok: true, x, y, army: this.allies.size, opened };
    }

    if (name === 'wait') return { type: 'wait' };

    return { type: 'unknown', name };
  }
}

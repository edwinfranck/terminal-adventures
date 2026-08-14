/* plugins/algo/index.js — PLUGIN « ALGO ».
   Gameplay : le joueur n'a AUCUN contrôle direct. Il écrit un programme, puis regarde
   son héros l'exécuter instruction par instruction. On apprend la logique, pas une syntaxe.

   Le niveau décrit son monde ainsi :
     "world": {
       "map":      ["#####", "#H.G#", "#####"],
       "commands": ["moveRight","moveLeft"],   // instructions autorisées
       "new":      ["moveRight"],
       "starter":  "// une ligne = un ordre\n"
     } */

import { el, loadCSS, t, bus } from '../../engine/core.js';
import { World, COMMAND_DOC, COND_DOC, WORLD_VALUES, resolveMats, matId, wallClass, floorVariant } from './world.js';
import { parse, execute, SyntaxIssue } from './parser.js';
import { attach } from './editor.js';

loadCSS('plugins/algo/algo.css');

const SPEEDS = [1, 2, 4];
const BASE_DELAY = 420;          // ms par instruction en x1

/* ------------------------------------------------------- matériaux importés
   Un univers peut fournir `materials.json` :

     { "tiles":  { "~": { "src": "assets/…/eau.png", "blocks": false, "name": "Eau" } },
       "actors": { "hero": { "src": "assets/rpg/perso/pj_0.png",
                             "frameW": 32, "frameH": 48, "cols": 4,
                             "dirRows": { "down": 0, "left": 1, "right": 2, "up": 3 } } } }

   Le CSS correspondant est injecté à l'exécution : aucun fichier à éditer pour
   ajouter une tuile ou changer l'apparence d'un personnage. `src` accepte un
   chemin (version servie) ou un data-URI (build standalone : build.py convertit). */
const MAT_STYLE_ID = 'algo-materials';

function injectMaterialCSS(mats = {}) {
  const rules = [];

  for (const [glyph, def] of Object.entries(mats.tiles || {})) {
    if (!def?.src) continue;
    const id = def.id || matId(glyph, def.name);
    rules.push(`.mat.m-${id}{background-image:url("${def.src}")}`);
  }

  /* Un acteur est une feuille : 4 colonnes de marche × une ligne par direction.
     On l'affiche en agrandissant le fond à (cols × tile) par (rows × tile), puis
     la LIGNE choisit la direction et l'animation fait défiler les colonnes. */
  for (const [role, a] of Object.entries(mats.actors || {})) {
    if (!a?.src || !a.frameW || !a.frameH) continue;
    const cols = a.cols || 4;
    const rows = a.rows || Object.keys(a.dirRows || { down: 0 }).length || 1;
    const sel = { hero: '.hero', monster: '.monster', boss: '.boss' }[role];
    if (!sel) continue;

    /* Une frame de 32×48 ne rentre pas dans une case carrée : l'écraser déforme le
       personnage. On garde donc la largeur d'une case et on laisse le sprite
       DÉPASSER vers le haut, pieds ancrés en bas de la case — la convention de tous
       les RPG vus de dessus. `translate` porte la position, donc le décalage passe
       par une marge négative pour ne pas entrer en conflit avec elle. */
    const ratio = a.frameH / a.frameW;
    rules.push(
      `${sel}{background-image:url("${a.src}");` +
      `height:calc(var(--tile) * ${ratio});` +
      `margin-top:calc(var(--tile) * ${(1 - ratio).toFixed(4)});` +
      `background-size:calc(var(--tile) * ${cols}) calc(var(--tile) * ${(rows * ratio).toFixed(4)});` +
      `animation:actor-${role} 700ms steps(${cols}) infinite}`,
      `@keyframes actor-${role}{to{background-position-x:calc(var(--tile) * -${cols})}}`
    );
    for (const [dir, row] of Object.entries(a.dirRows || {})) {
      const off = (row * ratio).toFixed(4);
      rules.push(`${sel}[data-face="${dir}"]{background-position-y:calc(var(--tile) * -${off})}`);
    }
    // une feuille orientée rend le miroir horizontal nuisible : la ligne « left » existe
    if (a.dirRows?.left !== undefined) rules.push(`${sel}{scale:1 1 !important}`);
  }

  /* Apparences : elles REMPLACENT l'image d'un élément existant, sans nouveau glyphe.
     Le sol a quatre variantes — on les remplace toutes, sinon trois cases sur quatre
     garderaient l'ancienne image. */
  const SKIN_SEL = {
    floor: '.cell.floor.v0,.cell.floor.v1,.cell.floor.v2,.cell.floor.v3',
    wall:  '.cell.wall.w-n,.cell.wall.w-s,.cell.wall.w-w,.cell.wall.w-e,' +
           '.cell.wall.w-sw,.cell.wall.w-se,.cell.wall.w-solid',
    goal: '.goal', chest: '.chest', key: '.key',
    door: '.door', plate: '.plate', spikes: '.spikes'
  };
  for (const [target, k] of Object.entries(mats.skins || {})) {
    const sel = SKIN_SEL[target];
    if (sel && k?.src) rules.push(`${sel}{background-image:url("${k.src}")!important}`);
  }

  let tag = document.getElementById(MAT_STYLE_ID);
  if (!rules.length) { tag?.remove(); return false; }
  if (!tag) { tag = el('style', { id: MAT_STYLE_ID }); document.head.append(tag); }
  tag.textContent = rules.join('\n');
  return true;
}

export default {
  id: 'algo',
  label: 'Programmation',

  create(host, api) {
    /* ---------------- vue ---------------- */
    const board   = el('div', { class: 'algo-board' });
    const stage   = el('div', { class: 'algo-stage' }, board);

    const btnRun  = el('button', { class: 'algo-btn algo-btn-run' }, '▶ Exécuter');
    const btnStep = el('button', { class: 'algo-btn' }, '⏭ Pas à pas');
    const btnReset= el('button', { class: 'algo-btn' }, '↺ Reset');
    const speedBox= el('div', { class: 'algo-speeds' },
      ...SPEEDS.map(s => el('button', { class: 'algo-speed', 'data-s': s }, `x${s}`)));
    const bar     = el('div', { class: 'algo-bar' }, btnRun, btnStep, btnReset, el('span', { class: 'algo-spacer' }), speedBox);

    const gutter  = el('div', { class: 'algo-gutter' });
    const code    = el('textarea', { class: 'algo-code', spellcheck: 'false', autocomplete: 'off' });
    const wrap    = el('div', { class: 'algo-codewrap' }, code);   // ancre de l'autocomplétion
    const editor  = el('div', { class: 'algo-editor' }, gutter, wrap);

    const log     = el('div', { class: 'algo-log' });
    const side    = el('div', { class: 'algo-side' }, bar, editor, log);

    host.append(el('div', { class: 'algo' }, stage, side));

    /* ---------------- état ---------------- */
    let world = new World([]);
    let heroSheetHasDirs = false;   // vrai si l'univers fournit une feuille 4 directions
    let allowed = new Set();
    let sprites = new Map();     // "x,y" -> élément DOM
    let hero = null, bubble = null;
    let gen = null, timer = null, speed = 1;
    let failed = false, ranOnce = false, opCount = 0;

    /* ---------------- rendu ----------------
       ⚠ `place` doit vivre ICI, pas dans draw() : une ombre relevée ou un corps
       apparaissent PENDANT l'exécution. Enfermée dans draw(), elle levait un
       ReferenceError silencieux — le monde changeait, l'écran mentait. */
    function place(k, kind) {
      const [x, y] = k.split(',').map(Number);
      const T = tile();
      // position via la propriété `translate`, PAS `transform` : ainsi `rotate` et
      // `scale` (mort, coup) se composent autour du sprite au lieu de l'éjecter.
      const s = el('div', { class: `sprite ${kind}` });
      s.style.translate = `${x * T}px ${y * T}px`;
      board.append(s);
      sprites.set(`${kind}:${k}`, s);
      return s;
    }

    function tile() {
      const w = stage.clientWidth  - 32;
      const h = stage.clientHeight - 32;
      return Math.max(22, Math.min(64, Math.floor(Math.min(w / world.cols, h / world.rows))));
    }

    function draw() {
      board.innerHTML = '';
      sprites = new Map();
      const T = tile();
      board.style.setProperty('--tile', `${T}px`);
      board.style.setProperty('--cols', world.cols);
      board.style.setProperty('--rows', world.rows);

      // Un donjon, pas un damier : sol varié, murs avec une vraie face avant,
      // et du décor accroché aux murs visibles. Tout est déterministe (même carte,
      // même rendu) — le hasard rendrait les captures et les tests instables.
      const hash = (x, y) => (x * 73856093 ^ y * 19349663) >>> 0;
      const isWall = (x, y) => x < 0 || y < 0 || x >= world.cols || y >= world.rows
                            || world.tiles[y][x] === 'wall';
      const DECOR = ['torch', 'banner', 'shield', 'skull', 'shelf', 'torch', 'crate', 'barrel'];

      for (let y = 0; y < world.rows; y++) {
        for (let x = 0; x < world.cols; x++) {
          // un matériau (pilier, échelle…) se pose PAR-DESSUS la case : ces tuiles
          // sont des objets à fond transparent, elles ne peuvent pas servir de fond.
          const mat = world.mats?.[y]?.[x];
          /* Bords exposés : sans ça, une nappe de matériau (l'eau, la pierre sombre)
             se rend en rectangle à bord franc et se lit comme un autocollant. On
             marque les côtés où le matériau NE continue PAS, et le CSS y creuse une
             ombre — l'effet d'une berge, sans dessiner 16 tuiles de bordure. */
          const same = (dx, dy) => world.mats?.[y + dy]?.[x + dx] === mat;
          const matEl = () => {
            const edges = [!same(0, -1) && 'e-t', !same(1, 0) && 'e-r',
                           !same(0, 1) && 'e-b', !same(-1, 0) && 'e-l'].filter(Boolean);
            return el('i', { class: `mat m-${mat} ${edges.join(' ')}` });
          };

          if (world.tiles[y][x] === 'floor') {
            const cell = el('div', { class: `cell floor v${floorVariant(x, y)}` });
            if (mat) cell.append(matEl());
            board.append(cell);
            continue;
          }
          // la tuile du mur dépend de son voisinage : mur du haut, du bas, ou bande
          // verticale sur les côtés — voir wallClass() dans world.js
          const wc = wallClass((dx, dy) => !isWall(x + dx, y + dy));
          const cell = el('div', { class: `cell wall ${wc}` });
          if (mat) cell.append(matEl());
          // le décor s'accroche aux murs qu'on voit de face, jamais sur un matériau
          else if (wc === 'w-n' && hash(x, y) % 3 === 0) {
            cell.append(el('i', { class: `decor ${DECOR[hash(x, y) % DECOR.length]}` }));
          }
          board.append(cell);
        }
      }

      world.live.monsters.forEach(k => place(k, 'monster'));
      world.live.chests.forEach(k   => place(k, 'chest'));
      world.live.keys.forEach(k     => place(k, 'key'));
      world.live.doors.forEach(k    => place(k, 'door'));
      world.live.plates.forEach(k   => place(k, 'plate'));
      world.weighted.forEach(k      => place(k, 'weight'));
      world.corpses.forEach(k       => place(k, 'corpse'));
      world.allies.forEach(k        => place(k, 'ally'));
      world.spikes.forEach(k        => place(k, 'spikes'));
      if (world.npc) place(`${world.npc.x},${world.npc.y}`, 'npc');
      if (world.goal) place(`${world.goal.x},${world.goal.y}`, 'goal');
      if (world.boss && world.hp > 0) {
        const b = place(`${world.boss.x},${world.boss.y}`, 'boss');
        paintHp(b);
      }

      hero = el('div', { class: 'sprite hero' });
      bubble = el('div', { class: 'say' });
      hero.append(bubble);
      board.append(hero);
      moveHero();
    }

    /** Les points de vie du boss, en barres au-dessus de lui : on voit qu'on progresse. */
    function paintHp(node) {
      const host = node || sprites.get(`boss:${world.boss?.x},${world.boss?.y}`);
      if (!host) return;
      host.innerHTML = '';
      const bar = el('div', { class: 'hp' });
      for (let i = 0; i < world.bossHp; i++) bar.append(el('i', { class: i < world.hp ? 'on' : null }));
      host.append(bar);
    }

    function moveHero() {
      const T = tile();
      hero.style.translate = `${world.hero.x * T}px ${world.hero.y * T}px`;
      // `data-face` sert aux feuilles 4 directions (une ligne par orientation).
      hero.dataset.face = world.hero.face || 'down';
      // Sans feuille orientée, on garde le miroir : c'est le seul moyen de
      // « regarder à gauche » avec un sprite qui n'a qu'une vue.
      hero.style.scale = (heroSheetHasDirs || world.hero.face !== 'left') ? '1 1' : '-1 1';
    }

    /** Le fil du parcours : une pastille sur chaque case foulée. On VOIT le trajet. */
    function trail(x, y) {
      const T = tile();
      const dot = el('div', { class: 'trail' });
      dot.style.translate = `${x * T}px ${y * T}px`;
      board.insertBefore(dot, board.querySelector('.sprite') || null);
    }

    /** L'instruction en cours, affichée au-dessus du héros — comme on la lit dans le code. */
    /** @param raw true = le texte est déjà écrit (une affectation, pas un appel) */
    function announce(name, raw = false) {
      if (!bubble) return;
      bubble.textContent = raw ? name : `${name}()`;
      bubble.classList.remove('on');
      void bubble.offsetWidth;
      bubble.classList.add('on');
    }

    function pop(kind, x, y) {
      const s = sprites.get(`${kind}:${x},${y}`);
      if (!s) return;
      s.classList.add('gone');
      setTimeout(() => s.remove(), 260);
    }

    function say(text, cls) {
      log.append(el('div', { class: cls ? `algo-l ${cls}` : 'algo-l' }, text));
      log.scrollTop = log.scrollHeight;
    }

    /* ---------------- gutter (numéros de ligne + surbrillance) ---------------- */
    function paintGutter(active = -1) {
      const n = code.value.split('\n').length;
      gutter.innerHTML = '';
      for (let i = 1; i <= n; i++) {
        gutter.append(el('div', { class: i === active ? 'gl on' : 'gl' }, String(i)));
      }
      gutter.scrollTop = code.scrollTop;
    }
    code.addEventListener('input', () => paintGutter());
    // On tape son programme soi-même : recopier une solution n'apprend rien.
    code.addEventListener('paste', e => { e.preventDefault(); say('Écris-le toi-même — c’est comme ça que ça rentre.', 'warn'); });
    code.addEventListener('drop', e => e.preventDefault());
    code.addEventListener('scroll', () => { gutter.scrollTop = code.scrollTop; });

    /* ---------------- autocomplétion ----------------
       On ne propose que ce que le joueur a le droit d'écrire à ce niveau. */
    const SNIPPETS = {
      repeat: { label: 'repeat', desc: 'répéter n fois', insert: 'repeat () {\n  \n}', caret: 8 },
      if:     { label: 'if',     desc: 'si la condition est vraie', insert: 'if () {\n  \n}', caret: 4 },
      while:  { label: 'while',  desc: 'tant que la condition est vraie', insert: 'while () {\n  \n}', caret: 7 },
      function: { label: 'function', desc: 'donner un nom à une suite d’ordres',
                  insert: 'function nom() {\n  \n}', caret: 9 },
      var:    { label: 'var', desc: 'retenir un nombre', insert: 'var nom = 0', caret: 4 }
    };
    let keywords = [];

    function candidates() {
      const list = [...allowed].map(c => ({
        label: c, desc: COMMAND_DOC[c]?.desc, insert: `${c}()`, caret: c.length + 1
      }));
      keywords.forEach(k => SNIPPETS[k] && list.push(SNIPPETS[k]));
      if (keywords.includes('if') || keywords.includes('while')) {
        Object.entries(COND_DOC).forEach(([k, v]) =>
          list.push({ label: k, desc: v, insert: k, caret: k.length }));
      }
      // les compteurs du jeu se complètent dès que le niveau parle de variables
      if (keywords.includes('var')) {
        Object.entries(WORLD_VALUES).forEach(([k, v]) =>
          list.push({ label: k, desc: v, insert: k, caret: k.length }));
      }
      return list;
    }

    const editorApi = attach(code, { candidates });

    /* ---------------- exécution ---------------- */
    function stop() { clearInterval(timer); timer = null; btnRun.textContent = '▶ Exécuter'; }

    function reset() {
      stop();
      gen = null; failed = false; opCount = 0;
      world.reset();
      draw();
      log.innerHTML = '';
      paintGutter();
      api.changed();
    }

    function compile() {
      try {
        const program = parse(code.value, allowed);
        if (!program.length) { say('Ton programme est vide. Écris au moins une instruction.', 'warn'); return null; }
        return execute(program, world);
      } catch (e) {
        if (e instanceof SyntaxIssue) { say(`Ligne ${e.line} — ${e.message}`, 'err'); paintGutter(e.line); }
        else say(e.message, 'err');
        return null;
      }
    }

    /** Un tick = une instruction. Renvoie false quand c'est fini. */
    function tick() {
      let step;
      try {
        step = gen.next();
      } catch (e) {
        say(e.message, 'err'); failed = true; stop(); return false;
      }
      if (step.done) {
        stop();
        if (!failed) say(world.reached ? 'Programme terminé.' : 'Programme terminé — mais la faille n’est pas atteinte.',
                         world.reached ? 'ok' : 'warn');
        return false;
      }

      // Une variable qui change EST un pas du programme : on l'annonce comme une
      // instruction, sinon elle bouge en secret et personne ne comprend son rôle.
      if (step.value.kind === 'set') {
        paintGutter(step.value.line);
        announce(step.value.label, true);
        say(step.value.label, 'ok');
        api.changed();
        return true;
      }

      const { name, line } = step.value;
      paintGutter(line);
      announce(name);
      const from = { x: world.hero.x, y: world.hero.y };
      const ev = world.apply(name);
      if (ev.type === 'move' || ev.type === 'plate') trail(from.x, from.y);
      opCount++;

      switch (ev.type) {
        case 'move':
          moveHero();
          break;
        case 'plate':
          moveHero();
          pop('plate', ev.x, ev.y);
          if (ev.opened.length) {
            ev.opened.forEach(k => pop('door', ...k.split(',').map(Number)));
            say('Toutes les dalles sont enfoncées : la porte cède.', 'ok');
          } else if (ev.weighted) {
            say('Tu tiens la dalle. Elle se relèvera dès que tu partiras.', 'warn');
          } else {
            say(`Dalle enfoncée. Il en reste ${ev.left}.`, 'ok');
          }
          break;
        case 'blocked':
          moveHero(); say(`Ligne ${line} — ${ev.reason}`, 'err'); bus.emit('player:error', ev.reason); failed = true; stop(); return false;
        case 'died':
          moveHero(); hero.classList.add('dead');
          say(`Ligne ${line} — ${ev.reason}`, 'err'); bus.emit('player:error', ev.reason); failed = true; stop(); return false;
        case 'attack':
          hero.classList.add('striking');
          setTimeout(() => hero.classList.remove('striking'), 220);
          if (ev.boss) {
            paintHp();
            if (ev.dead) { pop('boss', ev.x, ev.y); say('Le Monarque tombe.', 'ok'); }
            else say(`Le Monarque encaisse. Il lui reste ${ev.hp} point${ev.hp > 1 ? 's' : ''} de vie.`, 'warn');
          }
          else if (ev.hit) {
            pop('monster', ev.x, ev.y);
            // le corps reste au sol : c'est ce qui rend summon() possible
            if (ev.corpse) place(`${ev.x},${ev.y}`, 'corpse');
          }
          else say(`Ligne ${line} — tu frappes dans le vide.`, 'warn');
          break;
        case 'pickup':
          if (ev.what) pop(ev.what, world.hero.x, world.hero.y);
          else say(`Ligne ${line} — ${ev.reason}`, 'warn');
          break;
        case 'open':
          if (ev.ok) pop('door', ev.x, ev.y);
          else say(`Ligne ${line} — ${ev.reason}`, 'warn');
          break;
        case 'summon':
          if (!ev.ok) { say(`Ligne ${line} — ${ev.reason}`, 'warn'); break; }
          pop('corpse', ev.x, ev.y);
          place(`${ev.x},${ev.y}`, 'ally');
          say(`Ombre relevée. Ton armée compte ${ev.army} soldat${ev.army > 1 ? 's' : ''}.`, 'ok');
          if (ev.opened?.length) {
            ev.opened.forEach(k => pop('door', ...k.split(',').map(Number)));
            say('Le sceau est réuni : la porte cède.', 'ok');
          }
          break;
      }

      api.changed();       // critères ré-évalués en direct
      return true;
    }

    function start() {
      if (timer) { stop(); return; }               // pause
      bus.emit('player:action');
      if (!gen) { reset(); gen = compile(); if (!gen) return; ranOnce = true; }
      btnRun.textContent = '⏸ Pause';
      timer = setInterval(() => { if (!tick()) stop(); }, BASE_DELAY / speed);
    }

    function stepOnce() {
      stop();
      bus.emit('player:action');
      if (!gen) { reset(); gen = compile(); if (!gen) return; ranOnce = true; }
      tick();
    }

    btnRun.onclick   = start;
    btnStep.onclick  = stepOnce;
    btnReset.onclick = reset;
    speedBox.onclick = e => {
      const b = e.target.closest('.algo-speed'); if (!b) return;
      speed = +b.dataset.s;
      [...speedBox.children].forEach(c => c.classList.toggle('on', c === b));
      if (timer) { stop(); btnRun.textContent = '⏸ Pause'; timer = setInterval(() => { if (!tick()) stop(); }, BASE_DELAY / speed); }
    };

    const onResize = () => { if (world.rows) { draw(); } };
    window.addEventListener('resize', onResize);

    /* ---------------- contrat de plugin ---------------- */
    return {
      load(w) {
        // matériaux importés d'abord : World en a besoin pour savoir ce qui bloque
        const mats = w.materials || {};
        injectMaterialCSS(mats);
        heroSheetHasDirs = mats.actors?.hero?.dirRows?.left !== undefined;
        world = new World(w.map || [], w.bossHp || 3, resolveMats(mats.tiles));
        allowed = new Set(w.commands || []);
        // le mot-clé d'une entrée « syntaxe » = ce que l'autocomplétion a le droit de proposer
        keywords = (w.syntax || []).map(s => t(s.cmd).trim().split(/[\s(]/)[0]);
        code.value = t(w.starter, '');
        speed = 1;
        [...speedBox.children].forEach((c, i) => c.classList.toggle('on', i === 0));
        ranOnce = false;
        reset();
        setTimeout(() => { draw(); code.focus(); }, 60);   // taille correcte après layout
      },

      reset,

      test(check, args) {
        const [a] = args;
        switch (check) {
          case 'reachedGoal':  return world.reached && !failed;
          case 'allChests':    return world.totalChests > 0 && world.live.chests.size === 0;
          case 'allMonsters':  return world.totalMonsters > 0 && world.live.monsters.size === 0;
          case 'allPlates':    return world.totalPlates > 0 && world.live.plates.size === 0;
          case 'bossDown':     return !!world.boss && world.hp === 0;
          case 'armyIs':       return world.allies.size >= Number(a);
          case 'npcSafe':      return ranOnce && !!world.npc && world.npcSafe();
          case 'usedVar':      return /\bvar\s+[A-Za-z_]/.test(code.value.replace(/\/\/.*/g, ''));
          case 'survived':     return ranOnce && world.alive && !failed;
          case 'maxOps':       return ranOnce && !failed && opCount <= Number(a);
          case 'maxLines':     return code.value.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length <= Number(a);
          case 'usedKeyword':  return new RegExp(`\\b${a}\\b`).test(code.value.replace(/\/\/.*/g, ''));
          default:
            console.warn(`[algo] critère inconnu : ${check}`);
            return false;
        }
      },

      arsenal(level) {
        const fresh = new Set(level.world?.new || []);
        const list = (level.world?.commands || []).map(c => ({
          cmd: `${c}()`, desc: COMMAND_DOC[c]?.desc || '', fresh: fresh.has(c)
        }));
        // `fresh` est posé par le moteur : seules les formes du niveau en cours sont neuves
        (level.world?.syntax || []).forEach(s => list.push({ cmd: t(s.cmd), desc: t(s.desc), fresh: s.fresh !== false }));
        return list;
      },

      /* Contenu de l'écran d'aide. C'est ici qu'on enseigne la grammaire du langage. */
      help() {
        return [
          {
            title: 'Comment on joue',
            text:
              'Tu ne déplaces <b>jamais</b> ton chasseur au clavier. Tu <b>écris un programme</b>, ' +
              'tu appuies sur <b>Exécuter</b>, et il obéit — une instruction après l’autre.\n' +
              'La ligne en cours d’exécution s’allume dans la marge : tu vois exactement où il en est.\n' +
              '<b>Pas à pas</b> avance d’une seule instruction. <b>x1 / x2 / x4</b> change la vitesse. ' +
              '<b>Reset</b> remet le donjon à zéro.\n' +
              'Un programme faux n’est pas grave : tu le vois échouer, tu comprends pourquoi, tu corriges. ' +
              'C’est exactement le métier.'
          },
          {
            title: 'Les instructions disponibles ici',
            commands: [...allowed].filter(c => COMMAND_DOC[c]).map(c => ({
              cmd: `${c}()`, desc: COMMAND_DOC[c].desc, ex: COMMAND_DOC[c].ex
            }))
          },
          {
            title: 'Un nombre entre les parenthèses = répéter le déplacement',
            text:
              '<code>moveRight()</code> avance d’une case. <code>moveRight(8)</code> avance de huit cases — ' +
              'et tu vois bien les huit pas se faire un par un.'
          },
          {
            title: 'Répéter, tester, boucler',
            commands: [
              { cmd: 'repeat (n) { … }', desc: 'répète n fois ce qui est entre les accolades', ex: 'repeat (4) {\n  moveRight()\n}' },
              { cmd: 'if (cond) { … }',  desc: 'ne fait ce bloc que si la condition est vraie', ex: 'if (enemy) {\n  attack()\n}' },
              { cmd: 'if … else { … }',  desc: 'sinon, fait cet autre bloc',                    ex: 'if (enemy) { attack() } else { moveRight() }' },
              { cmd: 'while (cond) { … }', desc: 'recommence tant que la condition reste vraie', ex: 'while (clear) {\n  moveRight()\n}' }
            ]
          },
          {
            title: 'Donner un nom à une suite d’ordres',
            text: 'Quand la même série revient trois fois, ne l’écris pas trois fois : nomme-la.\n'
                + 'Tu la définis une fois, tu l’appelles autant que tu veux — et si tu la corriges, '
                + 'elle est corrigée partout.',
            commands: [
              { cmd: 'function nom() { … }', desc: 'définit la suite d’ordres',
                ex: 'function nettoyer() {\n  attack()\n  moveRight()\n}' },
              { cmd: 'nom()', desc: 'l’exécute', ex: 'nettoyer()   ·   repeat (3) { nettoyer() }' }
            ]
          },
          {
            title: 'Retenir un nombre : les variables',
            text:
              'Une variable, c’est une <b>case de mémoire avec un nom</b>. Tu y ranges un nombre, ' +
              'tu le relis, tu le modifies. C’est ce qui permet de <b>compter</b> — et de se servir ' +
              'ensuite de ce qu’on a compté.\n' +
              'À chaque fois qu’elle change, tu la vois s’afficher au-dessus de ton chasseur.',
            commands: [
              { cmd: 'var pas = 0', desc: 'crée la variable et lui donne sa valeur de départ',
                ex: 'var pas = 0' },
              { cmd: 'pas = pas + 1', desc: 'la modifie : ici, un de plus qu’avant',
                ex: 'while (clear) {\n  moveRight()\n  pas = pas + 1\n}' },
              { cmd: 'moveLeft(pas)', desc: 'sert d’argument : refais autant de pas que compté',
                ex: 'moveLeft(pas)' },
              { cmd: 'if (pas > 3) { … }', desc: 'sert de condition : compare avec < > <= >= == !=',
                ex: 'if (pas > 3) { attack() }' }
            ]
          },
          {
            title: 'Des compteurs que le jeu tient pour toi',
            text: 'Ceux-là existent sans que tu les crées : lis-les comme des variables.',
            commands: Object.entries(WORLD_VALUES).map(([k, v]) => ({ cmd: k, desc: v }))
          },
          {
            title: 'Les conditions',
            commands: Object.entries(COND_DOC).map(([k, v]) => ({ cmd: k, desc: v }))
          },
          {
            title: 'Ce que tu vois sur le plateau',
            commands: [
              { cmd: 'ton chasseur', desc: 'il n’obéit qu’à ton programme' },
              { cmd: 'l’ombre',      desc: 'marcher dessus te tue — frappe-la AVANT d’avancer' },
              { cmd: 'l’essence',    desc: 'à ramasser avec pickup() en étant dessus' },
              { cmd: 'la clé',       desc: 'permet d’ouvrir une porte avec open()' },
              { cmd: 'la dalle',     desc: 'elle s’enfonce en marchant dessus ; toutes enfoncées, les portes cèdent' },
              { cmd: 'le Monarque',   desc: 'un boss : plusieurs points de vie, à frapper autant de fois' },
              { cmd: 'la faille',    desc: 'la sortie du donjon : marche dessus' }
            ]
          }
        ];
      },

      destroy() {
        stop();
        editorApi.destroy();
        window.removeEventListener('resize', onResize);
        host.innerHTML = '';
      }
    };
  }
};

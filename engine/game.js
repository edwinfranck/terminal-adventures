/* game.js — l'enchaînement des scènes et le sentiment de progression.
   menu → parcours → carte de niveau → dialogue → jeu → victoire → fin de chapitre → fin d'univers.
   Ce fichier connaît le déroulé. Il ne connaît AUCUN gameplay. */

import { $, $$, t, el, bus, loadJSON, asset, ICON } from './core.js';
import { getPlugin } from './registry.js';
import * as dialogue from './dialogue.js';
import * as objectives from './objectives.js';
import * as save from './save.js';
import * as coach from './coach.js';
import { rankFor } from './progress.js';

const HINT_COST = 15;      // XP retirés par indice consulté
const NO_HINT_BONUS = 30;  // XP offerts si on s'en est sorti seul

/* ------------------------------------------------------------------ état */
const run = {
  universe: null,   // le JSON de l'univers
  plugin: null,     // la définition du plugin
  instance: null,   // l'instance vivante du plugin
  sequence: [],     // [{ chapter, ci, levelId }] à plat, dans l'ordre de jeu
  index: 0,
  level: null,
  hints: 0,
  malus: 0,
  said: 0
};

/* ------------------------------------------------------------------ scènes */
function showScene(name) {
  $$('.scene').forEach(s => s.classList.toggle('on', s.dataset.scene === name));
  document.documentElement.dataset.scene = name;   // le CSS masque la barre en jeu
}

/** ⚠ Une URL relative dans une variable CSS est résolue par rapport à la FEUILLE qui
   utilise la variable, pas au document. Il faut donc une URL absolue ici. */
function setArt(art = {}) {
  const abs = p => new URL(asset(p), document.baseURI).href;
  document.documentElement.style.setProperty('--art', art.bg ? `url("${abs(art.bg)}")` : 'none');

  // La vidéo est un BONUS : si le navigateur ne sait pas la décoder, on ne montre rien
  // de cassé — l'illustration qui dérive reste dessous.
  const v = $('#bgVid');
  const bg = $('#bg');
  const fallback = () => { v.hidden = true; bg.classList.remove('has-video'); };

  fallback();
  v.onerror = fallback;
  if (!art.video) { v.removeAttribute('src'); v.load(); return; }

  v.src = abs(art.video);
  v.oncanplay = () => {
    v.hidden = false;
    bg.classList.add('has-video');          // l'illustration s'efface : une seule couche
    v.play().catch(fallback);
  };
  v.load();
}

/** Bascule d'univers : un flash aux couleurs de l'accent, comme dans piscine.html. */
function glitch() {
  const g = $('#glitch');
  g.classList.remove('on');
  void g.offsetWidth;
  g.classList.add('on');
}

function fatal(err) {
  console.error(err);
  showScene('menu');
  $('#universeList').innerHTML =
    `<p style="color:var(--red);white-space:pre-wrap;text-align:left">${err.message}</p>`;
}

/** Petite récompense visible. C'est ce qui fait qu'on a envie du suivant. */
function toast(text, cls) {
  const node = el('div', { class: cls ? `toast ${cls}` : 'toast' }, text);
  $('#toasts').append(node);
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 320); }, 2000);
}

/* ------------------------------------------------------------------ menu
   Le menu est un SÉLECTEUR : choisir un univers retitre la page, change l'accent,
   le fond et le bouton d'entrée. Rien ne se lance avant le clic sur le bouton. */
const menuCache = new Map();
let picked = null;

async function applyPick(id) {
  picked = id;
  const uni = menuCache.get(id);
  const m = uni.menu || {};

  document.documentElement.dataset.theme = id;
  setArt(uni.art);
  glitch();

  $('#topTag').textContent = t(m.tag, t(uni.title));
  $('#menuKicker').textContent = t(m.kicker, t(uni.skill));
  const [a, b] = m.title || [t(uni.title), ''];
  $('#menuTitle').innerHTML = '';
  $('#menuTitle').append(el('span', {}, t(a)), document.createTextNode(b ? ' ' + t(b) : ''));
  $('#menuGo').textContent = t(m.cta, 'Commencer');

  $$('.uni-card').forEach(c => c.classList.toggle('sel', c.dataset.uni === id));
}

export async function showMenu() {
  teardown();
  showScene('menu');

  const list = $('#universeList');
  list.innerHTML = '';
  const index = await loadJSON('universes/index.json');

  for (const id of index.universes) {
    const uni = menuCache.get(id) || await loadJSON(`universes/${id}/universe.json`);
    menuCache.set(id, uni);
    const total = uni.chapters.flatMap(c => c.levels).length;
    const done = save.universeState(id).done.length;
    list.append(el('button', { class: 'uni-card', 'data-uni': id, onclick: () => applyPick(id) },
      // vignette animée si l'univers en fournit une, sinon l'illustration fixe
      uni.art?.anim || uni.art?.portrait
        ? el('img', { class: 'pic', src: asset(uni.art.anim || uni.art.portrait), alt: '' }) : null,
      el('div', { class: 'uni-body' },
        el('h3', {}, t(uni.title)),
        el('div', { class: 'tag uni-skill' }, t(uni.skill)),
        el('p', { class: 'uni-pitch' }, t(uni.pitch))
      ),
      el('div', { class: 'uni-pick' }, '● sélectionné'),
      done ? el('div', { class: 'uni-done' }, `${done}/${total}`) : null
    ));
  }

  // on n'affiche jamais un menu « neutre » : le premier univers est présélectionné
  await applyPick(picked && menuCache.has(picked) ? picked : index.universes[0]);
}

/* ------------------------------------------------------------------ univers */
async function loadUniverse(id) {
  levelCache.clear();
  run.universe = menuCache.get(id) || await loadJSON(`universes/${id}/universe.json`);
  run.universe.id = id;
  // materials.json est OPTIONNEL : les univers qui n'importent aucun asset n'en ont
  // pas, et son absence ne doit pas empêcher de jouer.
  try { run.materials = await loadJSON(`universes/${id}/materials.json`); }
  catch { run.materials = {}; }
  run.plugin = getPlugin(run.universe.plugin);
  run.sequence = run.universe.chapters.flatMap((chapter, ci) =>
    chapter.levels.map(levelId => ({ chapter, ci, levelId })));
  document.documentElement.dataset.theme = id;
  setArt(run.universe.art);
  $('#topTag').textContent = t(run.universe.menu?.tag, t(run.universe.title));
  glitch();
}

async function startUniverse(id) {
  try {
    await loadUniverse(id);
    await showMap();
  } catch (e) { fatal(e); }
}

/* ------------------------------------------------------------------ ce qu'on sait faire
   ⚠ Ce qui est appris ne se DÉSAPPREND pas. Chaque niveau déclare les commandes qu'il
   introduit ; l'arsenal réellement disponible est l'UNION de tous les niveaux précédents.
   Sans ça, `touch` (appris au niveau 02) répondait « tu ne maîtrises pas encore cette
   commande » au niveau 06 — et le joueur restait bloqué devant un fichier à créer. */
const levelCache = new Map();

async function getLevel(levelId) {
  if (!levelCache.has(levelId))
    levelCache.set(levelId, await loadJSON(`universes/${run.universe.id}/levels/${levelId}.json`));
  // une copie : le niveau joué est modifié (id, commandes cumulées), le cache doit rester intact
  return structuredClone(levelCache.get(levelId));
}

async function prepareLevel(index, levelId) {
  const level = await getLevel(levelId);
  level.id = levelId;

  const known = [];
  const syntax = [];                       // les formes de langage (repeat, if, function…)
  const seen = new Set();
  for (let i = 0; i <= index; i++) {
    const past = await getLevel(run.sequence[i].levelId);
    (past.world?.commands || []).forEach(c => known.includes(c) || known.push(c));
    for (const sx of past.world?.syntax || []) {
      const key = JSON.stringify(sx.cmd);
      if (seen.has(key)) continue;
      seen.add(key);
      syntax.push({ ...sx, fresh: i === index });   // seule celle du niveau est « NEW »
    }
  }
  level.world = { ...(level.world || {}), commands: known, syntax };
  return level;
}

/* ------------------------------------------------------------------ parcours
   Voir la route entière : ce qui est fait, ce qui vient, ce qui est encore fermé. */
const doneSet = () => new Set(save.universeState(run.universe.id).done);
const firstTodo = () => {
  const d = doneSet();
  const i = run.sequence.findIndex(s => !d.has(s.levelId));
  return i === -1 ? run.sequence.length - 1 : i;
};

export async function showMap() {
  teardown();
  showScene('map');

  const uni = run.universe;
  const st = save.universeState(uni.id);
  const r = rankFor(uni.ranks, st.xp);

  $('#mapSkill').textContent = t(uni.skill);
  $('#mapTitle').textContent = t(uni.title);
  $('#mapRank').textContent = r.name;
  $('#mapXpBar').style.width = `${Math.round(r.ratio * 100)}%`;
  $('#mapNext').textContent = r.next ? `${st.xp} XP · prochain rang : ${r.next}` : `${st.xp} XP · rang maximum`;

  const done = doneSet();
  const todo = firstTodo();
  const list = $('#chapterList');
  list.innerHTML = '';

  // les titres sont dans le JSON ; on charge chaque niveau pour afficher son nom
  const titles = {};
  for (const s of run.sequence) titles[s.levelId] = t((await getLevel(s.levelId)).title);

  uni.chapters.forEach((chapter, ci) => {
    const mine = run.sequence.filter(s => s.ci === ci);
    const nDone = mine.filter(s => done.has(s.levelId)).length;
    const open = mine.some(s => run.sequence.indexOf(s) <= todo);

    const full = nDone === mine.length;
    const state = !open ? 'chapter locked' : full ? 'chapter full' : 'chapter';
    list.append(el('div', { class: state },
      el('div', { class: 'chapter-h' },
        el('span', { class: 'chapter-ico', html: open ? (full ? ICON.check : ICON.unlock) : ICON.lock }),
        el('h3', {}, t(chapter.title)),
        el('span', { class: 'dots' }, '◆'.repeat(chapter.difficulty || ci + 1)),
        el('span', { class: 'tag count' }, `${nDone}/${mine.length}`)
      ),
      el('div', { class: 'levels' }, mine.map(s => {
        const gi = run.sequence.indexOf(s);
        const isDone = done.has(s.levelId);
        const locked = !isDone && gi > todo;
        const cls = isDone ? 'lvl done' : gi === todo ? 'lvl now' : 'lvl';
        return el('button', {
          class: cls, disabled: locked,
          onclick: locked ? null : () => startLevel(gi)
        },
          isDone  ? el('span', { class: 'n', html: ICON.check })
          : locked ? el('span', { class: 'n', html: ICON.lock })
          :          el('span', { class: 'n' }, s.levelId),
          el('span', { class: 't' }, locked ? 'À débloquer' : titles[s.levelId]));
      }))
    ));
  });
}

/* Accès direct : #one-piece/02 saute dans un niveau, sans carte ni dialogue. */
async function jumpToHash() {
  const [, uni, levelId] = (location.hash.match(/^#([\w-]+)\/([\w-]+)$/) || []);
  if (!uni || !levelId) return false;
  try {
    await loadUniverse(uni);
    const i = run.sequence.findIndex(s => s.levelId === levelId);
    if (i === -1) return false;
    run.index = i;
    run.level = await prepareLevel(i, levelId);
    startPlay();
    return true;
  } catch (e) { fatal(e); return true; }
}

/* ------------------------------------------------------------------ carte de niveau */
async function startLevel(i) {
  run.index = i;
  const step = run.sequence[i];
  run.level = await prepareLevel(i, step.levelId);

  $('#cardChapter').textContent = t(step.chapter.title);
  $('#cardTitle').textContent = t(run.level.title);
  $('#cardBrief').textContent = t(run.level.tagline, '');
  showScene('card');
}

/* ------------------------------------------------------------------ dialogue */
async function runDialogue() {
  const lines = run.level.dialogue || [];
  if (!lines.length) return startPlay();
  showScene('dialogue');
  await dialogue.play(lines, {
    who: t(run.universe.hero?.name),
    face: run.universe.art?.anim || run.universe.art?.face
  });
  startPlay();
}

/* ------------------------------------------------------------------ jeu */
function startPlay() {
  teardown();
  showScene('play');

  const step = run.sequence[run.index];
  $('#hudChapter').textContent = t(step.chapter.title);
  $('#hudTitle').textContent = t(run.level.title);
  paintRank();

  $('#playBrief').innerHTML = t(run.level.brief, '');
  run.hints = 0;
  run.malus = 0;
  run.said = 0;
  paintHints();
  paintMentor();

  const host = $('#pluginHost');
  host.innerHTML = '';
  run.instance = run.plugin.create(host, {
    changed: () => objectives.refresh(),
    t, level: run.level, universe: run.universe
  });
  // les matériaux de l'univers voyagent avec le monde : le plugin n'a pas à savoir
  // d'où ils viennent, et un niveau peut les surcharger via son propre "materials".
  run.instance.load({ materials: run.materials || {}, ...(run.level.world || {}) }, run.level);

  objectives.mount(run.level, run.instance, onWin);
  paintArsenal();
  coach.watch((run.level.mentor?.nudge || []).map(x => t(x)));
}

function paintArsenal() {
  const list = $('#arsenalList');
  list.innerHTML = '';
  (run.instance.arsenal?.(run.level) || []).forEach(it =>
    list.append(el('li', { class: it.fresh ? 'fresh' : null }, el('code', {}, it.cmd), t(it.desc))));
}

function paintRank() {
  const st = save.universeState(run.universe.id);
  const r = rankFor(run.universe.ranks, st.xp);
  $('#hudRank').textContent = r.name;
  $('#hudXpBar').style.width = `${Math.round(r.ratio * 100)}%`;
}

/* ------------------------------------------------------------------ mentor */
function mentorOf() {
  const m = run.level.mentor || {};
  return {
    who: t(m.who ?? run.universe.hero?.name, ''),
    face: m.face ?? run.universe.art?.face,
    start: t(m.start ?? run.level.tagline, ''),
    progress: (m.progress || []).map(x => t(x)),
    stuck: m.stuck ? t(m.stuck) : null
  };
}

function mentorSay(text) {
  if (!text) return;
  const box = $('#mentor');
  $('#mentorLine').textContent = text;
  box.classList.remove('say');
  void box.offsetWidth;
  box.classList.add('say');
}

function paintMentor() {
  const m = mentorOf();
  const img = $('#mentorFace');
  img.src = m.face ? asset(m.face) : '';
  img.hidden = !m.face;
  $('#mentorWho').textContent = m.who;
  $('#mentorLine').textContent = m.start;
}

/* ------------------------------------------------------------------ indices payants */
const hintList = () => {
  const h = run.level.hint;
  return h == null ? [] : Array.isArray(h) ? h : [h];
};

function paintHints() {
  const all = hintList();
  const btn = $('#btnHint');
  const box = $('#hintList');

  $('#hintWrap').hidden = all.length === 0;
  box.innerHTML = '';
  all.slice(0, run.hints).forEach((h, i) =>
    box.append(el('p', { class: 'hint', html: `<b>Indice ${i + 1}.</b> ${t(h)}` })));

  const left = all.length - run.hints;
  btn.hidden = left === 0;
  btn.firstChild.textContent = run.hints ? `Indice suivant (${left} restant${left > 1 ? 's' : ''})` : 'Voir un indice';
  btn.lastChild.textContent = `−${HINT_COST} XP`;

  const spent = $('#hintSpent');
  spent.hidden = run.malus === 0;
  spent.textContent = `${run.hints} indice${run.hints > 1 ? 's' : ''} · −${run.malus} XP sur ce niveau`;
}

function takeHint() {
  if (run.hints >= hintList().length) return;
  run.hints++;
  run.malus += HINT_COST;
  paintHints();
  closeCoach();
}

/* ------------------------------------------------------------------ coup de main */
function showCoach({ text, offerHint }) {
  if (!$('.scene[data-scene="play"]').classList.contains('on')) return;
  const m = mentorOf();
  const img = $('#coachFace');
  img.src = m.face ? asset(m.face) : '';
  img.hidden = !m.face;
  $('#coachWho').textContent = m.who ? `${m.who} — coup de main` : 'Coup de main';
  $('#coachText').innerHTML = text;   // les relances contiennent du <b> et du <code>
  $('#coachHint').hidden = !offerHint || run.hints >= hintList().length;
  $('#coach').hidden = false;
}
const closeCoach = () => { $('#coach').hidden = true; };

/* ------------------------------------------------------------------ aide */
function openHelp() {
  const sections = run.instance?.help?.() || [];
  $('#helpTitle').textContent = `Aide — ${run.plugin.label}`;
  const body = $('#helpBody');
  body.innerHTML = '';

  sections.forEach(sec => {
    const node = el('section', { class: 'help-sec' }, el('h3', {}, t(sec.title)));
    if (sec.text) t(sec.text).split('\n').forEach(p => node.append(el('p', { html: p })));
    if (sec.commands) {
      node.append(el('div', { class: 'help-cmds' },
        sec.commands.map(c => el('div', { class: 'help-cmd' },
          el('code', {}, c.cmd),
          el('div', { class: 'txt' }, t(c.desc), c.ex ? el('span', { class: 'ex' }, c.ex) : null)))));
    }
    body.append(node);
  });
  $('#helpOv').classList.add('on');
}
const closeHelp = () => $('#helpOv').classList.remove('on');

/* ------------------------------------------------------------------ victoire */
function onWin() {
  coach.stop();
  closeCoach();

  const base = run.level.reward?.xp || 0;
  const bonus = run.hints === 0 ? NO_HINT_BONUS : 0;
  const xp = Math.max(0, base - run.malus) + bonus;
  save.markDone(run.universe.id, run.level.id, xp);
  paintRank();

  setTimeout(() => {
    showScene('win');
    $('#winTitle').textContent = t(run.level.reward?.title, 'Objectif atteint');

    const stats = $('#winStats');
    stats.innerHTML = '';
    stats.append(el('div', { class: 'win-stat' },
      el('b', {}, `+${Math.max(0, base - run.malus)}`), el('span', { class: 'tag' }, 'XP du niveau')));
    if (bonus) {
      stats.append(el('div', { class: 'win-stat' },
        el('b', {}, `+${bonus}`), el('span', { class: 'tag' }, 'sans aucun indice')));
    }
    if (run.malus) {
      stats.append(el('div', { class: 'win-stat malus' },
        el('b', {}, `−${run.malus}`), el('span', { class: 'tag' }, `${run.hints} indice${run.hints > 1 ? 's' : ''}`)));
    }
    if (run.level.reward?.unlock) {
      stats.append(el('div', { class: 'win-stat' },
        el('b', {}, '＋'), el('span', { class: 'tag' }, t(run.level.reward.unlock))));
    }
    paintRecap();
    $('#winNext').textContent = 'Continuer';
    toast(`+${xp} XP`, 'xp');
  }, 700);
}

/* Le débrief : ce qui vient d'être abordé, en clair. Gagner sans savoir ce qu'on a
   appris, ça ne fait pas un apprentissage — c'est le moment où la leçon se fixe.
   Le niveau l'écrit dans son champ `recap` ; à défaut on retombe sur les nouveautés
   que le plugin déclare, pour qu'il n'y ait jamais d'écran muet. */
function paintRecap() {
  const box = $('#winRecap');
  box.innerHTML = '';

  let items = (run.level.recap || []).map(r => ({ cmd: t(r.cmd), txt: t(r.txt) }));
  if (!items.length) {
    items = (run.instance?.arsenal?.(run.level) || [])
      .filter(a => a.fresh)
      .map(a => ({ cmd: a.cmd, txt: a.desc }));
  }
  box.hidden = !items.length;
  if (box.hidden) return;

  box.append(el('p', { class: 'tag' }, 'Ce que tu viens d’apprendre'));
  box.append(el('ul', {}, items.map(i =>
    el('li', {},
      el('code', {}, i.cmd),
      el('span', {}, i.txt || '')))));   // toujours les deux cellules, sinon la grille se décale
}

/* ------------------------------------------------------------------ fins */
function chapterOf(i) { return run.sequence[i]?.ci; }

function afterWin() {
  const i = run.index;
  const last = i >= run.sequence.length - 1;
  const chapterDone = last || chapterOf(i + 1) !== chapterOf(i);

  if (last) return showEnd('final');
  if (chapterDone) return showEnd('chapter');
  startLevel(i + 1);
}

function showEnd(kind) {
  teardown();
  const uni = run.universe;
  const st = save.universeState(uni.id);
  const r = rankFor(uni.ranks, st.xp);
  const chapter = run.sequence[run.index].chapter;
  const scene = $('.scene[data-scene="end"]');
  scene.classList.toggle('final', kind === 'final');

  if (kind === 'final') {
    $('#endKicker').textContent = 'Aventure terminée';
    $('#endTitle').textContent = t(uni.ending?.title, `Tu es ${r.name}`);
    $('#endLine').textContent = t(uni.ending?.line, 'Tu as fini tout ce que cet univers avait à t’apprendre.');
    $('#endNext').textContent = 'Choisir un autre univers';
  } else {
    $('#endKicker').textContent = 'Chapitre terminé';
    $('#endTitle').textContent = t(chapter.title);
    $('#endLine').textContent = t(chapter.outro, 'La suite est plus dure. C’est le but.');
    $('#endNext').textContent = 'Chapitre suivant';
  }

  const stats = $('#endStats');
  stats.innerHTML = '';
  stats.append(el('div', { class: 'win-stat' }, el('b', {}, st.xp), el('span', { class: 'tag' }, 'XP total')));
  stats.append(el('div', { class: 'win-stat' }, el('b', {}, r.name), el('span', { class: 'tag' }, 'rang')));
  stats.append(el('div', { class: 'win-stat' },
    el('b', {}, `${st.done.length}/${run.sequence.length}`), el('span', { class: 'tag' }, 'niveaux')));

  showScene('end');
  toast(kind === 'final' ? 'Univers terminé !' : 'Chapitre terminé !');
}

function endNext() {
  if ($('.scene[data-scene="end"]').classList.contains('final')) return showMenu();
  startLevel(Math.min(run.index + 1, run.sequence.length - 1));
}

function teardown() {
  run.instance?.destroy?.();
  run.instance = null;
  coach.stop();
  closeCoach();
  closeHelp();
  objectives.unmount();
}

/* ------------------------------------------------------------------ câblage UI */
/** Clair / sombre : mémorisé, et il survit à un #reset de la progression. */
function setMode(mode) {
  document.documentElement.dataset.mode = mode;
  $('#btnMode').textContent = mode === 'light' ? '☀' : '☾';
  save.pref('mode', mode);
}

export function wire() {
  setMode(save.pref('mode') || 'dark');
  $('#btnMode').onclick = () =>
    setMode(document.documentElement.dataset.mode === 'light' ? 'dark' : 'light');
  $('#btnFull').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  $('#menuGo').onclick   = () => picked && startUniverse(picked);
  $('#cardGo').onclick   = () => runDialogue();
  $('#winNext').onclick  = () => afterWin();
  $('#winMenu').onclick  = () => showMap();
  $('#btnBack').onclick  = () => showMap();
  $('#mapBack').onclick  = () => showMenu();
  $('#endNext').onclick  = () => endNext();
  $('#endMap').onclick   = () => showMap();
  $('#btnHint').onclick  = takeHint;
  $('#btnHelp').onclick  = openHelp;
  $('#helpX').onclick    = closeHelp;
  $('#helpOv').onclick   = e => { if (e.target.id === 'helpOv') closeHelp(); };
  $('#coachOk').onclick  = closeCoach;
  $('#coachHint').onclick = takeHint;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeHelp(); closeCoach(); } });

  bus.on('level:win', onWin);
  bus.on('coach:say', showCoach);

  // un objectif tombe : le mentor commente, et ça se voit à l'écran
  bus.on('criterion:done', idx => {
    const p = mentorOf().progress;
    if (p.length) mentorSay(p[Math.min(run.said++, p.length - 1)]);
    const li = $(`#criteriaList li[data-i="${idx}"]`);
    if (li) { li.classList.remove('pop'); void li.offsetWidth; li.classList.add('pop'); }
    toast('Objectif validé');
  });

  bus.on('player:error', () => mentorSay(mentorOf().stuck));
}

/** #reset efface la progression · #univers/niveau saute dans un niveau · sinon le menu. */
export async function boot() {
  if (location.hash === '#reset') {
    save.resetAll();
    history.replaceState(null, '', location.pathname);
    return showMenu();
  }
  if (await jumpToHash()) return;
  showMenu();
}

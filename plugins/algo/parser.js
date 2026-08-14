/* parser.js — le mini-langage. Volontairement proche du vrai code, sans en être :
     moveRight()          moveRight(3)
     attack();            pickup();
     repeat (4) { ... }
     if (enemy) { ... } else { ... }
     while (chest) { ... }
   Les erreurs sont écrites pour un débutant, avec le numéro de ligne. */

class SyntaxIssue extends Error {
  constructor(message, line) { super(message); this.line = line; }
}

/* ---------------------------------------------------------------- tokenizer */
function tokenize(src) {
  const tokens = [];
  let line = 1;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }

    if ('(){};,'.includes(ch)) { tokens.push({ type: ch, line }); i++; continue; }

    // comparaisons à deux caractères d'abord : sinon « <= » se lit « < » puis « = »
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>='].includes(two)) { tokens.push({ type: 'op', value: two, line }); i += 2; continue; }
    if (ch === '<' || ch === '>')  { tokens.push({ type: 'op', value: ch, line }); i++; continue; }
    if (ch === '+' || ch === '-')  { tokens.push({ type: ch, line }); i++; continue; }
    if (ch === '=')                { tokens.push({ type: '=', line }); i++; continue; }

    if (/[0-9]/.test(ch)) {
      let n = '';
      while (/[0-9]/.test(src[i])) n += src[i++];
      tokens.push({ type: 'number', value: +n, line });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let w = '';
      while (/[A-Za-z0-9_]/.test(src[i])) w += src[i++];
      tokens.push({ type: 'word', value: w, line });
      continue;
    }

    throw new SyntaxIssue(`Caractère inattendu « ${ch} ».`, line);
  }

  tokens.push({ type: 'eof', line });
  return tokens;
}

/* ---------------------------------------------------------------- parser */
const KEYWORDS = new Set(['repeat', 'if', 'while', 'else', 'function', 'var']);

/** Les fonctions que le joueur a lui-même définies : leurs noms deviennent des instructions. */
const declaredIn = src =>
  new Set([...src.matchAll(/\bfunction\s+([A-Za-z_][\w]*)/g)].map(m => m[1]));

export function parse(src, knownCommands) {
  const tokens = tokenize(src);
  const mine = declaredIn(src);
  let p = 0;

  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const at = type => tokens[p].type === type;
  const atWord = w => tokens[p].type === 'word' && tokens[p].value === w;

  function expect(type, what) {
    if (!at(type)) throw new SyntaxIssue(`Il manque ${what} ici.`, peek().line);
    return next();
  }

  function block() {
    expect('{', 'une accolade ouvrante {');
    const body = [];
    while (!at('}')) {
      if (at('eof')) throw new SyntaxIssue('Une accolade } n’a jamais été fermée.', peek().line);
      body.push(statement());
    }
    next(); // }
    return body;
  }

  /** Un terme : un nombre, ou le nom d'une variable. */
  function term() {
    const tok = peek();
    if (at('number')) return { kind: 'num', value: next().value };
    if (at('word')) {
      const name = next().value;
      if (KEYWORDS.has(name)) throw new SyntaxIssue(`« ${name} » ne s’utilise pas dans un calcul.`, tok.line);
      return { kind: 'var', name, line: tok.line };
    }
    throw new SyntaxIssue('Il faut un nombre ou le nom d’une variable ici.', tok.line);
  }

  /** Une expression : des termes reliés par + et −. Rien de plus : ça reste lisible. */
  function expression() {
    let node = term();
    while (at('+') || at('-')) {
      const op = next().type;
      node = { kind: 'calc', op, left: node, right: term() };
    }
    return node;
  }

  /** Condition : soit un mot du monde (enemy, wall…), soit une comparaison (pas < 5). */
  function condition() {
    expect('(', 'une parenthèse ouvrante (');
    if (at('word') && tokens[p + 1].type === ')') {
      const cond = { kind: 'world', name: next().value };
      expect(')', 'une parenthèse fermante )');
      return cond;
    }
    const left = expression();
    if (!at('op')) {
      throw new SyntaxIssue(
        'Une condition, c’est soit un mot comme (enemy), soit une comparaison comme (pas < 5).', peek().line);
    }
    const op = next().value;
    const right = expression();
    expect(')', 'une parenthèse fermante )');
    return { kind: 'cmp', op, left, right };
  }

  function statement() {
    const tok = peek();

    if (tok.type !== 'word') throw new SyntaxIssue(`« ${tok.type} » n’est pas une instruction valide.`, tok.line);

    if (tok.value === 'repeat') {
      next();
      expect('(', 'une parenthèse ouvrante (');
      if (at(')')) throw new SyntaxIssue('repeat a besoin d’un nombre : repeat (3) { … }', peek().line);
      const count = expression();          // un nombre… ou une variable
      expect(')', 'une parenthèse fermante )');
      return { kind: 'repeat', count, body: block(), line: tok.line };
    }

    if (tok.value === 'if') {
      next();
      const cond = condition();
      const body = block();
      let otherwise = null;
      if (atWord('else')) { next(); otherwise = block(); }
      return { kind: 'if', cond, body, otherwise, line: tok.line };
    }

    if (tok.value === 'while') {
      next();
      const cond = condition();
      return { kind: 'while', cond, body: block(), line: tok.line };
    }

    if (tok.value === 'var') {
      next();
      if (!at('word')) throw new SyntaxIssue('Une variable a besoin d’un nom : var pas = 0', peek().line);
      const name = next().value;
      if (KEYWORDS.has(name)) throw new SyntaxIssue(`« ${name} » est un mot réservé : choisis un autre nom.`, tok.line);
      expect('=', 'un signe = : var pas = 0');
      const value = expression();
      if (at(';')) next();
      return { kind: 'var', name, value, line: tok.line };
    }

    // affectation : `pas = pas + 1`. On la reconnaît au = qui suit le nom.
    if (tok.type === 'word' && tokens[p + 1].type === '=') {
      const name = next().value;
      next();                                    // =
      const value = expression();
      if (at(';')) next();
      return { kind: 'assign', name, value, line: tok.line };
    }

    if (tok.value === 'function') {
      next();
      if (!at('word')) throw new SyntaxIssue('Une fonction a besoin d’un nom : function monNom() { … }', peek().line);
      const fname = next().value;
      if (KEYWORDS.has(fname)) throw new SyntaxIssue(`« ${fname} » est un mot réservé : choisis un autre nom.`, tok.line);
      expect('(', 'une parenthèse ouvrante (');
      expect(')', 'une parenthèse fermante ) — une fonction ne prend pas d’argument ici');
      return { kind: 'function', name: fname, body: block(), line: tok.line };
    }

    // sinon : un appel de commande
    const name = next().value;
    if (KEYWORDS.has(name)) throw new SyntaxIssue(`« ${name} » ne s’utilise pas comme ça.`, tok.line);
    if (knownCommands && !knownCommands.has(name) && !mine.has(name)) {
      throw new SyntaxIssue(`« ${name} » : tu ne connais pas encore cette instruction.`, tok.line);
    }
    if (!at('(')) throw new SyntaxIssue(`Il manque les parenthèses après ${name} : ${name}()`, tok.line);
    next();
    let arg = null;
    if (!at(')')) arg = expression();           // moveRight(3) ou moveRight(pas)
    expect(')', `une parenthèse fermante ) après ${name}(`);
    if (at(';')) next();     // le ; est accepté mais pas obligatoire
    return { kind: 'call', name, arg, line: tok.line };
  }

  const program = [];
  while (!at('eof')) program.push(statement());
  return program;
}

/* ---------------------------------------------------------------- exécution
   Générateur : il ne bouge rien lui-même, il énonce l'instruction suivante.
   C'est la vue qui décide du rythme (x1, x2, pas-à-pas). */
const MAX_STEPS = 800;   // garde-fou contre les while(true)
const MAX_DEPTH = 40;    // garde-fou contre une fonction qui s'appelle elle-même

export function* execute(program, world) {
  let steps = 0;
  let depth = 0;

  /* Les variables du joueur. Une seule portée : à ce niveau de langage, deux portées
     imbriquées seraient un piège incompréhensible pour un débutant. */
  const vars = new Map();

  const value = node => {
    switch (node.kind) {
      case 'num':  return node.value;
      case 'var': {
        if (vars.has(node.name)) return vars.get(node.name);
        // certains compteurs sont tenus par le jeu (army, kills, essences) : on les lit
        const w = world.value?.(node.name);
        if (w != null) return w;
        throw new SyntaxIssue(
          `« ${node.name} » n’existe pas encore. Crée-la d’abord : var ${node.name} = 0`, node.line);
      }
      case 'calc': {
        const a = value(node.left), b = value(node.right);
        return node.op === '+' ? a + b : a - b;
      }
      default: return 0;
    }
  };

  const truth = cond => {
    if (cond.kind === 'cmp') {
      const a = value(cond.left), b = value(cond.right);
      switch (cond.op) {
        case '<':  return a < b;
        case '>':  return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
        case '==': return a === b;
        case '!=': return a !== b;
        default:   return false;
      }
    }
    return world.test(cond.name ?? cond);   // condition du monde
  };

  // Les déclarations sont lues d'abord : une fonction peut être définie après son appel.
  const funcs = new Map();
  const collect = body => body.forEach(n => {
    if (n.kind === 'function') funcs.set(n.name, n);
    if (n.body) collect(n.body);
    if (n.otherwise) collect(n.otherwise);
  });
  collect(program);

  function* runBlock(body) {
    for (const node of body) yield* runNode(node);
  }

  function* runNode(node) {
    if (++steps > MAX_STEPS) {
      throw new SyntaxIssue('Ton programme tourne en boucle sans fin. Vérifie ta condition.', node.line);
    }
    switch (node.kind) {
      case 'function':
        break;                                   // une déclaration n'exécute rien

      /* Une variable qui change sans qu'on le voie ne s'apprend pas : chaque écriture
         est un pas du programme, annoncé au-dessus du héros comme une instruction. */
      case 'var':
      case 'assign': {
        if (node.kind === 'assign' && !vars.has(node.name)) {
          throw new SyntaxIssue(
            `« ${node.name} » n’existe pas encore. Crée-la d’abord : var ${node.name} = 0`, node.line);
        }
        const v = value(node.value);
        vars.set(node.name, v);
        yield { kind: 'set', label: `${node.name} = ${v}`, line: node.line };
        break;
      }

      case 'call': {
        const fn = funcs.get(node.name);
        if (fn) {                                // appel d'une fonction du joueur
          if (++depth > MAX_DEPTH) {
            throw new SyntaxIssue(`« ${node.name} » s’appelle elle-même sans fin.`, node.line);
          }
          const times = node.arg ? value(node.arg) : 1;
          for (let k = 0; k < Math.max(1, times); k++) yield* runBlock(fn.body);
          depth--;
          break;
        }
        // moveRight(3) = 3 pas distincts, pour qu'on VOIE chaque déplacement
        const times = node.arg ? value(node.arg) : 1;
        for (let k = 0; k < Math.max(1, times); k++) {
          yield { name: node.name, line: node.line };
        }
        break;
      }
      case 'repeat': {
        const n = value(node.count);
        for (let k = 0; k < n; k++) yield* runBlock(node.body);
        break;
      }
      case 'if':
        if (truth(node.cond)) yield* runBlock(node.body);
        else if (node.otherwise) yield* runBlock(node.otherwise);
        break;
      case 'while':
        while (truth(node.cond)) {
          if (++steps > MAX_STEPS) {
            throw new SyntaxIssue('Cette boucle while ne s’arrête jamais. Que doit-il changer pour qu’elle se termine ?', node.line);
          }
          yield* runBlock(node.body);
        }
        break;
    }
  }

  yield* runBlock(program);
}

export { SyntaxIssue };

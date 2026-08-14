/* editor.js — le confort d'écriture. Un débutant ne doit pas se battre contre
   les parenthèses, les accolades et l'indentation : l'éditeur les gère pour lui.

   · ( et { s'auteferment, ) et } se traversent au lieu de doubler
   · Entrée conserve l'indentation, et l'augmente à l'intérieur d'un bloc
   · Tab indente (ou valide la suggestion)
   · autocomplétion au fil de la frappe : ↑ ↓ pour choisir, Entrée ou Tab pour valider, Échap ferme

   attach(textarea, { candidates() }) -> { destroy() } */

const INDENT = '  ';
const PAIRS = { '(': ')', '{': '}' };
const CLOSERS = new Set([')', '}']);

export function attach(ta, { candidates, onChange }) {
  /* ---------------- liste de suggestions ---------------- */
  const pop = document.createElement('div');
  pop.className = 'ac';
  pop.hidden = true;
  ta.parentElement.append(pop);

  let items = [];
  let sel = 0;
  const open = () => !pop.hidden;

  /* Mesure réelle d'un caractère : la police est à chasse fixe, une mesure suffit. */
  function metrics() {
    const cs = getComputedStyle(ta);
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`;
    probe.textContent = '0'.repeat(50);
    document.body.append(probe);
    const charW = probe.getBoundingClientRect().width / 50;
    probe.remove();
    return {
      charW,
      lineH: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6,
      padL: parseFloat(cs.paddingLeft),
      padT: parseFloat(cs.paddingTop)
    };
  }

  const wordBefore = () => (ta.value.slice(0, ta.selectionStart).match(/[A-Za-z_][\w]*$/) || [''])[0];

  function place() {
    const { charW, lineH, padL, padT } = metrics();
    const before = ta.value.slice(0, ta.selectionStart).split('\n');
    const row = before.length - 1;
    const col = before[row].length - wordBefore().length;
    pop.style.left = `${padL + col * charW - ta.scrollLeft}px`;
    pop.style.top = `${padT + (row + 1) * lineH - ta.scrollTop + 2}px`;
  }

  function render() {
    pop.innerHTML = '';
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = i === sel ? 'ac-i on' : 'ac-i';
      row.innerHTML = `<code>${it.label}</code><span>${it.desc || ''}</span>`;
      row.addEventListener('mousedown', e => { e.preventDefault(); sel = i; accept(); });
      pop.append(row);
    });
    pop.hidden = !items.length;
    if (items.length) place();
  }

  function refresh() {
    const w = wordBefore();
    items = w.length >= 1
      ? candidates().filter(c => c.label.toLowerCase().startsWith(w.toLowerCase()) && c.label !== w)
      : [];
    sel = 0;
    render();
  }

  const close = () => { items = []; pop.hidden = true; };

  /* ---------------- édition ---------------- */
  function replaceRange(from, to, text, caretOffset = text.length) {
    ta.setRangeText(text, from, to, 'end');
    ta.selectionStart = ta.selectionEnd = from + caretOffset;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    onChange?.();
  }

  function accept() {
    const it = items[sel];
    if (!it) return;
    const start = ta.selectionStart - wordBefore().length;
    const text = it.insert ?? `${it.label}()`;
    const caret = it.caret ?? text.length - (text.endsWith('()') ? 1 : 0);
    close();
    replaceRange(start, ta.selectionStart, text, caret);
  }

  function onKeyDown(e) {
    // --- navigation dans la liste
    if (open()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; render(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); close(); return; }
    }

    const pos = ta.selectionStart;
    const val = ta.value;
    const next = val[pos];

    // --- Tab : indenter
    if (e.key === 'Tab') { e.preventDefault(); replaceRange(pos, ta.selectionEnd, INDENT); return; }

    // --- paire ouvrante : on ferme tout de suite
    if (PAIRS[e.key] && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault();
      replaceRange(pos, pos, e.key + PAIRS[e.key], 1);
      return;
    }

    // --- paire fermante déjà là : on la traverse au lieu d'en écrire une deuxième
    if (CLOSERS.has(e.key) && next === e.key) {
      e.preventDefault();
      ta.selectionStart = ta.selectionEnd = pos + 1;
      return;
    }

    // --- Retour arrière entre deux paires : on supprime les deux
    if (e.key === 'Backspace' && ta.selectionStart === ta.selectionEnd && PAIRS[val[pos - 1]] === next) {
      e.preventDefault();
      replaceRange(pos - 1, pos + 1, '');
      return;
    }

    // --- Entrée : garder l'indentation, l'augmenter dans un bloc
    if (e.key === 'Enter') {
      e.preventDefault();
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      const indent = (val.slice(lineStart, pos).match(/^[ \t]*/) || [''])[0];
      const prev = val.slice(0, pos).trimEnd().slice(-1);

      if (prev === '{' && next === '}') {
        // on écarte les accolades et on place le curseur au milieu, indenté
        const text = `\n${indent}${INDENT}\n${indent}`;
        replaceRange(pos, pos, text, 1 + indent.length + INDENT.length);
      } else if (prev === '{') {
        replaceRange(pos, pos, `\n${indent}${INDENT}`);
      } else {
        replaceRange(pos, pos, `\n${indent}`);
      }
      return;
    }
  }

  const onInput = () => setTimeout(refresh, 0);
  const onBlur = () => setTimeout(close, 120);

  ta.addEventListener('keydown', onKeyDown);
  ta.addEventListener('input', onInput);
  ta.addEventListener('blur', onBlur);
  ta.addEventListener('scroll', close);

  return {
    close,
    destroy() {
      ta.removeEventListener('keydown', onKeyDown);
      ta.removeEventListener('input', onInput);
      ta.removeEventListener('blur', onBlur);
      ta.removeEventListener('scroll', close);
      pop.remove();
    }
  };
}

// Keyboard shortcuts and the search of the command palette. No page or browser needed here, so the tests can run it.
// A shortcut is written like "mod+shift+o": "mod" is ⌘ on a Mac and Ctrl elsewhere. Letters and digits are taken from
// the key's place on the keyboard, not from the letter it types, so shortcuts work with a Russian layout too.

export const SHORTCUTS = [
  { id: 'palette', combo: 'mod+k' },
  { id: 'newChat', combo: 'mod+shift+o' },
  { id: 'searchChats', combo: 'mod+shift+f' },
  { id: 'sidebar', combo: 'mod+shift+s' },
  { id: 'stop', combo: 'mod+.' },
  { id: 'models', combo: 'mod+shift+m' },
  { id: 'settings', combo: 'mod+,' },
];

const NAMED = { ' ': 'space', escape: 'esc', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };
const ALONE = new Set(['control', 'shift', 'alt', 'meta', 'os', 'altgraph', 'capslock', 'dead', 'process', 'unidentified']);

// The shortcut a key press makes, or '' for a lone modifier key.
export function comboOf(e, mac) {
  let key = String(e.key || '').toLowerCase();
  if (ALONE.has(key)) return '';
  const code = String(e.code || '');
  if (/^Key[A-Z]$/.test(code)) key = code[3].toLowerCase();
  else if (/^Digit\d$/.test(code)) key = code[5];
  else if (code === 'Comma') key = ',';
  else if (code === 'Period') key = '.';
  else if (code === 'Slash') key = '/';
  key = NAMED[key] || key;
  const parts = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (mac && e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  return [...parts, key].join('+');
}

// A shortcut must not fire while typing: it needs ⌘/Ctrl or Alt, or be a function key.
export const usable = (combo) => /(^|\+)(mod|ctrl|alt)\+/.test(combo) || /^f\d{1,2}$/.test(combo);

export function fmtCombo(combo, mac) {
  if (!combo) return '';
  const names = mac ? { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' } : { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  const parts = combo.split('+').map((p) => names[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)));
  return mac ? parts.join('') : parts.join('+');
}

// The shortcuts in use: the user's own choices over the defaults. '' turns one off.
export function activeShortcuts(saved = {}) {
  return SHORTCUTS.map((s) => ({ id: s.id, combo: typeof saved?.[s.id] === 'string' ? saved[s.id] : s.combo, standard: s.combo }));
}

// The palette's list for what was typed: every word must be in the label; a label that starts with the text, or
// has a word starting with it, comes first. Without text: the list as it is.
export function filterItems(items, query, limit = 12) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice(0, limit);
  const scored = [];
  items.forEach((it, i) => {
    const label = `${it.label} ${it.hint || ''}`.toLowerCase();
    if (!words.every((w) => label.includes(w))) return;
    const first = String(it.label).toLowerCase();
    const rank = first.startsWith(words[0]) ? 0 : first.split(/[\s—–-]+/).some((x) => x.startsWith(words[0])) ? 1 : 2;
    scored.push({ it, rank, i });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).slice(0, limit).map((x) => x.it);
}

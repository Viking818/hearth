// "/name what follows" in the chat: a saved prompt (a command) with what follows filled in.
// Commands use Claude Code's placeholders: $ARGUMENTS is everything after the name, $1…$9 its words.
// Claude Code also runs shell lines written as !`…` before sending; Hearth never runs programs, so they are dropped.

export function splitSlash(text) {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { name: m[1], rest: (m[2] || '').trim() } : null;
}

export function expandCommand(template, args = '') {
  const rest = String(args || '').trim();
  const words = rest ? rest.split(/\s+/) : [];
  let used = false;
  let out = String(template || '')
    .replace(/!`[^`\n]*`/g, '')
    .replace(/\$ARGUMENTS\b/g, () => {
      used = true;
      return rest;
    })
    .replace(/\$([1-9])\b/g, (_, n) => {
      used = true;
      return words[n - 1] || '';
    })
    .trim();
  if (!used && rest) out = `${out}\n\n${rest}`;
  return out;
}

// The menu's choices for what has been typed so far: names that start with it first, then names that contain it.
export function matchSlash(items, typed) {
  const q = String(typed || '').toLowerCase();
  const starts = items.filter((i) => i.name.toLowerCase().startsWith(q) || i.name.toLowerCase().split(':').pop().startsWith(q));
  const has = items.filter((i) => !starts.includes(i) && (i.name.toLowerCase().includes(q) || (i.title || '').toLowerCase().includes(q)));
  return [...starts, ...has].slice(0, 12);
}

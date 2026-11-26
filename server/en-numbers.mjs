// Numbers as English words, for reading aloud. The natural voice reads small numbers, years, prices like $90,
// percents and times of day well in English, but stumbles on thousands (3200, 1,250), decimals (3.5 came out as
// thirty-five), phone numbers and version numbers. Those are spelled out here before an English text goes to it.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const BIG = ['', ' thousand', ' million', ' billion'];
const MONEY = { $: ['dollar', 'dollars', 'cent', 'cents'], '€': ['euro', 'euros', 'cent', 'cents'], '£': ['pound', 'pounds', 'penny', 'pence'] };

function below1000(n) {
  const out = [];
  if (n >= 100) out.push(`${ONES[Math.floor(n / 100)]} hundred`);
  const r = n % 100;
  if (r >= 20) out.push(TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : ''));
  else if (r > 0) out.push(ONES[r]);
  return out.join(' ');
}

// A whole number in words: 3200 → "three thousand two hundred".
export function cardinalEn(n) {
  n = Math.floor(Math.abs(Number(n)));
  if (!Number.isFinite(n) || n >= 1e12) return String(n);
  if (n === 0) return 'zero';
  const out = [];
  for (let level = 3; level >= 0; level--) {
    const part = Math.floor(n / 1000 ** level) % 1000;
    if (part) out.push(below1000(part) + BIG[level]);
  }
  return out.join(' ');
}

const byDigit = (s) => [...String(s).replace(/\D/g, '')].map((d) => ONES[Number(d)]).join(' ');
const plain = (s) => String(s).replace(/,/g, '');
// A whole number the way it is best read: as it stands when the voice reads it well (under a thousand, and
// four digits that look like a year), digit by digit when it is a code (zeros in front, very long), else in words.
function whole(s) {
  const raw = plain(s);
  if ((raw.length > 1 && raw.startsWith('0')) || raw.length > 12) return byDigit(raw);
  const n = Number(raw);
  if (n < 1000 || (raw === s && n >= 1100 && n <= 2099)) return raw;
  return cardinalEn(n);
}

/**
 * An English text with the numbers a voice stumbles on written out: "3200 prints" → "three thousand two hundred
 * prints", "3.5" → "3 point 5", "$1,250" → "one thousand two hundred fifty dollars", "555-0142" → "five five five,
 * zero one four two", "0.2.30" → "0 point 2 point 30".
 */
export function spellNumbersEn(text) {
  let s = String(text || '');
  const NUM = '\\d{1,3}(?:,\\d{3})+(?!\\d)|\\d+'; // 1,250 or 1250
  // A version or an address made of numbers and dots: part by part.
  s = s.replace(/(?<![\d.,\w])\d+(?:\.\d+){2,}(?![\d\w])/g, (m) => m.split('.').map(whole).join(' point '));
  // A phone number: digit by digit, with a breath between the groups.
  s = s.replace(/(?<![\d\w-])(?:\+?\d{1,2}[-.\s])?(?:\(\d{3}\)\s?|\d{3}[-.\s])?\d{3}[-.]\d{4}(?![\d\w-])/g, (m) => m.split(/[^\d]+/).filter(Boolean).map(byDigit).join(', '));
  // Money from a thousand up, or with cents: the sign becomes a word behind the number.
  s = s.replace(new RegExp(`([$€£])\\s?(${NUM})(?:\\.(\\d{2}))?(?![\\d.]*\\d)`, 'g'), (m, sign, w, cents) => {
    const n = Number(plain(w));
    const c = Number(cents || 0);
    if (n < 1000 && !c) return m;
    const names = MONEY[sign];
    return `${cardinalEn(n)} ${names[n === 1 ? 0 : 1]}${c ? ` and ${cardinalEn(c)} ${names[c === 1 ? 2 : 3]}` : ''}`;
  });
  // A number with a point: "3 point 5", "0 point 2 5".
  s = s.replace(new RegExp(`(?<![\\d.,\\w])(${NUM})\\.(\\d+)(?![\\d.]*\\d|\\w)`, 'g'), (m, a, b) => `${whole(a)} point ${b.length > 2 || b.startsWith('0') ? byDigit(b) : b}`);
  // Every other number.
  s = s.replace(new RegExp(`(?<![\\d.,\\w])(${NUM})(?![\\d\\w]|[.,:]\\d)`, 'g'), (m, a) => whole(a));
  return s;
}

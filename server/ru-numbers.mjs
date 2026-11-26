// Numbers as Russian words, for reading aloud. The natural voice reads many numbers wrongly when they are written in
// digits (90 came out as "nine hundred", 3200 as "thirty, two hundred"), and reads the same numbers correctly when
// they are written out. So before a Russian text goes to that voice, its numbers, dates, times, prices and the
// commonest units are spelled out here.

const ONES = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const ONES_GEN = ['нуля', 'одного', 'двух', 'трёх', 'четырёх', 'пяти', 'шести', 'семи', 'восьми', 'девяти', 'десяти', 'одиннадцати', 'двенадцати', 'тринадцати', 'четырнадцати', 'пятнадцати', 'шестнадцати', 'семнадцати', 'восемнадцати', 'девятнадцати'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const TENS_GEN = ['', '', 'двадцати', 'тридцати', 'сорока', 'пятидесяти', 'шестидесяти', 'семидесяти', 'восьмидесяти', 'девяноста'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const HUNDREDS_GEN = ['', 'ста', 'двухсот', 'трёхсот', 'четырёхсот', 'пятисот', 'шестисот', 'семисот', 'восьмисот', 'девятисот'];
// one, a few (2-4), many — in the nominative and in the genitive
const BIG = [
  null,
  { fem: true, nom: ['тысяча', 'тысячи', 'тысяч'], gen: ['тысячи', 'тысяч', 'тысяч'] },
  { nom: ['миллион', 'миллиона', 'миллионов'], gen: ['миллиона', 'миллионов', 'миллионов'] },
  { nom: ['миллиард', 'миллиарда', 'миллиардов'], gen: ['миллиарда', 'миллиардов', 'миллиардов'] },
];

// Which of the three forms goes with a number: 1 рубль, 3 рубля, 5 рублей, 11 рублей, 21 рубль.
export function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

// 1 to 999 in words. fem: "одна", "две" (for thousands).
function below1000(n, gen, fem) {
  const out = [];
  if (n >= 100) out.push((gen ? HUNDREDS_GEN : HUNDREDS)[Math.floor(n / 100)]);
  const r = n % 100;
  const unit = (u) => {
    if (fem && u === 1) return gen ? 'одной' : 'одна';
    if (fem && u === 2) return gen ? 'двух' : 'две';
    return (gen ? ONES_GEN : ONES)[u];
  };
  if (r >= 20) {
    out.push((gen ? TENS_GEN : TENS)[Math.floor(r / 10)]);
    if (r % 10) out.push(unit(r % 10));
  } else if (r > 0) out.push(unit(r));
  return out;
}

// A whole number in words: "девяносто", or in the genitive "девяноста" (after «около», «до», «более»…).
export function cardinal(n, { gen = false, fem = false } = {}) {
  n = Math.floor(Math.abs(Number(n)));
  if (!Number.isFinite(n) || n >= 1e12) return String(n);
  if (n === 0) return gen ? 'нуля' : 'ноль';
  const out = [];
  for (let level = 3; level >= 0; level--) {
    const part = Math.floor(n / 1000 ** level) % 1000;
    if (!part) continue;
    if (level === 0) out.push(...below1000(part, gen, fem));
    else {
      const big = BIG[level];
      // People say «тысяча пятьсот», not «одна тысяча пятьсот».
      if (!(level === 1 && part === 1 && n < 2000)) out.push(...below1000(part, gen, Boolean(big.fem)));
      out.push(plural(part, gen ? big.gen : big.nom));
    }
  }
  return out.join(' ');
}

// "Which one": first, second… The stems of 1-19 and of the tens; the ending depends on the case.
const ORD = ['нулев', 'перв', 'втор', 'трет', 'четвёрт', 'пят', 'шест', 'седьм', 'восьм', 'девят', 'десят', 'одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат', 'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат'];
const ORD_TENS = ['', '', 'двадцат', 'тридцат', 'сороков', 'пятидесят', 'шестидесят', 'семидесят', 'восьмидесят', 'девяност'];
const ORD_HUNDREDS = ['', 'сот', 'двухсот', 'трёхсот', 'четырёхсот', 'пятисот', 'шестисот', 'семисот', 'восьмисот', 'девятисот'];
const stressedEnd = new Set(['нулев', 'втор', 'шест', 'седьм', 'восьм', 'сороков']);
function ordEnd(stem, kase) {
  if (stem === 'трет') return { nom: 'третий', gen: 'третьего', prep: 'третьем' }[kase];
  if (kase === 'nom') return stem + (stressedEnd.has(stem) ? 'ой' : 'ый');
  return stem + (kase === 'gen' ? 'ого' : 'ом');
}

// A number as "which one", up to 9999: 24 → «двадцать четвёртого» (gen), 2026 → «две тысячи двадцать шестой» (nom).
export function ordinal(n, kase = 'nom') {
  n = Math.floor(Math.abs(Number(n)));
  if (!Number.isFinite(n) || n > 9999) return cardinal(n);
  const r = n % 100;
  const head = n - r; // the hundreds and thousands before the last part
  if (r === 0) {
    if (n === 0) return ordEnd(ORD[0], kase);
    const h = Math.floor(n / 100) % 10;
    const th = Math.floor(n / 1000);
    if (h) return [th ? cardinal(th * 1000) : '', ordEnd(ORD_HUNDREDS[h], kase)].filter(Boolean).join(' ');
    // a round thousand: «тысячный», «двухтысячный»
    return ordEnd(`${th === 1 ? '' : ONES_GEN[th]}тысячн`, kase);
  }
  const words = head ? [cardinal(head)] : [];
  if (r < 20) words.push(ordEnd(ORD[r], kase));
  else {
    if (r % 10) words.push(TENS[Math.floor(r / 10)], ordEnd(ORD[r % 10], kase));
    else words.push(ordEnd(ORD_TENS[r / 10], kase));
  }
  return words.join(' ');
}

const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
const GEN_BEFORE = 'около|от|до|более|менее|больше|меньше|свыше|порядка|после|без|из|для|дороже|дешевле|выше|ниже|не более|не менее';
// Units written short after a number: [one, a few, many] and [the genitive forms]
const UNITS = {
  см: ['сантиметр', 'сантиметра', 'сантиметров'],
  мм: ['миллиметр', 'миллиметра', 'миллиметров'],
  м: ['метр', 'метра', 'метров'],
  км: ['километр', 'километра', 'километров'],
  кг: ['килограмм', 'килограмма', 'килограммов'],
  г: ['грамм', 'грамма', 'граммов'],
  л: ['литр', 'литра', 'литров'],
  мл: ['миллилитр', 'миллилитра', 'миллилитров'],
  шт: ['штука', 'штуки', 'штук'],
  руб: ['рубль', 'рубля', 'рублей'],
  р: ['рубль', 'рубля', 'рублей'],
  тыс: ['тысяча', 'тысячи', 'тысяч'],
  млн: ['миллион', 'миллиона', 'миллионов'],
  мин: ['минута', 'минуты', 'минут'],
  сек: ['секунда', 'секунды', 'секунд'],
  ч: ['час', 'часа', 'часов'],
};
const MONEY = { $: ['доллар', 'доллара', 'долларов'], '€': ['евро', 'евро', 'евро'], '₽': ['рубль', 'рубля', 'рублей'], '£': ['фунт', 'фунта', 'фунтов'] };
const FEM_UNITS = new Set(['штука', 'тысяча', 'минута', 'секунда']);
const PARTS = [null, ['десятая', 'десятых'], ['сотая', 'сотых'], ['тысячная', 'тысячных']];

const digits = (s) => String(s).replace(/[\s\u00a0\u202f]/g, '');
const one = (n) => n % 10 === 1 && n % 100 !== 11;
// "3,5" → «три целых пять десятых»; with more than three digits after the comma they are read one by one.
function decimal(whole, frac, gen) {
  const w = Number(digits(whole));
  if (frac.length > 3) return `${cardinal(w, { gen })} и ${[...frac].map((d) => ONES[Number(d)]).join(' ')}`;
  const f = Number(frac);
  return `${cardinal(w, { gen, fem: true })} ${one(w) ? 'целая' : 'целых'} ${cardinal(f, { fem: true })} ${PARTS[frac.length][one(f) ? 0 : 1]}`;
}

// «одна минута», «две недели», «одной минуты»: the word after the number shows whether it is a "she".
function sheWord(next, n, gen) {
  const w = String(next || '').toLowerCase();
  if (!w || !/^[а-яё]+$/.test(w)) return false;
  if (n % 10 === 1 && n % 100 !== 11) return gen ? /[ыи]$/.test(w) : /[ая]$/.test(w);
  if (n % 10 === 2 && n % 100 !== 12) return !gen && /[ыи]$/.test(w);
  return false;
}

/**
 * A Russian text with its numbers written out in words, so that a voice reads them the way a person would:
 * «около 90 долларов» → «около девяноста долларов», «24 ноября 2026 года» → «двадцать четвёртого ноября две тысячи
 * двадцать шестого года», «в 10:30» → «в десять тридцать», «3,5 м» → «три целых пять десятых метра», «15%» →
 * «пятнадцать процентов», «$90» → «девяносто долларов».
 */
export function spellNumbers(text) {
  let s = String(text || '');
  const NUM = '\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+(?!\\d)|\\d+'; // 15 000 or 15000
  const PRE = `(?:(?<![\\p{L}])(${GEN_BEFORE})\\s+)?`; // «около», «до», «более»… put the number in the genitive
  const NOT_IN_WORD = '(?<![\\d.,\\p{L}])';
  // A version or an address made of numbers and dots (0.2.30) is read part by part.
  s = s.replace(/(?<![\d.,\p{L}])\d+(?:\.\d+){2,}(?![\d\p{L}])/gu, (m) => m.split('.').map((x) => cardinal(Number(x))).join(' точка '));
  // Money signs move behind the number: $90 → 90 $
  s = s.replace(new RegExp(`([$€₽£])\\s?((?:${NUM})(?:[.,]\\d+)?)`, 'gu'), '$2 $1');
  // Dates and years first: they are "which one", not "how many".
  s = s.replace(new RegExp(`${NOT_IN_WORD}(\\d{1,2})\\s+(${MONTHS})(?![\\p{L}])`, 'giu'), (m, d, mon) => `${ordinal(Number(d), 'gen')} ${mon}`);
  // «в 2024 г.» → «в две тысячи двадцать четвёртом году»; after a month or «с», «до», «от»… → «…четвёртого года».
  s = s.replace(new RegExp(`(?:(?<![\\p{L}])(${MONTHS}|в|во|с|до|от|после|около|начала|конца)\\s+)?${NOT_IN_WORD}((?:1[5-9]|20)\\d\\d)\\s+(году|года|год|г\\.)(?![\\p{L}])`, 'giu'), (m, before, y, word) => {
    const w = word.toLowerCase();
    const lead = before ? `${before} ` : '';
    if (w !== 'г.') return `${lead}${ordinal(Number(y), w === 'году' ? 'prep' : w === 'года' ? 'gen' : 'nom')} ${word}`;
    const b = String(before || '').toLowerCase();
    if (!b) return `${ordinal(Number(y), 'nom')} год`;
    return b === 'в' || b === 'во' ? `${lead}${ordinal(Number(y), 'prep')} году` : `${lead}${ordinal(Number(y), 'gen')} года`;
  });
  // The time of day: 10:30 → «десять тридцать», 9:05 → «девять ноль пять», 14:00 → «четырнадцать часов»;
  // after «с», «до», «после»… in the genitive: «с 9:00 до 18:30» → «с девяти до восемнадцати тридцати».
  s = s.replace(/(?:(?<![\p{L}])(с|до|после|около|от)\s+)?(?<![\d:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/giu, (m, pre, h, min) => {
    const hour = Number(h);
    const mins = Number(min);
    const lead = pre ? `${pre} ` : '';
    if (pre) return `${lead}${cardinal(hour, { gen: true })}${mins ? ` ${mins < 10 ? 'ноль ' : ''}${cardinal(mins, { gen: true })}` : ''}`;
    if (!mins) return `${cardinal(hour)} ${plural(hour, ['час', 'часа', 'часов'])}`;
    return `${cardinal(hour)} ${mins < 10 ? 'ноль ' : ''}${cardinal(mins)}`;
  });
  // A number with what it counts: a percent sign, a money sign or a short unit.
  const unitNames = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
  const counted = new RegExp(`${PRE}${NOT_IN_WORD}(${NUM})(?:[.,](\\d+))?\\s?(%|[$€₽£]|(?:${unitNames})(?![\\p{L}])\\.?)`, 'giu');
  s = s.replace(counted, (m, pre, whole, frac, unit, at, all) => {
    const gen = Boolean(pre);
    const n = Number(digits(whole));
    const key = unit.replace(/\.$/, '').toLowerCase();
    const forms = unit === '%' ? ['процент', 'процента', 'процентов'] : MONEY[unit] || UNITS[key];
    let noun;
    let words;
    if (frac) {
      words = decimal(whole, frac, gen);
      noun = forms[1]; // «три целых пять десятых метра»
    } else {
      // In the genitive every number but one takes the "many" form: «около двух метров», «до одного метра».
      noun = gen ? (one(n) ? forms[1] : forms[2]) : plural(n, forms);
      words = cardinal(n, { gen, fem: FEM_UNITS.has(forms[0]) });
    }
    // «21 шт. и 2 шт.»: the dot belongs to the short word; it stays only where the sentence ends too.
    const after = all.slice(at + m.length);
    const ends = unit.endsWith('.') && /^\s*(?:$|[\p{Lu}«"])/u.test(after);
    return `${pre ? `${pre} ` : ''}${words} ${noun}${ends ? '.' : ''}`;
  });
  // Every other number: after «около», «до», «более»… in the genitive, otherwise as it is named.
  const plainNum = new RegExp(`${PRE}${NOT_IN_WORD}(${NUM})(?:[.,](\\d+))?(?![\\d\\p{L}])(\\s+[\\p{L}]+)?`, 'giu');
  s = s.replace(plainNum, (m, pre, whole, frac, next = '') => {
    const raw = digits(whole);
    const gen = Boolean(pre);
    const lead = pre ? `${pre} ` : '';
    // A phone number, a code with zeros in front, or something very long: digit by digit.
    if ((raw.length >= 8 && raw === whole) || raw.length > 12 || (raw.length > 1 && raw.startsWith('0'))) return `${lead}${[...raw].map((d) => ONES[Number(d)]).join(' ')}${frac ? ` ${[...frac].map((d) => ONES[Number(d)]).join(' ')}` : ''}${next}`;
    const n = Number(raw);
    const words = frac ? decimal(whole, frac, gen) : cardinal(n, { gen, fem: sheWord(next.trim(), n, gen) });
    return `${lead}${words}${next}`;
  });
  return s.replace(/\s+/g, ' ').trim();
}

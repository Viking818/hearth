// What the Design page tells the model, and how the design is taken out of its answer. Kept apart from the page so
// tests can check it without a browser.
import { renderMarkdown } from './md.js';

export const FONTS_CYR = ['Montserrat', 'Oswald', 'Rubik', 'Unbounded', 'Manrope', 'Inter', 'Russo One', 'Comfortaa', 'Playfair Display', 'Roboto Slab', 'Lobster', 'Caveat', 'Pacifico', 'Press Start 2P', 'Rubik Mono One', 'Ubuntu'];
export const FONTS_LAT = ['Bebas Neue', 'Anton', 'Archivo Black', 'Permanent Marker', 'Bangers', 'Righteous', 'Abril Fatface', 'Space Grotesk'];

function brandText(b, logoIndex) {
  const bits = [];
  if (b.name) bits.push(`name “${b.name}”`);
  if (b.slogan) bits.push(`slogan “${b.slogan}”`);
  if (b.colors?.length) bits.push(`colours ${b.colors.join(', ')} (build the palette from them)`);
  if (b.headingFont) bits.push(`headings in ${b.headingFont}`);
  if (b.bodyFont) bits.push(`other text in ${b.bodyFont}`);
  if (logoIndex) bits.push(`its logo is {{image:${logoIndex}}} (place it where a logo belongs, not too big)`);
  if (b.notes) bits.push(`notes: ${b.notes}`);
  return bits.length ? `- The brand: ${bits.join('; ')}.` : '';
}

export function designSystem({ fmt, brand = null, images = [], logoIndex = 0 }) {
  return [
    `You are a senior graphic designer. You make one design: a single HTML file of exactly ${fmt.w}×${fmt.h} CSS pixels (${fmt.name}).`,
    `Keep this skeleton:\n<!doctype html><html><head><meta charset="utf-8"><!-- Google Fonts <link> tags --><style>/* your CSS */</style></head><body style="margin:0;${fmt.transparent ? 'background:transparent' : ''}"><div id="design" style="position:relative;width:${fmt.w}px;height:${fmt.h}px;overflow:hidden">…</div></body></html>`,
    'Rules:',
    '- HTML and CSS only, no JavaScript. Everything stays inside #design.',
    '- Make it look like the work of a top studio: one clear focal point, a strong hierarchy of type, generous margins (at least 6% of the width), a small palette with strong contrast. Every word must fit and be easy to read.',
    '- Decoration: CSS shapes, gradients, borders, shadows, inline SVG and emoji. Never pictures from the internet.',
    `- Fonts: Google Fonts with <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;800&display=swap" rel="stylesheet">. With Cyrillic (needed for Russian text): ${FONTS_CYR.join(', ')}. Latin only: ${FONTS_LAT.join(', ')}.`,
    ...(fmt.transparent ? ['- This is a print for a garment or a logo: keep the background transparent, with no colour behind the whole design (the shirt shows through). Bold shapes, thick lines, high contrast, no tiny text.'] : []),
    ...(images.length ? [`- Use these pictures, each written exactly like this in src (Hearth puts the real picture there): ${images.map((_, i) => `{{image:${i + 1}}}${logoIndex === i + 1 ? ' (the logo)' : ''}`).join(', ')}. For example <img src="{{image:1}}" style="object-fit:cover">; use contain for logos and cut-outs.`] : []),
    ...(brand ? [brandText(brand, logoIndex)].filter(Boolean) : []),
    'Answer with the complete file in one ```html block, then one short sentence on what you made. Write the design’s text in the language the user writes in, unless they ask for another.',
  ].join('\n');
}

// The HTML file in the model's answer (a ```html block, or the document itself).
export function htmlFrom(text = '') {
  const blocks = renderMarkdown(text).blocks.filter((b) => /^html?$/i.test(b.lang) || /^\s*(<!doctype|<html)/i.test(b.code));
  const b = blocks.at(-1);
  if (b && /<\/html>|id=["']design["']/i.test(b.code)) return b.code.trim();
  const m = /<!doctype html[\s\S]*?<\/html>/i.exec(text) || /<html[\s\S]*?<\/html>/i.exec(text);
  return m ? m[0].trim() : '';
}


'use strict';

// Browser-free text measurement. SVG text is laid out by the viewer, so the renderer cannot know
// exact glyph widths. Widths here are deliberately generous estimates for a common sans-serif
// face, so wrapped text stays inside its shape in any viewer. The same input always gives the
// same lines.

const FONT_SIZE_NODE = 14;
const FONT_SIZE_EDGE = 12;
const LINE_HEIGHT_RATIO = 1.3;

const NARROW = new Set("iIjl.,:;'|!`()[]{} ".split(''));
const WIDE = new Set('mwMW@%'.split(''));

function charEm(character) {
  const code = character.codePointAt(0);
  if (code >= 0x1100 && (code <= 0x11ff || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3ffff))) {
    return 1.05;
  }
  if (NARROW.has(character)) return 0.38;
  if (WIDE.has(character)) return 0.95;
  if (character >= 'A' && character <= 'Z') return 0.72;
  if (character >= '0' && character <= '9') return 0.6;
  return 0.58;
}

function measure(text, fontSize) {
  let em = 0;
  for (const character of text) em += charEm(character);
  return Math.ceil(em * fontSize);
}

// Splits a word that is wider than the line so that no single piece exceeds `maxWidth`.
function breakWord(word, maxWidth, fontSize) {
  const pieces = [];
  let current = '';
  for (const character of word) {
    if (current && measure(current + character, fontSize) > maxWidth) {
      pieces.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function ellipsize(line, maxWidth, fontSize) {
  let text = line;
  while (text && measure(`${text}…`, fontSize) > maxWidth) text = Array.from(text).slice(0, -1).join('');
  return `${text}…`;
}

/**
 * Wraps `text` into at most `maxLines` lines no wider than `maxWidth` (estimated pixels). Text that
 * does not fit ends with an ellipsis. Returns { lines, truncated, width } where width is the
 * widest estimated line.
 */
function wrap(text, { maxWidth, maxLines, fontSize }) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    for (const piece of measure(word, fontSize) > maxWidth ? breakWord(word, maxWidth, fontSize) : [word]) {
      const joined = line ? `${line} ${piece}` : piece;
      if (line && measure(joined, fontSize) > maxWidth) {
        lines.push(line);
        line = piece;
      } else {
        line = joined;
      }
    }
  }
  if (line) lines.push(line);
  let truncated = false;
  if (lines.length > maxLines) {
    truncated = true;
    lines.length = maxLines;
    lines[maxLines - 1] = ellipsize(lines[maxLines - 1], maxWidth, fontSize);
  }
  return { lines, truncated, width: Math.max(0, ...lines.map((item) => measure(item, fontSize))) };
}

module.exports = { FONT_SIZE_NODE, FONT_SIZE_EDGE, LINE_HEIGHT_RATIO, measure, wrap };

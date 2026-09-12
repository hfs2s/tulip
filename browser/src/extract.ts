/**
 * Readable text from a rendered DOM, without a parser dependency.
 *
 * The input is Chromium's own serialisation (`--dump-dom`), not the page's
 * source. That matters for what this can get away with: every element is
 * closed, attributes are quoted, and scripts have already run, so a handful of
 * linear regular expressions produce the text a person would read. It is not
 * an HTML parser and does not try to be one — it is a text reducer for a
 * well-formed document, and every expression in it is linear in its input.
 *
 * What goes: script, style, noscript, svg and template bodies, comments, and
 * the whole of `<head>` once the title has been taken from it. What stays is
 * text, with block-level boundaries turned into line breaks so a page still
 * reads as paragraphs and list items rather than one run-on line.
 *
 * Control characters are stripped on the way out. The text ends up printed into
 * the agent's terminal, and a page is exactly the kind of author who would put
 * an escape sequence in it. The bridge strips them again on receipt, because it
 * cannot assume this process was not compromised by the page it just rendered.
 */
import { BROWSE_MAX_TEXT, BROWSE_MAX_TITLE, stripControls } from '@2lp/shared/browse';

export interface Extracted {
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * Elements whose content is never text a reader sees. `title` is among them
 * because it has already been taken as the title: Chromium keeps it in
 * `<head>`, but a `<title>` inside an SVG or a malformed page would otherwise
 * be repeated as the first line of the text.
 */
const INVISIBLE = /<(script|style|noscript|svg|template|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Tags that begin or end a visual block. Each becomes a line break.
 *
 * Table cells are separated by a space instead: a row of cells reads better
 * as a line than as a column.
 */
const BLOCK =
  /<\/?(?:address|article|aside|blockquote|br|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|option|p|pre|section|summary|table|tbody|thead|tfoot|tr|ul)\b[^>]*>/gi;
const CELL = /<\/?(?:td|th)\b[^>]*>/gi;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  middot: '·',
  bull: '•',
};

const REPLACEMENT = '\uFFFD';

/** One code point from a numeric reference, or U+FFFD for anything illegal. */
function fromCodePoint(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff) return REPLACEMENT;
  if (value >= 0xd800 && value <= 0xdfff) return REPLACEMENT;
  return String.fromCodePoint(value);
}

/** Decode the common named references and every numeric one. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      return fromCodePoint(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Collapse runs of spaces, trim each line, and allow at most one blank line. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTitle(dom: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(dom);
  if (!match?.[1]) return '';
  const title = stripControls(decodeEntities(match[1].replace(/<[^>]*>/g, '')))
    .replace(/\s+/g, ' ')
    .trim();
  return title.slice(0, BROWSE_MAX_TITLE);
}

export function extractReadable(dom: string, maxChars = BROWSE_MAX_TEXT): Extracted {
  const title = extractTitle(dom);

  const body = dom
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(INVISIBLE, '')
    // `\b` keeps this from matching <header>.
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .replace(BLOCK, '\n')
    .replace(CELL, ' ')
    .replace(/<[^>]*>/g, '');

  const text = tidy(stripControls(decodeEntities(body)));
  if (text.length <= maxChars) return { title, text, truncated: false };
  return { title, text: text.slice(0, maxChars), truncated: true };
}

/**
 * The text reducer is the only thing standing between a rendered page and the
 * agent's context, so what is worth testing is what it keeps out: script
 * bodies, styles, hidden templates, and characters that could drive the
 * terminal the text is printed into.
 */
import { describe, expect, it } from 'vitest';
import { stripControls } from '@2lp/shared/browse';
import { decodeEntities, extractReadable, extractTitle } from '../src/extract.js';

const ESC = String.fromCharCode(0x1b);
const RLO = String.fromCharCode(0x202e);
const NBSP = String.fromCharCode(0xa0);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe('extractReadable', () => {
  const dom =
    '<html><head><title>Juan &amp; Co</title><style>body{color:red}</style>' +
    '<script>alert("head")</script></head><body>' +
    '<header>Menu</header><p>Hello <b>world</b></p>' +
    '<script>var x = "<p>not text</p>";</script>' +
    '<noscript>Enable JavaScript</noscript><svg><text>chart label</text></svg>' +
    '<template><p>later</p></template><!-- a comment -->' +
    '<div>Second</div></body></html>';

  it('keeps what a reader sees, as lines', () => {
    const r = extractReadable(dom);
    expect(r.title).toBe('Juan & Co');
    expect(r.text).toBe('Menu\n\nHello world\n\nSecond');
    expect(r.truncated).toBe(false);
  });

  it.each(['alert', 'not text', 'Enable JavaScript', 'chart label', 'later', 'a comment', 'color:red'])(
    'drops %s',
    (hidden) => {
      expect(extractReadable(dom).text).not.toContain(hidden);
    },
  );

  it('does not repeat the title as text when it sits outside <head>', () => {
    expect(extractReadable('<title>T</title><p>hi</p>')).toEqual({ title: 'T', text: 'hi', truncated: false });
  });

  it('does not mistake <header> for <head>', () => {
    expect(extractReadable('<body><header>Top of page</header></body>').text).toBe('Top of page');
  });

  it('puts table cells side by side and rows on lines of their own', () => {
    const table = '<table><tr><td>Name</td><td>Price</td></tr><tr><td>Tulip</td><td>3</td></tr></table>';
    // A row boundary is two block breaks, `</tr><tr>`, so rows are spaced like
    // paragraphs. What matters is that a row's cells stay on one line.
    expect(extractReadable(table).text).toBe('Name Price\n\nTulip 3');
  });

  it('decodes entities after tags are gone, so escaped markup stays text', () => {
    expect(extractReadable('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>').text).toBe('<script>alert(1)</script>');
  });

  it('collapses whitespace, including non-breaking spaces, and blank-line runs', () => {
    const r = extractReadable(`<p>  a${NBSP}${NBSP} b  </p>\n\n\n\n<p>c</p>`);
    expect(r.text).toBe('a b\n\nc');
  });

  it('strips terminal escapes and bidirectional overrides from page text', () => {
    const r = extractReadable(`<p>safe${ESC}[31mred ${RLO}txet</p>`);
    expect(r.text).toBe('safe[31mred txet');
  });

  it('caps the text and says so', () => {
    const r = extractReadable(`<p>${'word '.repeat(100)}</p>`, 50);
    expect(r.text).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it('copes with an empty document', () => {
    expect(extractReadable('')).toEqual({ title: '', text: '', truncated: false });
  });
});

describe('extractTitle', () => {
  it('is empty when there is none', () => {
    expect(extractTitle('<html><body>x</body></html>')).toBe('');
  });

  it('collapses whitespace and strips controls', () => {
    expect(extractTitle(`<title>\n  Juan's${ESC}\n  page </title>`)).toBe("Juan's page");
  });

  it('is capped', () => {
    expect(extractTitle(`<title>${'t'.repeat(1000)}</title>`)).toHaveLength(300);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric references', () => {
    expect(decodeEntities('&amp; &quot; &#39; &#8364; &#x1F337; &mdash;')).toBe('& " \' € 🌷 —');
  });

  it('replaces references that name no legal character', () => {
    expect(decodeEntities('&#0;')).toBe(REPLACEMENT);
    expect(decodeEntities('&#xD800;')).toBe(REPLACEMENT);
    expect(decodeEntities('&#x110000;')).toBe(REPLACEMENT);
  });

  it('leaves unknown names alone', () => {
    expect(decodeEntities('&notathing;')).toBe('&notathing;');
  });
});

describe('stripControls', () => {
  it('keeps newlines and tabs and removes the rest of C0, DEL and C1', () => {
    const input = ['a', '\n', '\t', String.fromCharCode(0), String.fromCharCode(0x7f), String.fromCharCode(0x9b), 'b'];
    expect(stripControls(input.join(''))).toBe('a\n\tb');
  });
});

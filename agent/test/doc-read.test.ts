/**
 * Choosing how to read a document a stranger sent.
 *
 * The dispatcher never builds a command from the filename — the tool and its
 * flags come from a fixed table and the path travels as one argument — so the
 * risk here is not injection. It is honesty: a format claimed and then read as
 * gibberish is worse than a refusal, because the agent will believe the
 * gibberish and answer from it.
 */
import { describe, expect, it } from 'vitest';
import { MAX_CHARS, cap, planFor, xmlToText } from '../src/doc-read.js';

describe('planFor — what it reads', () => {
  it('sends a PDF to pdftotext, laid out', () => {
    const plan = planFor('/handoff/in/media/17f1f7d2c1a600d2/deck.pdf');
    expect(plan.ok && plan.how).toBe('run');
    // Without -layout a two-column page interleaves into nonsense.
    expect(plan.ok && plan.how === 'run' && plan.argv).toContain('-layout');
    expect(plan.ok && plan.how === 'run' && plan.argv[0]).toBe('pdftotext');
  });

  it('reads text formats directly rather than shelling out', () => {
    for (const name of ['notes.txt', 'export.csv', 'data.json', 'README.md', 'server.log']) {
      expect(planFor(name).ok && planFor(name).how, name).toBe('text');
    }
  });

  it('unzips the office formats', () => {
    expect(planFor('report.docx').ok && planFor('report.docx').how).toBe('zipXml');
    expect(planFor('deck.pptx').ok && planFor('deck.pptx').how).toBe('zipXml');
    expect(planFor('book.xlsx').ok && planFor('book.xlsx').how).toBe('zipXml');
  });

  it('is not fooled by capitals', () => {
    expect(planFor('SCAN.PDF').ok && planFor('SCAN.PDF').how).toBe('run');
  });

  it('takes the last extension, not the first', () => {
    // `invoice.pdf.txt` is a text file. Reading it as a PDF would fail loudly,
    // which is fine, but reading it as text is right.
    expect(planFor('invoice.pdf.txt').ok && planFor('invoice.pdf.txt').how).toBe('text');
  });
});

describe('planFor — what it refuses, and how it says so', () => {
  it('refuses the pre-2007 Office formats with the fix in hand', () => {
    const plan = planFor('old.doc');
    expect(plan.ok).toBe(false);
    // The refusal has to tell the agent what to ask for, or it relays "I can't"
    // and the person is no further forward.
    expect(!plan.ok && plan.reason).toContain('PDF');
  });

  it('refuses an archive as not being a document', () => {
    expect(planFor('bundle.zip').ok).toBe(false);
    expect(planFor('bundle.7z').ok).toBe(false);
  });

  it('refuses a file with no extension rather than guessing', () => {
    expect(planFor('/handoff/in/media/abc/file').ok).toBe(false);
  });

  it('refuses an unknown format by name', () => {
    const plan = planFor('drawing.dwg');
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain('.dwg');
  });

  it('never names a tool in a refusal', () => {
    // The agent relays these to a person. "pdftotext failed" means nothing to
    // somebody who sent a file from their phone.
    for (const name of ['old.doc', 'bundle.zip', 'drawing.dwg', 'noext']) {
      const plan = planFor(name);
      expect(!plan.ok && plan.reason, name).not.toMatch(/pdftotext|unzip|poppler/);
    }
  });
});

describe('xmlToText', () => {
  it('keeps paragraphs apart', () => {
    const xml = '<w:p><w:r><w:t>First line</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p>';
    expect(xmlToText(xml)).toBe('First line\nSecond line');
  });

  it('turns a line break into one', () => {
    expect(xmlToText('<w:p><w:t>a</w:t><w:br/><w:t>b</w:t></w:p>')).toBe('a\nb');
  });

  it('decodes entities after the tags are gone, not before', () => {
    // Otherwise a decoded `&lt;` becomes a `<` and the tag stripper eats the
    // text after it.
    expect(xmlToText('<w:p><w:t>if a &lt; b &amp;&amp; c &gt; d</w:t></w:p>')).toBe('if a < b && c > d');
  });

  it('drops an empty self-closing paragraph, which carries no line', () => {
    // `<w:p/>` has no closing tag, so it contributes nothing — right, because
    // it is layout rather than a blank line somebody typed.
    expect(xmlToText('<w:p><w:t>a</w:t></w:p><w:p/><w:p/><w:p><w:t>b</w:t></w:p>')).toBe('a\nb');
  });

  it('collapses a run of real blank paragraphs to one gap', () => {
    // `<w:p></w:p>` is the form Word writes for an empty line, and three of
    // them in a row should not become three blank lines in the output.
    expect(xmlToText('<w:p><w:t>a</w:t></w:p><w:p></w:p><w:p></w:p><w:p><w:t>b</w:t></w:p>')).toBe('a\n\nb');
  });

  it('returns nothing for markup with no words in it', () => {
    expect(xmlToText('<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>')).toBe('');
  });
});

describe('cap', () => {
  it('leaves a normal document alone', () => {
    expect(cap('a short note')).toBe('a short note');
  });

  it('says it truncated rather than doing it silently', () => {
    // A document cut off without a word is one the agent will answer from as
    // though it had read the end.
    const capped = cap('x'.repeat(MAX_CHARS + 500));
    expect(capped).toContain('truncated');
    expect(capped).toContain('Ask for a specific part');
  });

  it('keeps the beginning, which is where a document says what it is', () => {
    expect(cap(`START${'x'.repeat(MAX_CHARS)}`).startsWith('START')).toBe(true);
  });
});

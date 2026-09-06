/**
 * Turning a document somebody sent into text the agent can read.
 *
 * Documents already arrive — `document` is an accepted media kind and the file
 * lands on the inbound volume — but a PDF on disk that nothing can open is the
 * same as no PDF at all. Tulip could see the filename and say so, and that was
 * the whole of it.
 *
 * **The conversion runs in the agent container, deliberately.** The instinct is
 * to keep hostile parsing away from the agent; here it is the reverse. Document
 * parsers are C libraries with a long history of memory-safety bugs, and the
 * input is a file chosen by a stranger. The agent container is the right place
 * for that: `internal: true` network with no route out, read-only rootfs, every
 * capability dropped, non-root, no setuid binaries. An exploit against poppler
 * there gains an attacker nothing the agent does not already have, because the
 * agent runs arbitrary code by design. The bridge is where it would be
 * dangerous — that container holds the WhatsApp credentials.
 *
 * So this is a dispatcher, not a parser. It decides *which* tool, refuses what
 * it cannot honestly handle, and caps what comes back; the tools do the work.
 */
import { extname } from 'node:path';

/** Beyond this a document stops being context and starts being the context. */
export const MAX_CHARS = 40_000;

export type ReadPlan =
  | { readonly ok: true; readonly how: 'text' }
  | { readonly ok: true; readonly how: 'run'; readonly argv: readonly string[] }
  | { readonly ok: true; readonly how: 'zipXml'; readonly parts: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Formats that are already text.
 *
 * Read directly rather than shelled out to, which matters for the ones a person
 * is most likely to send: a CSV export, a log, a note.
 */
const PLAIN = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml', '.html', '.htm']);

/**
 * Office formats, which are a zip of XML.
 *
 * Extracted with `unzip` and stripped of tags rather than parsed properly. That
 * is crude and it is the honest trade: a real parser for these is a large
 * dependency, and what an agent needs from a document a stranger sent is its
 * words in order, not its formatting. Tables come out as runs of text.
 */
const ZIP_XML: Readonly<Record<string, readonly string[]>> = {
  '.docx': ['word/document.xml'],
  '.odt': ['content.xml'],
  '.pptx': ['ppt/slides/slide*.xml'],
  '.xlsx': ['xl/sharedStrings.xml', 'xl/worksheets/sheet*.xml'],
};

/**
 * What to do with a file, by extension.
 *
 * Extension rather than magic bytes, and it is worth saying why that is enough:
 * getting this wrong produces gibberish or an error, never an unsafe action.
 * The tools are chosen from a fixed table and never built from the filename, so
 * a file called `x.pdf;rm -rf` names a tool exactly as well as `x.pdf` does —
 * which is to say it names `pdftotext`, with the path as one argument.
 */
export function planFor(path: string): ReadPlan {
  const ext = extname(path).toLowerCase();

  if (PLAIN.has(ext)) return { ok: true, how: 'text' };

  if (ext === '.pdf') {
    // `-layout` keeps columns and tables roughly where they were; without it a
    // two-column page interleaves into nonsense. `-` writes to stdout.
    return { ok: true, how: 'run', argv: ['pdftotext', '-layout', '-nopgbrk', path, '-'] };
  }

  const parts = ZIP_XML[ext];
  if (parts !== undefined) return { ok: true, how: 'zipXml', parts };

  if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
    return {
      ok: false,
      reason:
        `${ext} is the pre-2007 Office format, which nothing here reads. Ask for it as a PDF or a ` +
        `${ext}x, which most people can export in a couple of clicks.`,
    };
  }
  if (ext === '.zip' || ext === '.rar' || ext === '.7z') {
    return { ok: false, reason: 'An archive is not a document. Ask for the file inside it.' };
  }
  if (ext === '') {
    return { ok: false, reason: 'That file has no extension, so there is no way to tell what it is.' };
  }
  return {
    ok: false,
    reason: `Nothing here reads ${ext}. Say so plainly and ask for a PDF, a plain text file, or the words themselves.`,
  };
}

/**
 * XML to readable text.
 *
 * Paragraph and row boundaries become newlines before the tags go, or a
 * document arrives as one continuous sentence tens of thousands of characters
 * long. Entities are decoded last so a `&lt;` in the text cannot be mistaken
 * for a tag on the way through.
 */
export function xmlToText(xml: string): string {
  return xml
    .replace(/<\/(w:p|text:p|a:p|row|si)>/g, '\n')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cap the result, saying so rather than truncating silently. */
export function cap(text: string, max = MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[…truncated at ${max} characters. Ask for a specific part if you need more.]`;
}

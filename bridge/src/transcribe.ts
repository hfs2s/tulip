/**
 * Turning a voice note into words the agent can read.
 *
 * The agent is a Claude Code session: it can open an image and look at it, and
 * it cannot listen to anything. So a voice note arrived as a file it could do
 * nothing with, and somebody who spoke rather than typed got an answer that
 * ignored what they had said — or no answer at all, which is what actually
 * happened for as long as the gate refused them.
 *
 * **This is the one capability MiniMax cannot provide.** Every plausible
 * transcription endpoint on that account returns 404; it is a synthesis
 * provider, not a recognition one. So this is the single deliberate exception
 * to "MiniMax is the only approved audio provider", and it is narrow: OpenAI is
 * asked to turn one file into one string and is used for nothing else.
 *
 * Built the same way as every other capability here — the **bridge** performs
 * it and the agent only ever sees the result. `OPENAI_API_KEY` never enters the
 * container that runs with permissions bypassed, and `tulip-lan` gains no
 * reachable host.
 *
 * The cost is worth stating plainly, because it is a change to what leaves this
 * box: a stranger's voice reaches OpenAI. Nothing else about them does — no
 * phone number, no chat key, no name, just the audio and only when the message
 * was accepted. See THREAT-MODEL.md §T2.
 */
import { readFileSync, statSync } from 'node:fs';
import { log } from './log.js';

const TIMEOUT_MS = 90_000;
/** The provider's own ceiling. Anything larger is refused there, so refuse here. */
const MAX_BYTES = 25 * 1024 * 1024;
/**
 * Transcription is billed by the minute and this number answers anyone, so a
 * very long recording is a cost attack rather than a message. Ten minutes is far
 * beyond any real voice note.
 */
const MAX_SECONDS = 600;

export type Transcript = { ok: true; text: string } | { ok: false; error: string };

function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** Whether transcription is configured at all. Cheap, so callers can skip the work. */
export function canTranscribe(): boolean {
  return env('OPENAI_API_KEY').length > 0;
}

/**
 * Transcribe one audio file.
 *
 * Never throws. A failure returns a reason the caller can hand to the agent as
 * words, because "they sent a voice note and it could not be read" is something
 * the agent can respond to honestly, and silence is not.
 */
export async function transcribe(
  file: string,
  mimetype: string | null,
  seconds: number | null,
): Promise<Transcript> {
  const key = env('OPENAI_API_KEY');
  if (key.length === 0) return { ok: false, error: 'no transcription is configured' };
  if (typeof seconds === 'number' && seconds > MAX_SECONDS) {
    return { ok: false, error: `the recording is longer than ${String(MAX_SECONDS)} seconds` };
  }

  let bytes: Buffer;
  try {
    if (statSync(file).size > MAX_BYTES) return { ok: false, error: 'the recording is too large to transcribe' };
    bytes = readFileSync(file);
  } catch (err) {
    return { ok: false, error: `the recording could not be read (${(err as Error).name})` };
  }
  if (bytes.length === 0) return { ok: false, error: 'the recording was empty' };

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimetype ?? 'audio/ogg' }), 'note.ogg');
  form.append('model', env('OPENAI_TRANSCRIBE_MODEL', 'whisper-1'));

  let response: Response;
  try {
    response = await fetch(`${env('OPENAI_BASE_URL', 'https://api.openai.com')}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `transcription failed (${(err as Error).name})` };
  }
  if (!response.ok) return { ok: false, error: `the transcription service returned ${String(response.status)}` };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'the transcription service returned something unreadable' };
  }

  const text = (payload as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'nothing could be made out' };
  }
  log('transcribe.done', { seconds, chars: text.length });
  // Capped for the same reason every inbound string is: it is going into a
  // prompt, and length is the one property a sender controls for free.
  return { ok: true, text: text.trim().slice(0, 4000) };
}

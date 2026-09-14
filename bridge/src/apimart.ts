/**
 * Image generation through APIMart, with reference images.
 *
 * The reason to have a second provider at all is the references. MiniMax takes
 * a prompt and nothing else, so "make this one look like a poster" — with a
 * photo somebody just sent — cannot be asked for. APIMart's `gpt-image-2`
 * takes up to sixteen reference images alongside the prompt, which is the
 * difference between describing a picture and working from one.
 *
 * Two calls rather than one: the POST returns a task id and the picture only
 * exists once the task reports `completed`. The result URL expires, so the
 * bytes are pulled here and handed back as a buffer — the same shape MiniMax
 * returns, so the outbox does not learn which provider it is talking to.
 *
 * The key never leaves this side, as with every other credential: the agent
 * asks for a picture and the bridge is what holds the account.
 */
import { readFileSync } from 'node:fs';
import { log } from './log.js';

export type Produced = { ok: true; data: Buffer } | { ok: false; error: string };

const BASE = 'https://api.apimart.ai';
/** The task usually lands inside a minute; a turn should not hang on a bad one. */
const TIMEOUT_MS = 180_000;
const POLL_MS = 3_000;
/** What the provider accepts. More than this and the request is refused whole. */
export const MAX_REFERENCES = 16;
/** Each reference is inlined as base64, so a large photo is a large request. */
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

const key = (): string => (process.env['APIMART_API_KEY'] ?? '').trim();
const model = (): string => (process.env['APIMART_IMAGE_MODEL'] ?? 'gpt-image-2').trim();
const size = (): string => (process.env['APIMART_IMAGE_SIZE'] ?? '1:1').trim();
const resolution = (): string => (process.env['APIMART_IMAGE_RESOLUTION'] ?? '2k').trim();

export function configured(): boolean {
  return key().length > 0;
}

/**
 * A reference image, as the provider wants it.
 *
 * Base64 rather than a URL, deliberately: the photos worth working from are
 * the ones somebody just sent, and those live on a volume with no public
 * address. Handing the provider a link would mean publishing them first.
 */
function inline(path: string): string | null {
  try {
    const bytes = readFileSync(path);
    if (bytes.length === 0 || bytes.length > MAX_REFERENCE_BYTES) return null;
    const kind = bytes.subarray(0, 4).toString('hex');
    const mime = kind.startsWith('89504e47') ? 'image/png' : kind.startsWith('ffd8') ? 'image/jpeg' : null;
    if (mime === null) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

async function call(url: string, init: RequestInit): Promise<unknown> {
  const reply = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key()}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await reply.json().catch(() => null);
  if (!reply.ok) {
    const said = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`${String(reply.status)}${said === undefined ? '' : `: ${said.slice(0, 160)}`}`);
  }
  return body;
}

/**
 * Make a picture, optionally working from photos already in hand.
 *
 * Never throws: every outcome is something the outbox can tell somebody.
 */
export async function generateImage(prompt: string, references: readonly string[] = []): Promise<Produced> {
  if (!configured()) return { ok: false, error: 'no APIMART_API_KEY is configured' };

  const inlined = references.slice(0, MAX_REFERENCES).map(inline).filter((r): r is string => r !== null);
  if (references.length > 0 && inlined.length === 0) {
    return { ok: false, error: 'none of those pictures could be read as a jpeg or png' };
  }

  const started = Date.now();
  try {
    const submitted = await call(`${BASE}/v1/images/generations`, {
      method: 'POST',
      body: JSON.stringify({
        model: model(),
        prompt: prompt.slice(0, 1000),
        n: 1,
        size: size(),
        resolution: resolution(),
        ...(inlined.length > 0 ? { image_urls: inlined } : {}),
      }),
    });
    const taskId = (submitted as { data?: Array<{ task_id?: string }> })?.data?.[0]?.task_id;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return { ok: false, error: 'the image service accepted the request but named no task' };
    }
    log('apimart.submitted', { model: model(), refs: inlined.length, taskId: taskId.slice(0, 12) });

    for (;;) {
      if (Date.now() - started > TIMEOUT_MS) {
        return { ok: false, error: 'the picture was not finished in time' };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
      const got = await call(`${BASE}/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' });
      const task = ((got as { data?: unknown })?.data ?? got) as {
        status?: string;
        error?: string;
        result?: { images?: Array<{ url?: string | string[] }> };
      };
      if (task.status === 'failed' || task.status === 'cancelled') {
        return { ok: false, error: `the image service ${task.status}: ${(task.error ?? 'no reason given').slice(0, 160)}` };
      }
      if (task.status !== 'completed') continue;

      // The URL is a list in some answers and a string in others.
      const first = task.result?.images?.[0]?.url;
      const url = Array.isArray(first) ? first[0] : first;
      if (typeof url !== 'string' || url.length === 0) {
        return { ok: false, error: 'the image service finished but returned no picture' };
      }
      // Downloaded rather than passed on: the link expires, and a link is not
      // a saved image once it has been sent to somebody.
      const picture = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!picture.ok) return { ok: false, error: `the finished picture could not be fetched (${String(picture.status)})` };
      const data = Buffer.from(await picture.arrayBuffer());
      log('apimart.done', { ms: Date.now() - started, bytes: data.length, refs: inlined.length });
      return { ok: true, data };
    }
  } catch (err) {
    const said = String((err as Error).message).slice(0, 180);
    log('apimart.failed', { note: said });
    return { ok: false, error: `the image service could not be reached (${said})` };
  }
}

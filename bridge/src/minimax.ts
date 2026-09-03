/**
 * Image generation and speech, performed by the bridge on the agent's behalf.
 *
 * The third capability built the same way as GIFs and web search, and for the
 * same reason: the agent has no network, so it names what it wants and the
 * trusted side produces it. The consequence worth stating is that
 * `MINIMAX_API_KEY` — a billed credential — never enters the container the
 * threat model assumes an attacker owns, and `tulip-lan` gains no reachable
 * host.
 *
 * These are the two capabilities Tulip originally dropped from Iris on the
 * grounds that a paid per-message feature reachable by the public is a
 * cost-denial-of-service. That reasoning has not changed; what changed is that
 * an operator wants them. So they are bounded rather than trusted: both spend
 * against the same per-turn and per-chat outbound allowance as any other send,
 * both are refused outright when no key is configured, and both fail into words
 * rather than into silence.
 */
import { log } from './log.js';

const TIMEOUT_MS = 120_000;
/** WhatsApp will not take an unbounded upload, and neither should we. */
const MAX_BYTES = 8 * 1024 * 1024;

export type Produced = { ok: true; data: Buffer } | { ok: false; error: string };

function key(): string {
  return process.env['MINIMAX_API_KEY'] ?? '';
}

/**
 * MiniMax's host differs by account region and has changed name; the group id
 * is required by the speech endpoint and not by images. Both are configuration
 * rather than constants so a move does not need a code change.
 */
function base(): string {
  return process.env['MINIMAX_BASE_URL'] ?? 'https://api.minimax.io';
}

/**
 * Generate an image.
 *
 * The prompt is agent-chosen text leaving the deployment, which is the same
 * residual channel that search opens and is bounded the same way — see
 * THREAT-MODEL.md §T2. The provider's own safety filtering is what stands
 * between a public bot and an image nobody wants; there is no local filter and
 * it would be dishonest to imply otherwise.
 */
export async function generateImage(prompt: string): Promise<Produced> {
  if (key().length === 0) return { ok: false, error: 'no MINIMAX_API_KEY is configured' };

  let response: Response;
  try {
    response = await fetch(`${base()}/v1/image_generation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key()}` },
      body: JSON.stringify({
        model: process.env['MINIMAX_IMAGE_MODEL'] ?? 'image-01',
        prompt: prompt.slice(0, 1000),
        n: 1,
        response_format: 'url',
        aspect_ratio: '1:1',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `image request failed (${(err as Error).name})` };
  }
  if (!response.ok) return { ok: false, error: `the image provider returned ${response.status}` };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'the image provider returned something unreadable' };
  }

  const url = firstImageUrl(payload);
  if (url === null) {
    log('minimax.imageShape', { note: 'no image url in the response' });
    return { ok: false, error: describeError(payload) ?? 'the image provider returned no image' };
  }
  return download(url);
}

/**
 * Speak a line and return an audio file ready to send as a voice note.
 *
 * Failure here is deliberately soft: the caller falls back to sending the same
 * words as text. A voice note that does not arrive should never cost somebody
 * their reply.
 */
export async function synthesise(text: string): Promise<Produced> {
  if (key().length === 0) return { ok: false, error: 'no MINIMAX_API_KEY is configured' };
  const group = process.env['MINIMAX_GROUP_ID'] ?? '';

  let response: Response;
  try {
    response = await fetch(`${base()}/v1/t2a_v2${group ? `?GroupId=${encodeURIComponent(group)}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key()}` },
      body: JSON.stringify({
        model: process.env['MINIMAX_VOICE_MODEL'] ?? 'speech-2.5-turbo-preview',
        text: text.slice(0, 2000),
        stream: false,
        // Opus in an OGG container is what WhatsApp wants for a voice note.
        audio_setting: { format: 'opus', sample_rate: 24_000, bitrate: 32_000, channel: 1 },
        voice_setting: {
          voice_id: process.env['MINIMAX_VOICE_ID'] ?? 'Spanish_ReliableMan',
          speed: 1,
          vol: 1,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `speech request failed (${(err as Error).name})` };
  }
  if (!response.ok) return { ok: false, error: `the speech provider returned ${response.status}` };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'the speech provider returned something unreadable' };
  }

  // The audio comes back hex-encoded in the JSON body rather than as a file.
  const hex = firstAudioHex(payload);
  if (hex === null) return { ok: false, error: describeError(payload) ?? 'the speech provider returned no audio' };

  const data = Buffer.from(hex, 'hex');
  if (data.length === 0) return { ok: false, error: 'the speech provider returned empty audio' };
  if (data.length > MAX_BYTES) return { ok: false, error: 'the audio is too large to send' };
  log('minimax.spoke', { bytes: data.length });
  return { ok: true, data };
}

async function download(url: string): Promise<Produced> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { ok: false, error: `image download returned ${response.status}` };
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) return { ok: false, error: 'the image was empty' };
    if (data.length > MAX_BYTES) return { ok: false, error: 'the image is too large to send' };
    log('minimax.image', { bytes: data.length });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `image download failed (${(err as Error).name})` };
  }
}

// ── Response shapes ──────────────────────────────────────────────────────────
// Walked defensively rather than typed. This is a third-party API whose shape
// has changed before, and a provider that returns something unexpected should
// degrade to "no picture" rather than throw inside the send loop.

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

function firstImageUrl(payload: unknown): string | null {
  const root = asRecord(payload);
  const data = asRecord(root?.['data']);
  const urls = data?.['image_urls'];
  if (Array.isArray(urls) && typeof urls[0] === 'string') return urls[0];
  const direct = root?.['image_urls'];
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return null;
}

function firstAudioHex(payload: unknown): string | null {
  const root = asRecord(payload);
  const data = asRecord(root?.['data']);
  const audio = data?.['audio'];
  if (typeof audio === 'string' && audio.length > 0) return audio;
  return null;
}

/** Surface the provider's own complaint when it has one. */
function describeError(payload: unknown): string | null {
  const root = asRecord(payload);
  const base = asRecord(root?.['base_resp']);
  const message = base?.['status_msg'];
  return typeof message === 'string' && message.length > 0 ? message.slice(0, 200) : null;
}

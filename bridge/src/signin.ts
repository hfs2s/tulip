/**
 * What a refused panel says, and how it says it.
 *
 * A 401 is where someone who belongs here is standing, locked out, reading for
 * the one fact that gets them in. Plain text answered a different question: it
 * described the bearer token, which is the fallback, and left the actual way in
 * unsaid. So this is a screen rather than a sentence, and it tells three
 * different truths because being refused has three different causes.
 *
 * It is rendered from this file's own literals — the only value from the
 * request that reaches the markup is the host, and it is checked against a
 * hostname shape before it is used or shown.
 */
import { AGENT_NAME } from './instance.js';
import { paths } from './paths.js';

/** Why this request was refused, which decides what there is to do about it. */
export type Refusal =
  /** No Access application issues assertions for this instance. */
  | { kind: 'off'; local: boolean }
  /** Sign-on is on, but the request never passed through it. */
  | { kind: 'bypassed'; publicHost: string | null }
  /** Sign-on is on and was passed through, yet no identity arrived. */
  | { kind: 'expired'; teamDomain: string; host: string | null };

/**
 * A hostname, or nothing.
 *
 * The Host header is written by whoever is calling, so it is not a name until
 * it looks like one. Anything else — an IP literal, a port, a stray character —
 * costs us only the convenience of a link.
 */
export function hostname(raw: string | undefined): string | null {
  const host = (raw ?? '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  return host.length <= 253 ? host : null;
}

/**
 * Which refusal this is.
 *
 * Cloudflare stamps `cf-ray` on everything it forwards, so its absence is a
 * plain statement that Access never saw this request — which is the common case
 * here, where the panels are also reachable over the tailnet. Distinguishing it
 * matters: told to sign in, someone on that path would try, and fail, and have
 * no way to know why.
 */
export function refusal(
  access: { teamDomain: string } | null,
  headers: { host?: string | undefined; ray?: string | undefined },
  publicHost: string | null,
): Refusal {
  const local = (headers.ray ?? '').trim().length === 0;
  // Where the token lives is not a secret, but it is not a stranger's business
  // either, and an instance with sign-on off is an instance reachable by
  // strangers. Cloudflare in the path means the caller came off the internet;
  // its absence means the tailnet, which is the only place the answer is of any
  // use anyway.
  if (access === null) return { kind: 'off', local };
  if ((headers.ray ?? '').trim().length === 0) return { kind: 'bypassed', publicHost };
  return { kind: 'expired', teamDomain: access.teamDomain, host: hostname(headers.host) };
}

interface Words {
  readonly headline: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly href: string } | null;
  readonly literal: string | null;
}

/**
 * The sentence, in the interface's own voice.
 *
 * Each headline is one sentence about the agent, because a panel belongs to an
 * agent — the name is not a label pinned above the message, it is the subject
 * of it. The body says what to do next and stops.
 */
function words(state: Refusal): Words {
  if (state.kind === 'off') {
    return {
      headline: `${AGENT_NAME} can't tell who you are.`,
      body:
        "Single sign-on isn't set up for this instance, so no identity reaches the panel " +
        'and it can\'t tell one person from another. Until it is, the shared token is the only way in.',
      action: null,
      literal: state.local ? paths.panelToken : null,
    };
  }
  if (state.kind === 'bypassed') {
    return {
      headline: `${AGENT_NAME} doesn't know who you are.`,
      body:
        'You reached this panel at its network address, which goes around the sign-on ' +
        'entirely. Nothing on this path can sign you in.',
      action: state.publicHost === null ? null : { label: `Go to ${state.publicHost}`, href: `https://${state.publicHost}/` },
      literal: null,
    };
  }
  const login =
    state.host === null
      ? `https://${state.teamDomain}/`
      : `https://${state.teamDomain}/cdn-cgi/access/login/${state.host}?redirect_url=%2F`;
  return {
    headline: `${AGENT_NAME} needs you to sign in.`,
    body: 'Your session has ended, or it was never started for this address.',
    action: { label: 'Sign in', href: login },
    literal: null,
  };
}

/** The same refusal for anything that is not a browser. */
export function asText(state: Refusal): string {
  const w = words(state);
  const lines = [w.headline, w.body];
  if (w.action !== null) lines.push(w.action.href);
  if (w.literal !== null) lines.push(`${w.literal}, inside the bridge container`);
  return lines.join('\n') + '\n';
}

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/**
 * The screen.
 *
 * Self-contained because nothing else on this origin is readable yet: the
 * styles are inline and the mark is drawn here. The typefaces are the panel's
 * own, which is why they are served before the gate rather than behind it.
 *
 * It borrows the panel's tokens exactly — the near-black ground, the one cyan,
 * square corners — because this is the same instrument seen from outside, and a
 * differently-dressed door would read as a different building. The boldness is
 * spent once, on the headline; everything under it is quiet.
 */
export function asPage(state: Refusal): string {
  const w = words(state);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(AGENT_NAME)}</title>
<style>
  @font-face{font-family:'Onest';src:url('/fonts/onest.woff2') format('woff2');font-weight:100 900;font-display:swap}
  @font-face{font-family:'InterVar';src:url('/fonts/inter.woff2') format('woff2');font-weight:100 900;font-display:swap}
  :root{
    --ground:#0d0d0f; --ink:#fafafa; --dim:rgba(250,250,250,.64); --faint:rgba(250,250,250,.42);
    --line:rgba(255,255,255,.09); --accent:#21d2ed;
    --display:'Onest',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    --body:'InterVar',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--ground);color:var(--ink);
       font:400 14.5px/1.6 var(--body);-webkit-font-smoothing:antialiased;
       display:flex;align-items:center;padding:8vh 7vw}
  main{width:100%;max-width:33rem}
  .mark{width:20px;height:25.9px;display:block;margin:0 0 26px}
  h1{margin:0;font:400 clamp(28px,5.4vw,40px)/1.16 var(--display);letter-spacing:-.03em;
     text-wrap:balance;max-width:17ch}
  p{margin:18px 0 0;color:var(--dim);max-width:46ch}
  a.go{display:inline-block;margin-top:30px;padding:11px 18px;
       border:1px solid var(--line);
       color:var(--ink);text-decoration:none;font-size:13.5px}
  a.go:hover{border-color:var(--accent);color:var(--accent)}
  a.go:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  code{display:block;margin-top:30px;font-family:var(--mono);font-size:12.5px;
       color:var(--dim);word-break:break-all}
</style>
</head><body>
<main>
  <svg class="mark" viewBox="7.49 4.6 17.03 22" aria-hidden="true">
    <path d="M16 26.6C11.4 24.6 8.2 20.4 7.6 15.2 7.3 12.6 7.6 10.2 8.4 8.4c2 1.2 3.6 3.2 4.7 5.8C13 10.6 14 7.4 16 4.6c2 2.8 3 6 2.9 9.6 1.1-2.6 2.7-4.6 4.7-5.8.8 1.8 1.1 4.2.8 6.8-.6 5.2-3.8 9.4-8.4 11.4z" fill="#21d2ed" opacity=".58"/>
    <path d="M16 4.6c2 2.8 3 6 2.9 9.6 0 5-1.1 9.2-2.9 12.4-1.8-3.2-2.9-7.4-2.9-12.4C13 10.6 14 7.4 16 4.6z" fill="#21d2ed"/>
  </svg>
  <h1>${escape(w.headline)}</h1>
  <p>${escape(w.body)}</p>
  ${w.action === null ? '' : `<a class="go" href="${escape(w.action.href)}">${escape(w.action.label)}</a>`}
  ${w.literal === null ? '' : `<code>${escape(w.literal)}</code>`}
</main>
</body></html>
`;
}

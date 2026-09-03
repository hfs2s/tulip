import { describe, expect, it } from 'vitest';
import { lastResultFatal } from '../src/sessions.js';

/**
 * Every pane below is real output, captured from the deployment on the
 * Raspberry Pi. The first version of this detector matched only lines prefixed
 * `●` and looked for "Credit balance is too low" — and the actual failure
 * prints `⎿` and "Credit balance too low", so it detected nothing at all.
 *
 * That is the exact shape of the outage this code exists to prevent: the turn
 * fails instantly, the session stays up and looks healthy, and nobody is
 * answered. Fixtures rather than prose, so the next wording change is caught by
 * a test rather than by a fortnight of silence.
 */
const OUT_OF_CREDIT = `
 ▐▛███▛█   Claude Code v2.1.259
▝▜██████▀  Opus 5 (1M context) · API Usage Billing

❯ New WhatsApp message. Read ../../batches/70d8493c.json — then reply.
  ⎿  Credit balance too low · Add funds: https://platform.claude.com/settings/billing

✻ Crunched for 0s · done 8:10 PM
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

const HEALTHY = `
❯ New WhatsApp message. Read ../../batches/49165d3c.json — then reply.
  ⎿  Ran tulip-wa send "PIPELINE OK"
  ● Sent.

✻ Pondered for 4s · done 8:12 PM
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

const EXPIRED = `
❯ New WhatsApp message. Read ../../batches/aaaa.json — then reply.
  ⎿  API Error: authentication_error · Invalid API key
`;

describe('lastResultFatal', () => {
  it('detects an exhausted credit balance', () => {
    expect(lastResultFatal(OUT_OF_CREDIT)).toBe('the Anthropic account is out of credit');
  });

  it('detects invalid credentials', () => {
    expect(lastResultFatal(EXPIRED)).toBe('Claude Code credentials are not valid');
  });

  it('reports nothing for a healthy turn', () => {
    expect(lastResultFatal(HEALTHY)).toBeNull();
  });

  it('reads results marked with either prefix', () => {
    expect(lastResultFatal('  ● Credit balance too low')).not.toBeNull();
    expect(lastResultFatal('  ⎿  Credit balance too low')).not.toBeNull();
  });

  // The TUI keeps finished turns on screen. Reporting an old failure forever
  // pages an operator about an outage that has already fixed itself, and an
  // operator who is paged about those stops reading the pages.
  it('only considers the most recent result, so a fixed problem stops alerting', () => {
    expect(lastResultFatal(OUT_OF_CREDIT + HEALTHY)).toBeNull();
  });

  it('still reports when a failure follows a success', () => {
    expect(lastResultFatal(HEALTHY + OUT_OF_CREDIT)).toBe('the Anthropic account is out of credit');
  });

  it('reports nothing for a pane with no result lines at all', () => {
    expect(lastResultFatal('❯ \n  ⏵⏵ bypass permissions on')).toBeNull();
    expect(lastResultFatal('')).toBeNull();
  });

  it('detects a usage limit', () => {
    expect(lastResultFatal('  ⎿  Claude usage limit reached, try again later')).toBe(
      'the Anthropic usage limit has been reached',
    );
  });
});

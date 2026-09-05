/**
 * The bridge process.
 *
 * Wiring, plus the one behaviour that does not belong anywhere else: the
 * watchdog. Its signal is **delivered but unanswered**, which is what a person
 * on the other end actually experiences, rather than queue depth. Iris learned
 * this the expensive way — messages were delivered perfectly into a session
 * whose login had expired, every turn failed instantly, the queue was empty,
 * the process was up, the socket was connected, and nobody was answered for two
 * weeks.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ChatRegistry } from './chats.js';
import { loadConfig, type Config } from './config.js';
import { handleControl } from './control.js';
import { Dispatcher } from './dispatcher.js';
import { feed } from './feed.js';
import { ensureHandoffDirs, readCurrentTurn, readStatus } from './handoff.js';
import { log } from './log.js';
import { Outbox } from './outbox.js';
import { startPanel } from './panel.js';
import { paths } from './paths.js';
import { Limiter } from './ratelimit.js';
import { TurnRegistry } from './turns.js';
import { WhatsApp } from './whatsapp.js';

const CONFIG_FILE = process.env['TULIP_CONFIG'] ?? '/config/config.json';
const FLUSH_MS = 5000;
const WATCHDOG_MS = 30_000;

function banner(config: Config): void {
  log('tulip.start', {
    pid: process.pid,
    audience: config.audience.everyone ? 'EVERYONE' : `${config.audience.numbers.length} listed number(s)`,
    groups: config.groups.enabled,
    operators: config.operators.numbers.length,
    panel: `${config.panel.host}:${config.panel.port}`,
  });

  // Two configurations worth saying out loud at every start, because both are
  // reasonable and both are easy to end up in without meaning to.
  if (config.audience.everyone) {
    log('tulip.public', {
      note: 'this number answers anyone — every message is untrusted input to an agent with a shell',
    });
  }
  if (config.operators.numbers.length === 0) {
    log('tulip.noOperators', {
      note: 'no operator numbers configured: control commands and watchdog alerts are unavailable',
    });
  }
}

async function main(): Promise<void> {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  ensureHandoffDirs();

  const config = loadConfig(CONFIG_FILE);
  banner(config);

  const chats = new ChatRegistry();
  chats.syncContacts(config.agent.contacts, Date.now());
  const limiter = new Limiter(
    {
      messagesPerHour: config.limits.messagesPerHour,
      burst: config.limits.burst,
      turnsPerDay: config.limits.turnsPerDay,
      newSendersPerHour: config.limits.newSendersPerHour,
      outboundPerChatPerHour: config.limits.outboundPerChatPerHour,
    },
    paths.senders,
  );
  const turns = new TurnRegistry(
    config.limits.turnTimeoutMs,
    config.limits.outboundPerTurn,
    config.limits.toolsPerTurn,
  );

  // Adopt the turn that was open when this process last stopped, if there was
  // one. A restart used to forget it, and the agent's reply — written seconds
  // later, against an id this bridge had issued — was discarded as unroutable
  // with no way for the agent to know. Twice in one day that lost a message
  // somebody had asked for.
  const interrupted = readCurrentTurn(config.limits.turnTimeoutMs);
  if (interrupted !== null) {
    const jid = chats.jidFor(interrupted.chatKey);
    if (jid !== null) {
      turns.adopt(interrupted.turnId, jid, interrupted.chatKey, Date.parse(interrupted.startedAt));
      log('turn.adopted', {
        turnId: interrupted.turnId,
        chatKey: interrupted.chatKey,
        note: 'was open across a restart; its reply will still be delivered',
      });
    }
  }
  const wa = new WhatsApp();

  // `dispatcher` is referenced by things constructed before it, so it is passed
  // as a thunk rather than a value. The alternative is a mutable global.
  let dispatcher: Dispatcher | null = null;
  const currentDispatcher = (): Dispatcher => {
    if (!dispatcher) throw new Error('dispatcher used before it was constructed');
    return dispatcher;
  };

  dispatcher = new Dispatcher({
    wa,
    chats,
    limiter,
    turns,
    config,
    onControl: (envelope, chatKey) =>
      handleControl({ wa, chats, limiter, dispatcher: currentDispatcher }, envelope, chatKey),
  });

  const outbox = new Outbox({
    wa,
    turns,
    limiter,
    config,
    chats,
    lastMessageIn: (chatKey) => currentDispatcher().lastMessageIn(chatKey),
  });

  wa.on('message', (message) => {
    void currentDispatcher()
      .handle(message)
      .catch((err: unknown) => log('dispatch.error', { err: String((err as Error).message) }));
  });

  wa.on('ready', () => {
    feed.event('whatsapp.connected');
    void currentDispatcher().pump();
  });

  // WhatsApp reissues a pairing code every twenty seconds or so. Recording each
  // one buries everything else in the feed under identical lines, which makes
  // the panel useless at exactly the moment someone is setting Tulip up.
  let qrNoted = false;
  wa.on('qr', () => {
    if (qrNoted) return;
    qrNoted = true;
    feed.event('whatsapp.qr', 'not paired — scan the code in the bridge logs');
  });
  wa.on('ready', () => {
    qrNoted = false;
  });

  wa.on('fatal', (err: Error) => {
    log('tulip.fatal', { err: err.message });
    feed.event('whatsapp.fatal', err.message);
    // systemd or Docker restarts us; a logged-out socket cannot recover in
    // place, and pretending otherwise produces a process that looks healthy.
    process.exit(1);
  });

  await wa.start();
  outbox.start();
  startPanel({ config, wa, chats, limiter, dispatcher: currentDispatcher });

  // Typing follows the turn rather than the send: the wait people notice is the
  // one before the first word, and WhatsApp expires a composing state after
  // about ten seconds, so it has to be refreshed rather than set once.
  //
  // But only when we are actually going to write something. Judgement mode
  // starts a turn for *every* group message and the agent stays quiet for most
  // of them, so showing "typing…" at turn start meant the room watched Juan
  // compose a reply to a conversation he was not part of, and then nothing
  // arrived. That reads as broken, and it is worse than silence: it interrupts
  // a room to announce a message that never comes.
  //
  // A direct message is addressed to us by definition. A group message is only
  // if somebody mentioned us or replied to us — and there the persona's rule is
  // to always answer, so the indicator is a promise we keep. Everywhere else the
  // reply simply appears, which is what a person who was not asked would do.
  let typingFor: string | null = null;
  dispatcher.on('turnStart', ({ chatKey, addressed }: { chatKey: string; addressed: boolean }) => {
    if (!addressed) return;
    const jid = chats.jidFor(chatKey);
    if (jid) void wa.typing(jid, true);
    typingFor = chatKey;
  });
  dispatcher.on('turnEnd', ({ chatKey }: { chatKey: string }) => {
    // Only clear what we set. Sending "paused" for a turn that never showed
    // typing would push a presence update into a room we deliberately said
    // nothing in.
    if (typingFor !== chatKey) return;
    const jid = chats.jidFor(chatKey);
    if (jid) void wa.typing(jid, false);
    typingFor = null;
  });
  setInterval(() => {
    if (typingFor === null) return;
    const jid = chats.jidFor(typingFor);
    if (jid) void wa.typing(jid, true);
  }, 8000).unref();

  setInterval(() => {
    limiter.flush();
    chats.flush();
  }, FLUSH_MS).unref();

  // The watchdog. Two questions, in the order that explains the most: is the
  // agent in a state only a human can clear, and is anybody waiting?
  let alerted = new Set<string>();
  setInterval(() => {
    const status = readStatus();
    const snapshot = currentDispatcher().snapshot();

    if (status?.fatal && !alerted.has('fatal')) {
      alerted.add('fatal');
      log('watchdog.fatal', { state: status.fatal });
      feed.event('agent.fatal', status.fatal);
      void alertOperators(wa, config, `🔴 Tulip: ${status.fatal}`);
      return;
    }
    if (!status?.fatal) alerted.delete('fatal');

    if (status === null && !alerted.has('silent')) {
      alerted.add('silent');
      log('watchdog.agentSilent', { note: 'no status file — the agent container may be down' });
      feed.event('agent.silent', 'the agent is not reporting');
    }
    if (status !== null) alerted.delete('silent');

    // The signal this watchdog exists for: somebody has been waiting and has
    // not been answered. Deliberately independent of the two checks above,
    // because the expensive Iris failure had a healthy process, a connected
    // socket, an empty queue and no fatal state — the only observable was that
    // real people were being ignored. `stuckAfterMs` of 0 turns it off.
    const stuckAfterMs = config.delivery.stuckAfterMs;
    const waitingFor = snapshot.waitingSince === null ? 0 : Date.now() - snapshot.waitingSince;
    if (stuckAfterMs > 0 && waitingFor > stuckAfterMs && !alerted.has('stuck')) {
      alerted.add('stuck');
      const minutes = Math.round(waitingFor / 60_000);
      log('watchdog.stuck', { waitingForMs: waitingFor, queued: snapshot.queued });
      feed.event('delivery.stuck', `nothing answered for ${String(minutes)} minutes`);
      void alertOperators(
        wa,
        config,
        `🟠 Tulip: nothing has been answered for ${String(minutes)} minutes. ` +
          `${String(snapshot.queued)} waiting. Try !status.`,
      );
    }
    // Cleared only when the backlog actually drains, so recovery is what
    // re-arms the alert rather than the mere passage of time.
    if (snapshot.waitingSince === null) alerted.delete('stuck');

    // Kick for a turn still in flight as well as for queued work. `pump` closes
    // a finished turn itself, but it can exit with one open — an operator hold,
    // or the delivery error path — and nothing else reconciles it. Without this
    // the typing indicator would stay on until the next inbound message.
    if (snapshot.queued > 0 || snapshot.inFlight !== null) void currentDispatcher().pump();
  }, WATCHDOG_MS).unref();

  const shutdown = (signal: string): void => {
    log('tulip.stopping', { signal });
    limiter.flush();
    chats.flush();
    outbox.stop();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));

  process.on('unhandledRejection', (err: unknown) => {
    log('unhandledRejection', { err: String((err as Error)?.message ?? err) });
  });
  process.on('uncaughtException', (err: Error) => {
    log('uncaughtException', { err: String(err.stack ?? err.message) });
  });
}

/** Tell operators directly — never through the agent, which may be the fault. */
async function alertOperators(wa: WhatsApp, config: Config, text: string): Promise<void> {
  for (const number of config.operators.numbers.slice(0, 3)) {
    try {
      await wa.sendText(`${number}@s.whatsapp.net`, text);
    } catch (err) {
      log('watchdog.alertFailed', { err: String((err as Error).message) });
    }
  }
}

main().catch((err: unknown) => {
  const message = String((err as Error)?.message ?? err);
  log('tulip.startFailed', { err: message });
  // The lock message is the actionable part; a stack trace only buries it.
  if (!/holds .*session|another bridge/.test(message)) console.error(err);
  process.exit(1);
});

export { join };

# Deploy prompt

Hand everything below the line to an agent with shell access on the machine
Tulip should run on — Claude Code, or anything equivalent. It is
[`DEPLOYMENT.md`](DEPLOYMENT.md) rewritten as instructions, with the human
decisions marked as stops rather than assumptions.

**Read this part first, because it is about you and not the agent.**

The agent will need to *stop and ask you* four times: for the Anthropic key, for
your operator phone number, for the audience decision, and to scan the WhatsApp
QR code. It cannot do those for you and it should not invent them. If your agent
runs with permissions bypassed, watch it at those points.

It will not be able to finish alone. Pairing needs your phone.

---

## The prompt

> You are deploying **Tulip**, a WhatsApp assistant backed by a Claude Code
> session, onto this machine. The repository is
> `https://github.com/hfs2s/tulip`. The full procedure is `docs/DEPLOYMENT.md`
> once you have cloned it; the threat model is `docs/THREAT-MODEL.md`.
>
> **Read `docs/DEPLOYMENT.md` before you start and follow it.** What is below is
> the shape of the job and the things that are easy to get wrong, not a
> replacement for it.
>
> ### Rules for this deployment
>
> 1. **Stop and ask me** for: the Anthropic API key, my operator phone number
>    (bare international digits, no `+`), and whether the number should answer
>    *anyone* or only a list. Do not guess any of these and do not put a
>    placeholder in a file and carry on.
> 2. **Never print a secret.** Not in a summary, not in a log line, not when
>    confirming you wrote it. Mask to the last four characters.
> 3. **Do not set `TULIP_PANEL_BIND=0.0.0.0`.** That publishes an operator
>    console which can read every message to every network this host is on. If I
>    ask you to expose the panel, tell me what authenticates in front of it
>    first.
> 4. **Do not add hosts to `TULIP_EGRESS_ALLOW`** beyond the defaults unless I
>    ask. Each one is another channel out of the agent's jail.
> 5. **`scripts/verify-containment.sh` must pass before the number is given to
>    anyone.** If it cannot reach the Docker daemon, that is not a pass — fix
>    the access and run it again. If any assertion fails, stop and tell me which
>    one; do not proceed to pairing.
> 6. If a step fails, **report what failed and what you tried**. Do not work
>    around a failing security check.
>
> ### The job
>
> 1. Check the host: 64-bit Linux, Docker with the Compose plugin, ~4 GB free.
>    Install Docker with `scripts/install-docker.sh` if it is missing. On a
>    Raspberry Pi, check whether the memory cgroup controller is enabled and
>    tell me if it is not — Docker discards a memory limit it cannot enforce
>    with one warning line, so the cap would be absent while the config claims
>    it.
> 2. Clone the repository and `cd` into it.
> 3. `cp .env.example .env` and `mkdir -p config && cp config.example.json
>    config/config.json`. Ask me for the values from rule 1 and write them in.
>    Leave every other default alone unless I say otherwise.
> 4. Run `scripts/preflight.sh`. Fix or report everything it flags.
> 5. `docker compose build` then `docker compose up -d`. The build takes 10–25
>    minutes on a Pi; do not assume it has hung.
> 6. Run `docker compose logs -f bridge` until a QR code appears, then **tell me
>    it is ready and wait.** I scan it from the phone that owns the number.
>    Confirm pairing succeeded before continuing — look for `wa.open` in the
>    logs.
> 7. Run `scripts/verify-containment.sh`. All seventeen assertions must pass.
>    Report the result in full.
> 8. Run `sudo scripts/install-units.sh` and start `tulip-boot` and
>    `tulip-ttyd`, so the stack survives a reboot. Explain to me why
>    `restart: unless-stopped` in the compose file does not already cover this.
> 9. Print the panel token (`docker exec tulip-bridge cat /state/panel-token`)
>    **masked**, and tell me the SSH tunnel command to reach the panel.
> 10. Tell me to message the number from a different phone, and confirm from the
>     panel and the logs that a message arrived, a turn ran, and a reply went
>     out.
>
> ### After it works
>
> Tell me, briefly:
>
> - Which optional capabilities are **off** because no key is set (pictures,
>   voice in, voice out, search, GIFs, pages), and what each needs.
> - That `persona/` currently holds someone else's character, that I should
>   rewrite `IDENTITY.md` and `VOICE.md`, and that the composed brief has to
>   stay under 40,000 characters or Claude Code silently stops carrying all of
>   it.
> - **That chat isolation is not structural.** Tulip runs one shared Claude
>   Code session across every conversation, so the only thing keeping one
>   person's messages out of another's reply is the discretion rules in
>   `persona/BOUNDARIES.md`. If I am opening this number to the public, I should
>   read `docs/THREAT-MODEL.md` §T4 and residual risk R1 and decide whether I
>   accept that.
>
> Do not tell me it is secure. Tell me what you verified, what you did not, and
> what is switched on.

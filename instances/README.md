# Instances

One directory per additional agent, each its own deployment of the same code:
`instances/<handle>/.env`, `config/` and `plugins/`. Everything in here except
this file is ignored by git — it holds credentials, phone numbers and persona
text that belong to one deployment and to nobody else.

The default deployment is not in here: it keeps the repository's own `.env` and
`./config`. Create a new one with `scripts/2lp new <handle>`, and see
[docs/INSTANCES.md](../docs/INSTANCES.md).

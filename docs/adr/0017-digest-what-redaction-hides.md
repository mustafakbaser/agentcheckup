# 0017. Digest what redaction hides, and gate removed deny and ask entries

- Status: Accepted
- Date: 2026-11-14
- Amends: [0007](0007-model-what-each-agent-loads.md), whose inventory digests covered only the
  redacted form of an item and whose gate never tripped on a removal

## Context

`--baseline` with `--gate` fails a pull request check when the pull request adds or changes an
MCP server, a hook, a permission or an env override, so that a person reviews it. An inventory
item is changed when its digest differs. Until now the digest was a 53-bit hash of what reports
show, and reports show a redacted form: URLs cut to their origin, the value after a
credential-like flag removed, env and header values left out except an endpoint's origin and a
TLS switch. A change confined to what redaction removes kept the id and the digest, and passed
`--gate security` with exit code 0. Reproduced on 2026-11-14:

- a hook that downloads `https://raw.githubusercontent.com/acme/tools/main/setup.sh`, changed to
  another path on the same host;
- a hook `npx -y @acme/setup@1.0.0 --config https://cfg.example.com/acme.json`, changed to
  `…/other.json`;
- an HTTP MCP server's URL path, and a URL argument of a stdio server;
- the `NODE_OPTIONS` value of an MCP server's `env`; `NODE_OPTIONS` and `PATH` in
  `.claude/settings.json`, and an `ANTHROPIC_BASE_URL` path on the same origin.

Each changes what runs or where requests go. Hashing the raw entry would catch them, but baseline
files are published as workflow artifacts and pull request comments, and a hash of a short
password can be reversed by trying candidates offline. Rotating a credential is also not a
change a reviewer needs to approve.

Removing a `permissions.deny` or `permissions.ask` entry lets the agent do, or do without
asking, what the entry refused or asked about. That is how the `permissions` class is defined,
but removals never tripped the gate.

The same review found credentials that redaction, which matches names and vendor prefixes, let
through to reports: `sshpass -p pw`, `mysql -ppw`, `--pwd=pw`, `--pat tok`, data source names
without a scheme (`root:pw@tcp(db:3306)/x`), connection strings
(`Server=db;User Id=sa;Password=pw;`) and a `sig=` query parameter, and in the dry-run diff of
`fix`, `env` and `headers` values and URL credentials of every line it shows.

## Decision

- An inventory item's digest is SHA-256 (src/core/sha256.ts) of its shown fields and of an
  `exact` part that reports never show: the whole command and every argument, the whole URL with
  its path and query, an HTTP hook's URL, a prompt hook's prompt, an MCP server's `cwd` and
  `envFile`, and the values of env overrides of the `endpoint`, `tls` and `code-exec` classes,
  in an MCP server's `env` too.
- The `exact` part leaves credentials out: the value after a credential-like flag, the
  password options of `sshpass`, the MySQL and MariaDB clients and `redis-cli`, URL user names
  and passwords, query values whose names look like credentials, the password of a data source
  name, the credential fields of a connection string, words that match a vendor token format,
  header values, and the values of `credential` and `other` env overrides. `other` values are
  left out because a secret can hide under a name that does not say so. A changed credential
  is not a changed item.
- `PATH` is a `code-exec` variable: a directory put first decides what every command runs
  (POSIX.1-2024, chapter 8).
- A change only the digest sees is labeled in the gate summary: "(changed in a redacted part)".
  Reports show the redacted form before and after, never the raw values.
- Item ids do not change: they still cover only what reports show, so a path change is a
  changed item, not a removed one and an added one.
- `fingerprintVersion` becomes 3. A baseline with version 2 or older is refused with exit
  code 2, as any baseline from another version is: compared with it, every item would look
  changed. SARIF keeps the `partialFingerprints` key `agentcheckup/v2`, because finding
  fingerprints did not change and code scanning should keep tracking its alerts.
- A gate hit can be `removed`: a `deny` or `ask` entry that took effect in the baseline and is
  gone, unless an entry with the same key and value still takes effect in a file of the same
  directory (moved from `settings.json` to `settings.local.json`). It trips `permissions` as
  "Permission widened: permissions.deny entry removed: …". An added `deny` or `ask` entry still
  never trips it. Only Claude Code's settings have `deny` and `ask` lists in the inventory.
- Redaction reads the password options above, short credential words as whole words of a name
  (`pat`, `pass`, `pw`, `pwd`, `sig`), `signature` anywhere in a name, data source names and
  connection strings. Every test walks the text once, word by word.
- The `fix` dry run and its JSON hunks mask every line they show, changed or context, as the
  inventory does: `env` and `headers` values of JSON and TOML configuration, repeated keys
  included, credential arguments and URL credentials. The diff is computed on the real text.
  `fix --format suggestions` skips a change whose suggested lines hold anything the mask would
  hide, with the reason `credential`: a suggestion must hold the exact text, so it cannot be
  masked.

## Consequences

- The gate trips on every change of what runs or where requests go that the repository shows,
  without credentials entering reports or baseline files.
- A digest can still confirm a guess of a non-credential value, such as a URL path, from a
  published baseline. A credential that redaction does not recognize, such as a password after
  an unknown program's own flag, enters the digest; it was already shown in reports before.
  A credential in a URL path, such as a Slack webhook, enters the digest too; such tokens are
  long and random, so trying candidates does not find them.
- A new credential value under the same name, and a changed `other` env value, are still not
  changes. mcp/literal-secret reports committed credentials.
- Every baseline must be created again with this version. The GitHub Action creates it on every
  run, so only hand-made baselines are affected.
- Policy violation ids carry the 64-digit digest.
- Over-redaction is accepted for display: `-u` is redacted after any program, and a flag named
  like a credential takes its next word along even when it takes no value.
- Gemini CLI's `tools.discoveryCommand` and `tools.callCommand`, which run commands, and its
  `tools.allowed` and `tools.exclude` lists are not in the inventory yet, so the gate does not
  see them.

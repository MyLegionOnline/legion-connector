# Security Policy

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security
problem.** Report it privately:

- Email: **legal@mylegion.online** (subject starting with `[SECURITY]`)
- or GitHub: *Security → Report a vulnerability* in this repository
  (private vulnerability reporting)

Please include:

- the connector version or commit, the OpenCode version, and the operating
  system;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- your name or handle if you want to be credited.

Do not include real credentials. If you found secrets in the repository, say so
and do not use them.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement of your report | within 3 business days |
| First assessment (accepted / need more info / not a vulnerability) | within 10 business days |
| Fix or mitigation for confirmed high-severity issues | within 90 days |

We will keep you informed, agree on a disclosure date with you, and credit you
in the release notes unless you prefer to stay anonymous.

## Scope

In scope: the code in this repository and `install.sh`.

Examples of what counts: a way for a Hub or a network peer to make the
connector run a command, read a path or start the agent in a directory that the
local policy (`work_dirs`, `confirm_ops`) forbids; leaking the refresh token or
the generated OpenCode password; accepting frames from a superseded run.

Out of scope: vulnerabilities in OpenCode or other third-party dependencies
that are not reachable through this project (report those upstream), social
engineering, and issues that need an already compromised machine.

By design the connector runs the local agent with the rights of the user it
runs as, and a Hub you pair it with can send that agent tasks. Treat the Hub as
trusted for that purpose; see "Safety" in the README for how to limit the
damage.

## Supported versions

Security fixes are released for the latest minor version.

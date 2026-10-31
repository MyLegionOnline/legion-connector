# Legion Connector v0.1.1

Fixes found while running the connector on a small VPS (1 CPU, 2 GB, no swap).

## Fixed

- An `opencode serve` that does not exit on SIGTERM is now killed. Before, a server busy with a session stayed alive after its task finished or was paused; two of them used up the memory of a 2 GB machine, and the next task failed.
- A stop that arrives while OpenCode is still starting (a pause a few seconds after the task was sent) is no longer lost. The starting server is shut down, so the task resumes on one server instead of two.
- The connector waits up to 30 seconds for `opencode serve` to become ready, up from 15.
- When `opencode --version` gives nothing, the error says why: the command is not on the connector user's PATH, it failed, or it did not answer in time.

## Upgrade

The pairing and `connector.toml` live in the connector user's home and stay as they are; only the package in `/opt/legion-connector` is replaced. As root, from your clone:

```bash
git fetch --tags && git checkout v0.1.1
cp -r ./* /opt/legion-connector/
cd /opt/legion-connector && npm ci && npm run build && npm prune --omit=dev
chown -R root:root /opt/legion-connector && systemctl restart legion-connector
```

Check with `journalctl -u legion-connector -n 5`: the connector logs `connected`, and the Hub shows version 0.1.1 on the agent card.

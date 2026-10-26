# Legion connector

The connector runs your **local [OpenCode](https://opencode.ai) agent** as a
remote executor for a task in a [Legion Hub](https://github.com/MyLegionOnline/legion-hub)
Room. It is meant for machines where the work has to happen on the machine
itself — for example deploying to your own server.

## Why

Your production SSH keys, root access and LLM subscription never leave your
machine. The connector opens an **outbound** WebSocket to your Hub, receives a
task, hands it to the OpenCode agent installed locally, and reports status,
questions and the final result back over the same socket. There is no inbound
port and no credential shared with the Hub.

## Requirements

- Node.js >= 18.17
- [OpenCode](https://opencode.ai) installed and working on the machine
  (`opencode` on `PATH`), version 1.18 or newer, 1.x or 2.x — see
  [OpenCode versions](#opencode-versions).
- A Legion Hub you can reach over `wss://` (or `ws://` for a local Hub).

## Install

Get a pairing code in the Hub UI ("Connect an external agent" on an agent's
card), then on the target machine:

```bash
git clone https://github.com/MyLegionOnline/legion-connector.git
cd legion-connector
./install.sh <pairing-code> wss://your-hub.example.com/api/v1/connector/ws
```

On Linux with systemd the script creates a dedicated system user for the
connector, `legion-agent` with uid 59999 (`--user NAME` and `--uid N` change
them; it refuses root and a uid that another account or running process
already has). It copies the package to `/opt/legion-connector` (owned by
root, so the agent cannot change its own connector), builds it, writes a
default `~legion-agent/.legion-connector/connector.toml` with `work_dirs` set
to `~legion-agent/work`, exchanges the pairing code for a refresh token as that
user, and installs a systemd unit that runs as that user so the connector
survives reboots. The code is single-use and expires after 15 minutes.

Then sign OpenCode in to a model provider as the same user, since OpenCode
keeps its credentials per user:

```bash
sudo -iu legion-agent opencode auth login
```

Without systemd (macOS, for example) the script sets the connector up for the
current user; run it as a dedicated user yourself (see below).

Manual steps (what `install.sh` automates):

```bash
npm ci
npm run build
npm prune --omit=dev
node dist/index.js pair <pairing-code> --hub-url wss://your-hub.example.com/api/v1/connector/ws
node dist/index.js start
```

## Configuration

Edit `~/.legion-connector/connector.toml` (see
[`connector.example.toml`](./connector.example.toml)) before the first real
task. Credentials (the refresh token) live separately in
`~/.legion-connector/credentials.json`, so the policy file is safe to keep in
version control. Paths can be overridden with `LEGION_CONNECTOR_HOME`,
`LEGION_CONNECTOR_CONFIG` and `LEGION_CONNECTOR_CREDENTIALS`.

### Safety: the agent runs with your rights

OpenCode executes commands on your machine with the permissions of the user the
connector runs as. Treat every task the way you would treat a command typed by
someone with access to your Hub Room, and reduce the blast radius:

- Run the connector as a dedicated unprivileged system user whose uid is not
  used by any other process on the machine, containers included. Processes
  inside Docker containers run under host uids too (often 1000), and a user
  that shares the uid can read their `/proc/<pid>/environ` (API keys, tokens)
  and send them signals. `useradd` hands out the first free uid from 1000 on,
  so pick one explicitly. `install.sh` does this for you (`legion-agent`, uid
  59999, checked against existing accounts and running processes); by hand it
  is `sudo useradd --system --uid 59999 --create-home legion-agent`, then
  check with `ps -eo uid,comm | awk '$1==59999'` that nothing else runs under
  it.
- Copy [`opencode.example.json`](./opencode.example.json) to
  `<work_dir>/opencode.json`. Its `permission.bash` rules make OpenCode ask
  before `rm`, `systemctl restart` and similar commands; each "ask" appears as
  a confirmation card in the Hub chat, and `reboot` / `shutdown` are denied.
- Copy [`AGENTS.example.md`](./AGENTS.example.md) to `<work_dir>/AGENTS.md` to
  give the agent the house rules (back up a config before changing it, report
  what was changed, restarted and health-checked).
- Set `work_dirs` in `connector.toml` to the directories the agent may work
  in (absolute paths). A task runs in the first entry; a directory suggested by
  the Hub is used only if it lies inside one of the entries, and a request that
  points elsewhere — including through `..` or a symlink — is refused with an
  `error` frame before OpenCode is started.
- List risky command prefixes in `confirm_ops` (default: `rm`,
  `systemctl restart`, `systemctl stop`). The connector passes them to OpenCode
  as `ask` rules (also behind `sudo`), added after your `opencode.json`, so
  they win over an `allow` there. If OpenCode does not report the rules as
  active, the task is refused instead of running unconfirmed. Forbid commands
  outright with `deny` in `opencode.json` and do not list them in
  `confirm_ops`, which would turn that `deny` into a confirmation.
- Variables sent by the Hub (Room variables) reach the agent's environment, but
  names that would change the agent's own behaviour (`OPENCODE_*`, `PATH`,
  `LD_*`, `NODE_*` and similar) are ignored.

`work_dirs` decides where the agent starts, not what it does afterwards:
OpenCode can still read or run things outside that directory unless its own
permissions forbid it. Keep `opencode.json` strict and the connector's user
unprivileged.

Revoking the connector in the Hub UI takes effect immediately: its access token
can no longer be refreshed.

## How it works

1. The Hub queues a `dispatch` frame (task text, `run_id`, `mode`) for your
   connector in a durable outbox and sends it over the WebSocket.
2. The connector acknowledges the frame and starts an `opencode serve` session
   in the working directory (through `@opencode-ai/sdk` for 1.x, over the HTTP
   API for 2.x).
3. OpenCode events become `status` and `reasoning` frames. A permission request
   or a question for the human becomes an `ask_user` frame; the answer comes
   back as an `answer` frame. A question for the Hub's ChatMaster is `ask_cm`.
4. The final report is sent as a `result` frame. A crash of the local agent is
   reported as an `error` frame, never as silence.
5. If the socket drops, the connector reconnects with exponential backoff and
   sends `resume` with the last acknowledged sequence number, so no frame is
   lost. Frames from a superseded `run_id` are discarded by the Hub.

The only supported mode is `operator`: the agent changes the environment of
your machine (edit files, restart a service, run a health check) and reports
back in text. It never touches the Room's git repository.

### Direct chat and Room access

- **Direct chat.** "Message" on your external agent opens a direct room that
  works as a console to this machine: every message you send becomes one task
  for the connector, the earlier messages of the chat travel with it, and the
  agent's final report appears in the chat as its reply. There is no
  ChatMaster and no review; a question from the agent (`ask_user` or `ask_cm`)
  shows up as a card you can click or answer by typing. A message sent while
  the agent is still working is not queued — the chat says the agent is busy.
- **Room access.** A connector takes tasks only from rooms it has been granted.
  Opening the direct chat grants that room. In a group room, grant access in
  the Members panel ("Grant access" next to the agent); the agent card lists
  every room with access and lets you revoke each one. A task in a room
  without access fails with "No access to this room" and a "Grant access and
  retry" button.

The wire protocol is described in
[`connector_protocol.md`](https://github.com/MyLegionOnline/legion-hub/blob/main/hub/docs/connector_protocol.md)
in the Hub repository.

### OpenCode versions

The connector reads `opencode --version` when it starts and when a task
begins, and drives the matching API:

| OpenCode | Driver | Checked against |
|---|---|---|
| 1.18.x and later 1.x | `opencode1.ts`, over `@opencode-ai/sdk` | 1.18.30, a full `operator` task with confirmation cards |
| 2.x | `opencode2.ts`, plain HTTP (the 2.x API is marked experimental) | 2.0.28, a full `operator` task with a confirmation card |
| older than 1.18 | refused | install `npm i -g opencode-ai@1.18.30` |

The detected version and API are reported to the Hub (shown on the agent card).
Before a task runs the connector also checks the live server against the driver:
a server that speaks a different API, or lacks a route the driver calls, fails
the task at once with the reason and what to do. If `--version` prints
nothing useful (a custom build), force the driver with `api = "v1"` or
`api = "v2"` under `[opencode]` in `connector.toml`.

Notes for 2.x:

- Not yet checked against a live 2.x server: stopping a running task, the
  agent's own question forms (`form.*`), and the refusal when the server does
  not report the `confirm_ops` rules. Treat 2.x as the less tested of the two
  drivers, and its API as subject to change between minor versions.
- Memory: `opencode serve` took about 370 MB at the start of a 2.0.28 task on a
  1 GB server; 1.18.x took about 740 MB. Give the machine at least 2 GB, or
  add swap.
- The 2.x server always requires a password. The connector generates a random
  one per task and passes it to the server it starts; you do not configure it.
- 1.x and 2.x use different database formats at the same default path
  (`~/.local/share/opencode/opencode.db`). Do not run both against it. To keep
  the connector's OpenCode apart from yours, set `db = "/path/connector.db"`
  under `[opencode]` (2.x only; providers you configured are then not shared,
  so sign in once for that database).
- `confirm_ops` are applied as 2.x `shell` permission rules and checked in the
  server's effective config before the task starts; if they are not in force,
  the task does not run.

### Hub compatibility

The connector announces its protocol version (`protocol_version`, currently
`2`) and its modes when it connects. If the Hub does not support that version,
the connector shows up as **incompatible** in the Hub and receives no tasks:
update the connector or the Hub, whichever is older, and restart the service. A task for a mode the connector does not run fails immediately
instead of waiting. A frame the connector does not understand is answered with
an `unknown_frame` error, so a task never hangs on a version mismatch.

## Code layout

- [`src/driver.ts`](./src/driver.ts) — the `AgentDriver` interface:
  `start(ctx, sink) -> { answer, stop }`.
- [`src/drivers/opencode.ts`](./src/drivers/opencode.ts) — the OpenCode driver
  (process, lifecycle, confirmations), with `opencode1.ts` (1.x, `@opencode-ai/sdk`),
  `opencode2.ts` (2.x, HTTP) and `opencodeVersion.ts` (which one to use).
- [`src/drivers/mock.ts`](./src/drivers/mock.ts) — a deterministic driver used by
  the tests.
- [`src/connectorClient.ts`](./src/connectorClient.ts) — the wire protocol:
  connect/reconnect, `hello`/`ping`/`pong`, per-frame `ack`, `resume`, and the
  translation of driver events into frames.
- [`src/pairing.ts`](./src/pairing.ts) — pairing code and token exchange over the
  Hub's REST API.
- [`src/config.ts`](./src/config.ts) — `connector.toml` and credentials I/O.
- [`src/policy.ts`](./src/policy.ts) — the local policy: `work_dirs`, `confirm_ops`
  and the filtering of Room variables.

## Development

```bash
npm ci
npm run build
npm test
```

The tests run against a throwaway `ws` server standing in for the Hub and use
`MockDriver`, so they need neither a Hub nor OpenCode.

## License

[Apache License 2.0](./LICENSE). "Legion" and the Legion logo are not covered
by the license. Contributions are accepted under the same license (Apache-2.0
section 5).

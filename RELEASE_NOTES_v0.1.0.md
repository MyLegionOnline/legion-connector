# Legion Connector v0.1.0

Initial public release of the local OpenCode connector under Apache-2.0.

## Included

- Pair a local connector with a Legion Hub and run an OpenCode agent as a remote executor: tasks from the rooms its owner granted, and a direct chat that runs on this machine.
- `install.sh` sets the connector up under a dedicated system user (`legion-agent`, uid 59999 by default) with a systemd unit; the package in `/opt/legion-connector` belongs to root.
- A failure reported by the model provider ends the run at once with the provider's reason.
- Protocol v2 handshake, version reporting and explicit handling of unsupported frames.
- Local configuration example, OpenCode permission and house-rules examples, systemd service template and installation script.

## Install

Follow [README.md](https://github.com/MyLegionOnline/legion-connector/blob/main/README.md) to build from the tagged source and pair the connector. Node.js 18.17 or newer and a supported OpenCode version are required.

Remote session resume and automatic updates are outside this first release; use Retry to restart a blocked task. If the connector restarts in the middle of a run, the Hub keeps that task running until it is cancelled on the Board.

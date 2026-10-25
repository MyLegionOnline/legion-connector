# Legion Connector v0.1.0

Initial public release of the local OpenCode connector under Apache-2.0.

## Included

- Pair a local connector with a Legion Hub room and run an OpenCode agent as a remote executor.
- Protocol v2 handshake, version reporting and explicit handling of unsupported frames.
- Local configuration example, systemd service template and installation script.

## Install

Follow [README.md](https://github.com/MyLegionOnline/legion-connector/blob/main/README.md) to build from the tagged source and pair the connector. Node.js 18.17 or newer and a supported OpenCode version are required.

Remote session resume and automatic updates are outside this first release; use Retry to restart a blocked task.

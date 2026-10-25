#!/usr/bin/env node
// CLI entrypoint. Two subcommands: `legion-connector pair <code> [--hub-url <url>]` and
// the default `legion-connector` (or `legion-connector start`), which loads
// saved credentials and runs the WS loop until killed.

import { arch, hostname, platform } from "node:os";
import { ConnectorClient } from "./connectorClient.js";
import {
  type ConnectorConfig,
  loadConfig,
  loadCredentials,
  saveConfig,
  saveCredentials,
} from "./config.js";
import { OpenCodeDriver, detectOpenCode } from "./drivers/opencode.js";
import type { AgentDriver } from "./driver.js";
import { logger } from "./logger.js";
import { pairWithCode } from "./pairing.js";

function hostFingerprint(): string {
  return `${hostname()}:${platform()}:${arch()}`;
}

async function runPair(args: string[]): Promise<void> {
  const code = args[0];
  if (!code) {
    console.error("usage: legion-connector pair <pairing-code> [--hub-url <wss://...>]");
    process.exitCode = 1;
    return;
  }
  const hubUrlFlagIndex = args.indexOf("--hub-url");
  const hubUrl = hubUrlFlagIndex >= 0 ? args[hubUrlFlagIndex + 1] : undefined;

  const config = loadConfig();
  if (hubUrl) config.hub_url = hubUrl;

  const paired = await pairWithCode(config.hub_url, code);
  saveCredentials({
    connector_id: paired.connector_id,
    refresh_token: paired.refresh_token,
    host_fingerprint: hostFingerprint(),
  });
  saveConfig(config);
  logger.info("connector: paired successfully", { connector_id: paired.connector_id });
  console.log(
    `Paired. connector_id=${paired.connector_id}\n` +
      `Run "legion-connector start" (or the systemd unit) to begin serving dispatches.`,
  );
}

function buildDriver(config: ConnectorConfig): AgentDriver {
  switch (config.agent_cli) {
    case "opencode":
      return new OpenCodeDriver({ ...(config.opencode ?? {}), confirmOps: config.confirm_ops });
    default:
      throw new Error(`unknown agent_cli: ${String(config.agent_cli)}`);
  }
}

async function runStart(): Promise<void> {
  const config = loadConfig();
  const credentials = loadCredentials();
  if (!credentials) {
    console.error('No saved credentials. Run "legion-connector pair <code>" first.');
    process.exitCode = 1;
    return;
  }

  // Tell the Hub which OpenCode this machine runs (shown on the agent card).
  // A missing or unsupported OpenCode does not stop the connector: each task
  // reports the problem itself, with what to install.
  const detected = await detectOpenCode(config.opencode);
  if (detected.ok) {
    config.cli_version ??= detected.version ?? undefined;
    config.cli_api = detected.api;
    logger.info("connector: OpenCode detected", { version: detected.version, api: detected.api });
  } else {
    logger.warn("connector: OpenCode is not usable", { code: detected.code, message: detected.message });
  }

  const driver = buildDriver(config);
  const client = new ConnectorClient(config, credentials, driver);

  process.on("SIGINT", () => {
    logger.info("connector: shutting down (SIGINT)");
    client.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    logger.info("connector: shutting down (SIGTERM)");
    client.close();
    process.exit(0);
  });

  await client.connect();
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case "pair":
      await runPair(rest);
      break;
    case "start":
    case undefined:
      await runStart();
      break;
    default:
      console.error(`unknown command: ${command}\nusage: legion-connector [pair <code>|start]`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error("connector: fatal", { error: String(err) });
  process.exitCode = 1;
});

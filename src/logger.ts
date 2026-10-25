// Minimal timestamped logger — no external dependency for something this small.

function ts(): string {
  return new Date().toISOString();
}

export const logger = {
  info(msg: string, extra?: Record<string, unknown>): void {
    console.log(`[${ts()}] INFO  ${msg}`, extra ?? "");
  },
  warn(msg: string, extra?: Record<string, unknown>): void {
    console.warn(`[${ts()}] WARN  ${msg}`, extra ?? "");
  },
  error(msg: string, extra?: Record<string, unknown>): void {
    console.error(`[${ts()}] ERROR ${msg}`, extra ?? "");
  },
  debug(msg: string, extra?: Record<string, unknown>): void {
    if (process.env.LEGION_CONNECTOR_DEBUG) {
      console.debug(`[${ts()}] DEBUG ${msg}`, extra ?? "");
    }
  },
};

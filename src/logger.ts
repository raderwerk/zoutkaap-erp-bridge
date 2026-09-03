type LogLevel = "info" | "warn" | "error";

/**
 * Eén regel gestructureerde JSON-logging per gebeurtenis, naar stdout/stderr.
 * Geen externe logservice: dit is een demo-service zonder productieverkeer.
 */
function log(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>): void => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>): void => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>): void => log("error", message, meta),
};

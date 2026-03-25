type LogData = Record<string, unknown>;

interface Logger {
  info(msg: string): void;
  info(data: LogData, msg: string): void;
  warn(msg: string): void;
  warn(data: LogData, msg: string): void;
  error(msg: string): void;
  error(data: LogData, msg: string): void;
  debug(msg: string): void;
  debug(data: LogData, msg: string): void;
  child(bindings: LogData): Logger;
}

function formatLine(level: string, data: LogData | null, msg: string, bindings: LogData): string {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  const ctx = { ...bindings, ...data };
  const extra = Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : "";
  return `[${time}] [${level}] ${msg}${extra}`;
}

function createLogger(bindings: LogData = {}): Logger {
  function logMethod(level: string) {
    return (...args: [string] | [LogData, string]) => {
      let data: LogData | null = null;
      let msg: string;
      if (typeof args[0] === "string") {
        msg = args[0];
      } else {
        data = args[0];
        msg = args[1] as string;
      }
      process.stderr.write(formatLine(level, data, msg, bindings) + "\n");
    };
  }

  return {
    info: logMethod("INFO"),
    warn: logMethod("WARN"),
    error: logMethod("ERROR"),
    debug: logMethod("DEBUG"),
    child(childBindings: LogData): Logger {
      return createLogger({ ...bindings, ...childBindings });
    },
  };
}

export const logger = createLogger();

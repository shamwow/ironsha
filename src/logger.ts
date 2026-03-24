import pino from "pino";
import { config } from "./config.js";

const logDir = process.env.LOG_DIR || "./logs";

export const logger = pino({
  level: config.LOG_LEVEL,
  transport: {
    target: "pino-roll",
    options: {
      file: `${logDir}/ironsha`,
      frequency: "daily",
      extension: ".log",
      limit: { count: 7 },
    },
  },
});

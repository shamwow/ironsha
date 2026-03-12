import "dotenv/config";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { startWebhookServer } from "./webhook/server.js";

logger.info({ provider: config.LLM_PROVIDER }, "ironsha starting");
startWebhookServer(config);

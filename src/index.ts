import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { config, resolveProviderModel } from "./config.js";
import { logger } from "./logger.js";
import { startPoller } from "./poller.js";

const octokit = new Octokit({ auth: config.GITHUB_TOKEN });

logger.info(
  {
    provider: config.LLM_PROVIDER,
    model: resolveProviderModel(config.LLM_PROVIDER) ?? "provider-default",
  },
  "ironsha starting",
);

startPoller(octokit);

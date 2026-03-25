#!/usr/bin/env node
import "dotenv/config";

const USAGE = `Usage: ironsha <command> [args]

Commands:
  build "<task>" [options]   Plan, review, implement, and PR-review a task
  state <subcommand>         Manage local PR review state

Run 'ironsha build --help' or 'ironsha state --help' for command-specific usage.
`;

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  // Rebuild argv so subcommand sees itself at argv[2]
  // Original: [node, ironsha, build, ...args]
  // Passed:   [node, build, ...args]
  const subArgv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

  switch (command) {
    case "build": {
      const { main: buildMain } = await import("./cli.js");
      await buildMain(subArgv);
      break;
    }
    case "state": {
      const { main: stateMain } = await import("./local/cli.js");
      await stateMain(subArgv);
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

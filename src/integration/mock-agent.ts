import type { AgentRunner } from "../review/agent-runner.js";

const architectureResponse = {
  architecture_comments: [
    {
      path: "Zenith/Views/Dashboard/DashboardView.swift",
      line: 16,
      body: "Mock architecture comment: consider extracting this state into a dedicated view model to keep DashboardView lean.",
    },
  ],
  architecture_update_needed: { needed: false },
  thread_responses: [],
  summary: "Architecture review complete (mock).",
};

const detailedResponse = {
  detail_comments: [
    {
      path: "Zenith/Views/Dashboard/DashboardView.swift",
      line: 176,
      body: "Mock detailed comment: the GeometryReader overlay may cause unnecessary layout passes — consider using `.onGeometryChange` instead.",
    },
  ],
  thread_responses: [],
  summary: "Detailed review complete (mock).",
};

export const mockAgentRunner: AgentRunner = async (options) => {
  const payload =
    options.pass === "architecture" ? architectureResponse : detailedResponse;

  return JSON.stringify({ result: JSON.stringify(payload) });
};

/** Mock agent that returns no comments and no thread responses —
 *  simulates an agent that fails to discover existing threads. */
const emptyArchResponse = {
  architecture_comments: [],
  architecture_update_needed: { needed: false },
  thread_responses: [],
  summary: "No issues found (mock).",
};

const emptyDetailResponse = {
  detail_comments: [],
  thread_responses: [],
  summary: "No issues found (mock).",
};

export const mockAgentRunnerEmpty: AgentRunner = async (options) => {
  const payload =
    options.pass === "architecture" ? emptyArchResponse : emptyDetailResponse;

  return JSON.stringify({ result: JSON.stringify(payload) });
};

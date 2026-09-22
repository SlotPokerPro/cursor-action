import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { info, warning } from "@actions/core";
import { Agent } from "@cursor/sdk";
import type { RunResult } from "@cursor/sdk";

import type { ActionInputs, AgentResult, TokenUsageStats } from "./types";

const FORCE_STOP_GRACE_MS = 15_000;
const DISPOSE_TIMEOUT_MS = 5000;

type CreatedAgent = Awaited<ReturnType<typeof Agent.create>>;
type AgentRun = Awaited<ReturnType<CreatedAgent["send"]>>;
type Timer = ReturnType<typeof setTimeout>;

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.cause
      ? `${error.message}\nCause: ${error.cause}`
      : error.message;
  }
  return String(error);
};

const mapUsage = (usage: RunResult["usage"]): TokenUsageStats | undefined => {
  if (!usage) {
    return undefined;
  }
  const {
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    totalTokens,
  } = usage;
  return {
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    totalTokens,
  };
};

const disposeAgent = async (agent: CreatedAgent): Promise<void> => {
  const dispose = (agent as { [Symbol.asyncDispose]?: () => Promise<void> })[
    Symbol.asyncDispose
  ];
  if (typeof dispose !== "function") {
    return;
  }

  await Promise.race([
    Promise.resolve(dispose.call(agent)).catch((error: unknown) => {
      warning(`Failed to dispose Cursor agent: ${extractErrorMessage(error)}`);
    }),
    delay(DISPOSE_TIMEOUT_MS),
  ]);
};

const clearTimer = (timer: Timer | undefined): void => {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
};

const appendError = (stderr: string, message: string): string => {
  warning(message);
  return stderr ? `${stderr}\n${message}` : message;
};

interface CollectedRun {
  durationMs: number | undefined;
  exitCode: number;
  status: string;
  stderr: string;
  stdout: string;
  usage: TokenUsageStats | undefined;
}

const collectRun = async (
  run: AgentRun,
  wasTimedOut: () => boolean,
  timeoutSeconds: number
): Promise<CollectedRun> => {
  let stdout = "";
  for await (const event of run.stream()) {
    if ("text" in event && typeof event.text === "string") {
      stdout += event.text;
    }
  }

  const runResult = await run.wait();
  if (runResult.result && typeof runResult.result === "string") {
    stdout = runResult.result;
  }

  let stderr = "";
  let exitCode = 0;
  if (runResult.status === "error") {
    exitCode = 1;
    stderr = appendError(
      stderr,
      runResult.error?.message ?? "Agent run failed with error."
    );
  } else if (runResult.status === "cancelled") {
    exitCode = 1;
    stderr = appendError(
      stderr,
      wasTimedOut()
        ? `Agent run timed out after ${timeoutSeconds}s and was cancelled.`
        : "Agent run was cancelled."
    );
  }

  return {
    durationMs: runResult.durationMs,
    exitCode,
    status: runResult.status,
    stderr,
    stdout,
    usage: mapUsage(runResult.usage),
  };
};

const scheduleTimeout = (
  run: AgentRun,
  timeoutMs: number,
  timeoutSeconds: number,
  onTimeout: () => void
): { cancelTimer: Timer; getForceStopTimer: () => Timer | undefined } => {
  let forceStopTimer: Timer | undefined;
  const cancelTimer = setTimeout(() => {
    onTimeout();
    void (async () => {
      if (run.supports("cancel")) {
        try {
          await run.cancel();
        } catch {
          // Best-effort cancel on timeout; errors are surfaced via stream/result.
        }
      }
    })();
    // Cancel does not unblock a stuck stream. Exit if it is still running.
    forceStopTimer = setTimeout(() => {
      warning(
        `Agent run timed out after ${timeoutSeconds}s and did not stop. Exiting.`
      );
      process.exit(1);
    }, FORCE_STOP_GRACE_MS);
  }, timeoutMs);

  return {
    cancelTimer,
    getForceStopTimer: () => forceStopTimer,
  };
};

export const runAgent = async (inputs: ActionInputs): Promise<AgentResult> => {
  const cwd = path.resolve(inputs.workingDirectory);

  info(`Running Cursor Agent in: ${cwd}`);
  info(`Model: ${inputs.model}`);
  if (inputs.permissions !== "read-only") {
    warning(
      "The `permissions` input is not passed to Cursor SDK Agent.create; " +
        "tool access follows your API key / account, not this field."
    );
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let status = "finished";
  let durationMs: number | undefined;
  let usage: TokenUsageStats | undefined;
  let agent: CreatedAgent | undefined;
  let cancelTimer: Timer | undefined;
  let getForceStopTimer: (() => Timer | undefined) | undefined;

  try {
    agent = await Agent.create({
      apiKey: inputs.apiKey,
      local: { cwd },
      model: { id: inputs.model },
    });

    const run = await agent.send(inputs.prompt);
    const timeoutMs = inputs.timeout * 1000;
    let timedOut = false;

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      ({ cancelTimer, getForceStopTimer } = scheduleTimeout(
        run,
        timeoutMs,
        inputs.timeout,
        () => {
          timedOut = true;
        }
      ));
    }

    try {
      const collected = await collectRun(run, () => timedOut, inputs.timeout);
      ({ durationMs, exitCode, status, stderr, stdout, usage } = collected);
    } finally {
      clearTimer(cancelTimer);
      clearTimer(getForceStopTimer?.());
    }
  } catch (error) {
    exitCode = 1;
    status = "error";
    stderr = appendError(stderr, extractErrorMessage(error));
  } finally {
    clearTimer(cancelTimer);
    clearTimer(getForceStopTimer?.());
    if (agent !== undefined) {
      await disposeAgent(agent);
    }
  }

  return {
    diagnostics: exitCode === 0 ? undefined : stderr,
    durationMs,
    exitCode,
    status,
    stderr,
    stdout,
    usage,
  };
};

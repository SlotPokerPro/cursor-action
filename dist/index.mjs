import { endGroup, getInput, info, setFailed, setOutput, setSecret, startGroup, summary, warning } from "@actions/core";
import path from "node:path";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { Agent } from "@cursor/sdk";
//#region src/input.ts
const VALID_PERMISSIONS = [
	"read-only",
	"read-write",
	"full"
];
const getInputs = () => {
	const cursorVersionRaw = getInput("cursor-version", { required: false });
	const cursorVersion = cursorVersionRaw.trim().length > 0 ? cursorVersionRaw.trim() : void 0;
	const apiKey = getInput("api-key", { required: true });
	const prompt = getInput("prompt", { required: true });
	const model = getInput("model", { required: false }) || "default";
	const workingDirectory = getInput("working-directory", { required: false }) || ".";
	const permissionsRaw = getInput("permissions", { required: false }) || "read-only";
	const timeoutRaw = getInput("timeout", { required: false }) || "300";
	if (cursorVersion && cursorVersion !== "latest") warning("The 'cursor-version' input is deprecated. The Action now uses the official @cursor/sdk which automatically manages the agent version.");
	if (!VALID_PERMISSIONS.includes(permissionsRaw)) throw new Error(`Invalid 'permissions' value: '${permissionsRaw}'. Must be one of: ${VALID_PERMISSIONS.join(", ")}`);
	const timeout = Math.trunc(Number(timeoutRaw));
	if (Number.isNaN(timeout) || timeout <= 0) throw new Error(`Invalid 'timeout' value: '${timeoutRaw}'. Must be a positive integer (seconds).`);
	if (timeout > 3600) warning(`Timeout is set to ${timeout}s (${Math.round(timeout / 60)}min). This is unusually long. Consider if your prompt can be shortened.`);
	if (!prompt.trim()) throw new Error("The 'prompt' input cannot be empty.");
	return {
		apiKey,
		...cursorVersion === void 0 ? {} : { cursorVersion },
		model,
		permissions: permissionsRaw,
		prompt,
		timeout,
		workingDirectory
	};
};
//#endregion
//#region src/output.ts
const parseSummary = (stdout) => {
	const trimmed = stdout.trim();
	if (!trimmed) return "";
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed === "object" && parsed !== null) {
			if (typeof parsed.response === "string") return parsed.response.trim();
			if (typeof parsed.summary === "string") return parsed.summary.trim();
			if (typeof parsed.result === "string") return parsed.result.trim();
			if (typeof parsed.output === "string") return parsed.output.trim();
			if (typeof parsed.text === "string") return parsed.text.trim();
		}
	} catch {}
	return trimmed.replaceAll(/\u001B\[[0-9;]*[mGKHF]/gu, "");
};
const buildSummaryTableRows = (result) => {
	const rows = [["Status", result.exitCode === 0 ? "✅ Success" : `❌ Failed (exit ${result.exitCode})`], ["Exit Code", String(result.exitCode)]];
	if (result.status) rows.push(["Agent Status", result.status]);
	if (result.durationMs !== void 0) rows.push(["Duration", `${(result.durationMs / 1e3).toFixed(1)}s`]);
	const { usage } = result;
	if (usage?.inputTokens !== void 0) rows.push(["Input Tokens", String(usage.inputTokens)]);
	if (usage?.outputTokens !== void 0) rows.push(["Output Tokens", String(usage.outputTokens)]);
	if (usage?.cacheReadTokens !== void 0 && usage.cacheReadTokens > 0) rows.push(["Cache Read Tokens", String(usage.cacheReadTokens)]);
	if (usage?.totalTokens !== void 0) rows.push(["Total Tokens", String(usage.totalTokens)]);
	return rows;
};
const writeJobSummary = async (text, result) => {
	const tableRows = buildSummaryTableRows(result);
	await summary.addHeading("Cursor Agent Run", 2).addTable([[{
		data: "Field",
		header: true
	}, {
		data: "Value",
		header: true
	}], ...tableRows]).addHeading("Agent Response", 3).addRaw(text ? `\n\`\`\`\n${text}\n\`\`\`\n` : "_No output was produced._");
	const errText = result.stderr.trim();
	if (errText) await summary.addHeading("Agent Error (stderr)", 3).addRaw(`\n\`\`\`\n${errText.slice(0, 2e4)}${errText.length > 2e4 ? "\n… (truncated)" : ""}\n\`\`\`\n`);
	const diag = result.diagnostics?.trim();
	if (diag && diag !== errText) await summary.addHeading("Diagnostics", 3).addRaw(`\n\`\`\`\n${diag.slice(0, 2e4)}${diag.length > 2e4 ? "\n… (truncated)" : ""}\n\`\`\`\n`);
	await summary.write();
};
const setMetricOutputs = (result) => {
	if (result.durationMs !== void 0) setOutput("duration-ms", String(result.durationMs));
	const { usage } = result;
	if (usage?.totalTokens !== void 0) setOutput("total-tokens", String(usage.totalTokens));
	if (usage?.inputTokens !== void 0) setOutput("input-tokens", String(usage.inputTokens));
	if (usage?.outputTokens !== void 0) setOutput("output-tokens", String(usage.outputTokens));
};
const setOutputs = async (result) => {
	const text = parseSummary(result.stdout);
	const status = result.status ?? (result.exitCode === 0 ? "finished" : "error");
	setOutput("summary", text);
	setOutput("exit-code", String(result.exitCode));
	setOutput("status", status);
	setMetricOutputs(result);
	await writeJobSummary(text, result);
	const { usage } = result;
	return {
		durationMs: result.durationMs,
		exitCode: result.exitCode,
		inputTokens: usage?.inputTokens,
		outputTokens: usage?.outputTokens,
		status,
		summary: text,
		totalTokens: usage?.totalTokens
	};
};
const maskSecret = (apiKey) => setSecret(apiKey);
//#endregion
//#region src/runner.ts
const FORCE_STOP_GRACE_MS = 15e3;
const DISPOSE_TIMEOUT_MS = 5e3;
const extractErrorMessage = (error) => {
	if (error instanceof Error) return error.cause ? `${error.message}\nCause: ${error.cause}` : error.message;
	return String(error);
};
const mapUsage = (usage) => {
	if (!usage) return;
	const { cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens, totalTokens } = usage;
	return {
		cacheReadTokens,
		cacheWriteTokens,
		inputTokens,
		outputTokens,
		totalTokens
	};
};
const disposeAgent = async (agent) => {
	const dispose = agent[Symbol.asyncDispose];
	if (typeof dispose !== "function") return;
	await Promise.race([Promise.resolve(dispose.call(agent)).catch((error) => {
		warning(`Failed to dispose Cursor agent: ${extractErrorMessage(error)}`);
	}), setTimeout$1(DISPOSE_TIMEOUT_MS)]);
};
const clearTimer = (timer) => {
	if (timer !== void 0) clearTimeout(timer);
};
const appendError = (stderr, message) => {
	warning(message);
	return stderr ? `${stderr}\n${message}` : message;
};
const collectRun = async (run, wasTimedOut, timeoutSeconds) => {
	let stdout = "";
	for await (const event of run.stream()) if ("text" in event && typeof event.text === "string") stdout += event.text;
	const runResult = await run.wait();
	if (runResult.result && typeof runResult.result === "string") stdout = runResult.result;
	let stderr = "";
	let exitCode = 0;
	if (runResult.status === "error") {
		exitCode = 1;
		stderr = appendError(stderr, runResult.error?.message ?? "Agent run failed with error.");
	} else if (runResult.status === "cancelled") {
		exitCode = 1;
		stderr = appendError(stderr, wasTimedOut() ? `Agent run timed out after ${timeoutSeconds}s and was cancelled.` : "Agent run was cancelled.");
	}
	return {
		durationMs: runResult.durationMs,
		exitCode,
		status: runResult.status,
		stderr,
		stdout,
		usage: mapUsage(runResult.usage)
	};
};
const scheduleTimeout = (run, timeoutMs, timeoutSeconds, onTimeout) => {
	let forceStopTimer;
	return {
		cancelTimer: setTimeout(() => {
			onTimeout();
			(async () => {
				if (run.supports("cancel")) try {
					await run.cancel();
				} catch {}
			})();
			forceStopTimer = setTimeout(() => {
				warning(`Agent run timed out after ${timeoutSeconds}s and did not stop. Exiting.`);
				process.exit(1);
			}, FORCE_STOP_GRACE_MS);
		}, timeoutMs),
		getForceStopTimer: () => forceStopTimer
	};
};
const runAgent = async (inputs) => {
	const cwd = path.resolve(inputs.workingDirectory);
	info(`Running Cursor Agent in: ${cwd}`);
	info(`Model: ${inputs.model}`);
	if (inputs.permissions !== "read-only") warning("The `permissions` input is not passed to Cursor SDK Agent.create; tool access follows your API key / account, not this field.");
	let stdout = "";
	let stderr = "";
	let exitCode = 0;
	let status = "finished";
	let durationMs;
	let usage;
	let agent;
	let cancelTimer;
	let getForceStopTimer;
	try {
		agent = await Agent.create({
			apiKey: inputs.apiKey,
			local: { cwd },
			model: { id: inputs.model }
		});
		const run = await agent.send(inputs.prompt);
		const timeoutMs = inputs.timeout * 1e3;
		let timedOut = false;
		if (timeoutMs > 0 && Number.isFinite(timeoutMs)) ({cancelTimer, getForceStopTimer} = scheduleTimeout(run, timeoutMs, inputs.timeout, () => {
			timedOut = true;
		}));
		try {
			const collected = await collectRun(run, () => timedOut, inputs.timeout);
			({durationMs, exitCode, status, stderr, stdout, usage} = collected);
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
		if (agent !== void 0) await disposeAgent(agent);
	}
	return {
		diagnostics: exitCode === 0 ? void 0 : stderr,
		durationMs,
		exitCode,
		status,
		stderr,
		stdout,
		usage
	};
};
//#endregion
//#region src/index.ts
const exitAfterFlush = (code) => {
	const kill = setTimeout(() => process.exit(code), 1e3);
	process.stdout.write("", () => {
		clearTimeout(kill);
		process.exit(code);
	});
};
const run = async () => {
	let code = 0;
	try {
		const inputs = getInputs();
		maskSecret(inputs.apiKey);
		startGroup("🤖 Running cursor-agent");
		const result = await runAgent(inputs);
		endGroup();
		const outputs = await setOutputs(result);
		if (outputs.exitCode !== 0) {
			code = outputs.exitCode;
			setFailed(`cursor-agent exited with code ${outputs.exitCode}. See the job summary for details.`);
		}
	} catch (error) {
		code = 1;
		if (error instanceof Error) setFailed(error.message);
		else setFailed(String(error));
	} finally {
		exitAfterFlush(code);
	}
};
run();
//#endregion
export { run };

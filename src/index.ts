import { endGroup, setFailed, startGroup } from "@actions/core";

import { getInputs } from "./input";
import { maskSecret, setOutputs } from "./output";
import { runAgent } from "./runner";

const exitAfterFlush = (code: number): void => {
  const kill = setTimeout(() => process.exit(code), 1000);
  process.stdout.write("", () => {
    clearTimeout(kill);
    process.exit(code);
  });
};

export const run = async (): Promise<void> => {
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
      setFailed(
        `cursor-agent exited with code ${outputs.exitCode}. ` +
          `See the job summary for details.`
      );
    }
  } catch (error) {
    code = 1;
    if (error instanceof Error) {
      setFailed(error.message);
    } else {
      setFailed(String(error));
    }
  } finally {
    // The SDK keeps the local agent process open after the run returns,
    // which otherwise leaves this step running with no further logs.
    exitAfterFlush(code);
  }
};

run();

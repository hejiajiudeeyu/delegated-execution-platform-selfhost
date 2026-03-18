import { afterAll } from "vitest";

import { writeFlowReport } from "../helpers/flow-step.js";

afterAll(() => {
  writeFlowReport();
});

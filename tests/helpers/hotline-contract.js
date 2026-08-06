// What a hotline has to declare before it can be published (FR-010, FR-013).
//
// Fixtures used to register hotlines with no schemas, no examples and no stated
// limits — the same shape production was in — and approval accepted them. Now
// approval refuses, so fixtures have to declare a real contract. Keeping that
// in one place means the requirement is stated once rather than copied into
// every test that happens to approve something.
export function publishableContract(overrides = {}) {
  return {
    input_schema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: { text: { type: "string" } }
    },
    output_schema: {
      type: "object",
      required: ["summary"],
      additionalProperties: false,
      properties: { summary: { type: "string" } }
    },
    input_examples: [{ title: "Basic request", input: { text: "some text to work on" } }],
    output_examples: [{ title: "Basic result", output: { summary: "a short summary" } }],
    limitations: ["fixture hotline: not for production traffic"],
    ...overrides
  };
}

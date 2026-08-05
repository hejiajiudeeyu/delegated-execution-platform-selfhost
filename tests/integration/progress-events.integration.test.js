// FR-036 progress observations, platform side.
//
// A long call used to be a black box between ACKED and COMPLETED: the only
// signal an operator had was the absence of a terminal event, and the stuck
// guardrail could not tell "legitimately grinding through page 40" from
// "died an hour ago". PROGRESS/SOFT_TIMEOUT are observations a device may
// append while it runs — and only while it runs. The invariants under test:
// observations never touch billing, never move the execution projection,
// never survive past terminal, and can never crowd out the lifecycle events
// the projection is built from.
import { describe, expect, it } from "vitest";

import { OBSERVATIONAL_REQUEST_EVENT, REQUEST_PROGRESS_STAGE } from "@delexec/contracts";
import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

describe("progress events (platform)", () => {
  const cleanup = [];

  async function scenario(name) {
    const state = createPlatformState({ adminApiKey: `sk_admin_${name}`, bootstrapEnabled: true });
    const responder = state.bootstrap.responders[0];
    const server = createPlatformServer({ serviceName: `progress-${name}`, state });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: `${name}@test.local` }
    });
    const requestId = `req_${name}`;
    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: { Authorization: `Bearer ${caller.body.api_key}` },
      body: { request_id: requestId, responder_id: responder.responder_id, hotline_id: responder.hotline_id }
    });
    expect(token.status).toBe(201);

    const responderHeaders = { Authorization: `Bearer ${responder.api_key}` };
    return {
      state,
      baseUrl,
      responder,
      requestId,
      responderHeaders,
      adminHeaders: { Authorization: `Bearer ${state.adminApiKey}` },
      postEvent: (body) =>
        jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
          method: "POST",
          headers: responderHeaders,
          body: {
            responder_id: responder.responder_id,
            hotline_id: responder.hotline_id,
            ...body
          }
        }),
      postProgress: (progress) =>
        jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
          method: "POST",
          headers: responderHeaders,
          body: {
            responder_id: responder.responder_id,
            hotline_id: responder.hotline_id,
            event_type: OBSERVATIONAL_REQUEST_EVENT.PROGRESS,
            progress
          }
        }),
      ack: () =>
        jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
          method: "POST",
          headers: responderHeaders,
          body: { responder_id: responder.responder_id, hotline_id: responder.hotline_id, eta_hint_s: 5 }
        }),
      detail: () => jsonRequest(baseUrl, `/v1/admin/requests/${requestId}`, { headers: { Authorization: `Bearer ${state.adminApiKey}` } })
    };
  }

  async function teardown() {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  }

  it("records a progress beat and shows it in the call detail timeline", async () => {
    const ctx = await scenario("record");
    try {
      await ctx.ack();
      const posted = await ctx.postProgress({
        seq: 0,
        stage: REQUEST_PROGRESS_STAGE.EXECUTING,
        percent: 40,
        message: "page 4 of 10",
        attempt_id: "attempt_a"
      });
      expect(posted.status).toBe(202);
      expect(posted.body.event.progress.stage).toBe("executing");

      const detail = await ctx.detail();
      expect(detail.status).toBe(200);
      const progressRows = detail.body.timeline.filter((event) => event.event_type === "PROGRESS");
      expect(progressRows).toHaveLength(1);
      expect(progressRows[0].progress).toMatchObject({ seq: 0, stage: "executing", percent: 40 });
      // The observation must not have moved the execution axis.
      expect(detail.body.state.execution.value).toBe("executing");
    } finally {
      await teardown();
    }
  });

  it("refuses a malformed progress payload with the registered error code", async () => {
    const ctx = await scenario("malformed");
    try {
      const missingSeq = await ctx.postProgress({ stage: REQUEST_PROGRESS_STAGE.EXECUTING });
      expect(missingSeq.status).toBe(400);
      expect(missingSeq.body.error.code).toBe("CONTRACT_INVALID_PROGRESS");

      const sideChannel = await ctx.postProgress({
        seq: 0,
        stage: REQUEST_PROGRESS_STAGE.EXECUTING,
        output_preview: "smuggled"
      });
      expect(sideChannel.status).toBe(400);
      expect(sideChannel.body.error.code).toBe("CONTRACT_INVALID_PROGRESS");

      const detail = await ctx.detail();
      expect(detail.body.timeline.filter((event) => event.event_type === "PROGRESS")).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it("dedupes a replayed (attempt_id, seq) beat instead of recording it twice", async () => {
    const ctx = await scenario("dedupe");
    try {
      const beat = { seq: 1, stage: REQUEST_PROGRESS_STAGE.EXECUTING, attempt_id: "attempt_a" };
      expect((await ctx.postProgress(beat)).status).toBe(202);
      const replay = await ctx.postProgress(beat);
      expect(replay.status).toBe(202);
      expect(replay.body.deduped).toBe(true);

      // A new attempt may reuse seq numbers: retries are distinct attempts.
      const otherAttempt = await ctx.postProgress({ ...beat, attempt_id: "attempt_b" });
      expect(otherAttempt.status).toBe(202);
      expect(otherAttempt.body.deduped).toBeUndefined();

      const detail = await ctx.detail();
      expect(detail.body.timeline.filter((event) => event.event_type === "PROGRESS")).toHaveLength(2);
    } finally {
      await teardown();
    }
  });

  it("refuses observations once execution is terminal", async () => {
    const ctx = await scenario("terminal");
    try {
      const completed = await ctx.postEvent({ event_type: "COMPLETED", status: "ok" });
      expect(completed.status).toBe(202);

      const late = await ctx.postProgress({ seq: 9, stage: REQUEST_PROGRESS_STAGE.OUTPUT_UPLOADING });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("CONTRACT_EXECUTION_TERMINAL");

      const lateSoftTimeout = await ctx.postEvent({ event_type: "SOFT_TIMEOUT", message: "still running" });
      expect(lateSoftTimeout.status).toBe(409);

      const detail = await ctx.detail();
      expect(detail.body.timeline.filter((event) => event.event_type === "PROGRESS")).toHaveLength(0);
      expect(detail.body.state.execution.value).toBe("delivered");
    } finally {
      await teardown();
    }
  });

  it("prunes only progress rows, never the lifecycle events under them", async () => {
    const ctx = await scenario("prune");
    const previousLimit = process.env.PLATFORM_REQUEST_PROGRESS_HISTORY_LIMIT;
    process.env.PLATFORM_REQUEST_PROGRESS_HISTORY_LIMIT = "3";
    try {
      await ctx.ack();
      for (let seq = 0; seq < 8; seq += 1) {
        const posted = await ctx.postProgress({ seq, stage: REQUEST_PROGRESS_STAGE.EXECUTING, attempt_id: "attempt_a" });
        expect(posted.status).toBe(202);
      }

      const detail = await ctx.detail();
      const progressRows = detail.body.timeline.filter((event) => event.event_type === "PROGRESS");
      expect(progressRows).toHaveLength(3);
      // The newest beats survive; the oldest are the ones a reader can spare.
      expect(progressRows.map((event) => event.progress.seq)).toEqual([5, 6, 7]);
      // The lifecycle skeleton is intact: creation and ACK are still there,
      // and the projection still reads from them.
      expect(detail.body.timeline.some((event) => event.event_type === "TASK_TOKEN_ISSUED")).toBe(true);
      expect(detail.body.timeline.some((event) => event.event_type === "ACKED")).toBe(true);
      expect(detail.body.state.execution.value).toBe("executing");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.PLATFORM_REQUEST_PROGRESS_HISTORY_LIMIT;
      } else {
        process.env.PLATFORM_REQUEST_PROGRESS_HISTORY_LIMIT = previousLimit;
      }
      await teardown();
    }
  });

  it("accepts SOFT_TIMEOUT (previously a silent 400) and dedupes the repeat", async () => {
    const ctx = await scenario("soft_timeout");
    try {
      await ctx.ack();
      const posted = await ctx.postEvent({
        event_type: OBSERVATIONAL_REQUEST_EVENT.SOFT_TIMEOUT,
        status: "running",
        message: "task exceeded soft timeout and is still running"
      });
      expect(posted.status).toBe(202);
      expect(posted.body.event.message).toContain("soft timeout");

      const repeat = await ctx.postEvent({ event_type: OBSERVATIONAL_REQUEST_EVENT.SOFT_TIMEOUT, message: "again" });
      expect(repeat.status).toBe(202);
      expect(repeat.body.deduped).toBe(true);

      const detail = await ctx.detail();
      expect(detail.body.timeline.filter((event) => event.event_type === "SOFT_TIMEOUT")).toHaveLength(1);
      // Still an observation: execution stays where the lifecycle put it.
      expect(detail.body.state.execution.value).toBe("executing");
    } finally {
      await teardown();
    }
  });

  it("a progressing call is not flagged stuck; a silent one still is", async () => {
    const ctx = await scenario("stuck_freshness");
    try {
      await ctx.ack();
      const request = ctx.state.requests.get(ctx.requestId);
      // Age everything the platform wrote well past the stuck grace window.
      for (const event of request.events) {
        event.at = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      }

      const stuckBefore = await jsonRequest(ctx.baseUrl, "/v1/admin/attention", { headers: ctx.adminHeaders });
      expect(JSON.stringify(stuckBefore.body.items)).toContain(ctx.requestId);

      // One fresh beat from the device and the call is alive again — that is
      // exactly the distinction the guardrail could not draw before FR-036.
      const posted = await ctx.postProgress({ seq: 0, stage: REQUEST_PROGRESS_STAGE.EXECUTING, percent: 10 });
      expect(posted.status).toBe(202);

      const stuckAfter = await jsonRequest(ctx.baseUrl, "/v1/admin/attention", { headers: ctx.adminHeaders });
      expect(JSON.stringify(stuckAfter.body.items)).not.toContain(ctx.requestId);
    } finally {
      await teardown();
    }
  });
});

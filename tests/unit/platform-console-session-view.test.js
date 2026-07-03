import { describe, expect, it } from "vitest";

import {
  deriveSessionPhase,
  RECOVERY_CONFIRMATION_PHRASE,
  renderSessionPanelMarkup,
  validateRecoveryInput,
  validateSetupInput
} from "../../apps/platform-console/src/session-view.js";

describe("platform-console session view", () => {
  it("derives session phases from gateway state and browser token", () => {
    expect(deriveSessionPhase({ session: null, sessionToken: null })).toBe("unreachable");
    expect(deriveSessionPhase({ session: { setup_required: true }, sessionToken: null })).toBe("setup");
    expect(deriveSessionPhase({ session: { setup_required: false, authenticated: false }, sessionToken: null })).toBe("locked");
    expect(deriveSessionPhase({ session: { setup_required: false, authenticated: true }, sessionToken: null })).toBe("locked");
    expect(deriveSessionPhase({ session: { setup_required: false, authenticated: true }, sessionToken: "tok" })).toBe("unlocked");
  });

  it("renders setup phase with bootstrap secret guidance", () => {
    const html = renderSessionPanelMarkup({ phase: "setup" });
    expect(html).toContain("First-Time Setup Required");
    expect(html).toContain('id="session-new-passphrase"');
    expect(html).toContain('id="session-confirm-passphrase"');
    expect(html).toContain("PLATFORM_CONSOLE_BOOTSTRAP_SECRET");
    expect(html).toContain('data-session-action="setup"');
  });

  it("renders locked phase with unlock plus destructive recovery flow", () => {
    const html = renderSessionPanelMarkup({ phase: "locked" });
    expect(html).toContain('data-session-action="login"');
    expect(html).toContain("Lost passphrase?");
    expect(html).toContain("Destructive Recovery");
    expect(html).toContain("cannot be preserved");
    expect(html).toContain('id="session-recovery-confirm"');
    expect(html).toContain(`Type ${RECOVERY_CONFIRMATION_PHRASE} To Confirm`);
    expect(html).toContain('data-session-action="recover"');
  });

  it("renders unlocked phase with admin-credential next step when key is missing", () => {
    const blocked = renderSessionPanelMarkup({ phase: "unlocked", session: { expires_at: "2026-07-04T00:00:00Z" }, adminKeyConfigured: false });
    expect(blocked).toContain("Next Step: Save Admin Credential");
    expect(blocked).toContain('data-session-action="goto-credentials"');
    expect(blocked).toContain("2026-07-04T00:00:00Z");

    const ready = renderSessionPanelMarkup({ phase: "unlocked", adminKeyConfigured: true });
    expect(ready).toContain("Admin Credential Ready");
    expect(ready).not.toContain("Next Step: Save Admin Credential");
    expect(ready).toContain('data-session-action="change-passphrase"');
    expect(ready).toContain('data-session-action="logout"');
  });

  it("renders unreachable phase with a retry action", () => {
    const html = renderSessionPanelMarkup({ phase: "unreachable" });
    expect(html).toContain("Gateway Unreachable");
    expect(html).toContain('data-session-action="retry"');
  });

  it("never pre-fills secret values in rendered markup", () => {
    for (const phase of ["setup", "locked", "unlocked", "unreachable"]) {
      const html = renderSessionPanelMarkup({ phase });
      expect(html).not.toMatch(/type="password"[^>]*value="[^"]/);
    }
  });

  it("validates recovery input before the destructive call", () => {
    expect(validateRecoveryInput({ passphrase: "long-enough", confirmation: "RESET", bootstrapSecret: "" }).ok).toBe(false);
    expect(validateRecoveryInput({ passphrase: "short", confirmation: "RESET", bootstrapSecret: "boot" }).ok).toBe(false);
    expect(validateRecoveryInput({ passphrase: "long-enough", confirmation: "reset please", bootstrapSecret: "boot" }).ok).toBe(false);
    expect(validateRecoveryInput({ passphrase: "long-enough", confirmation: "RESET", bootstrapSecret: "boot" }).ok).toBe(true);
  });

  it("validates setup passphrase and confirmation", () => {
    expect(validateSetupInput({ passphrase: "short", confirmPassphrase: "short" }).ok).toBe(false);
    expect(validateSetupInput({ passphrase: "long-enough", confirmPassphrase: "different-one" }).ok).toBe(false);
    expect(validateSetupInput({ passphrase: "long-enough", confirmPassphrase: "long-enough" }).ok).toBe(true);
  });
});

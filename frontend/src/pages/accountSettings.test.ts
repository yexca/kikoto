import { describe, expect, it } from "vitest";

import { validatePasswordChange } from "./accountSettings";

describe("account password validation", () => {
  it("requires each password field", () => {
    expect(validatePasswordChange({ currentPassword: "", newPassword: "", confirmPassword: "" })).toBe(
      "Current password is required.",
    );
    expect(validatePasswordChange({ currentPassword: "old-password", newPassword: "", confirmPassword: "" })).toBe(
      "New password is required.",
    );
    expect(
      validatePasswordChange({ currentPassword: "old-password", newPassword: "new-password", confirmPassword: "" }),
    ).toBe("Confirm your new password.");
  });

  it("rejects a short, unchanged, or mismatched new password", () => {
    expect(
      validatePasswordChange({ currentPassword: "old-password", newPassword: "short", confirmPassword: "short" }),
    ).toBe("New password must be at least 8 characters.");
    expect(
      validatePasswordChange({
        currentPassword: "old-password",
        newPassword: "old-password",
        confirmPassword: "old-password",
      }),
    ).toBe("New password must differ from your current password.");
    expect(
      validatePasswordChange({
        currentPassword: "old-password",
        newPassword: "new-password",
        confirmPassword: "different",
      }),
    ).toBe("New passwords do not match.");
  });

  it("accepts a valid password change", () => {
    expect(
      validatePasswordChange({
        currentPassword: "old-password",
        newPassword: "new-password",
        confirmPassword: "new-password",
      }),
    ).toBeNull();
  });
});

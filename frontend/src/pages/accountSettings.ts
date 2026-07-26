export type PasswordChangeDraft = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export function validatePasswordChange(draft: PasswordChangeDraft): string | null {
  if (!draft.currentPassword) return "Current password is required.";
  if (!draft.newPassword) return "New password is required.";
  if (draft.newPassword.length < 8) return "New password must be at least 8 characters.";
  if (draft.newPassword === draft.currentPassword) return "New password must differ from your current password.";
  if (!draft.confirmPassword) return "Confirm your new password.";
  if (draft.newPassword !== draft.confirmPassword) return "New passwords do not match.";
  return null;
}

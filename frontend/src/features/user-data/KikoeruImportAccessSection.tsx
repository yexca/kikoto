import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

/**
 * The administrator policy for Kikoeru account imports: whether every account,
 * not only administrators, may make this server connect to a LAN address.
 */
export function KikoeruImportAccessSection({
  privateAddresses,
  readOnly,
  onChange,
  saveButton,
}: {
  privateAddresses: boolean;
  readOnly: boolean;
  onChange: (privateAddresses: boolean) => void;
  saveButton: ReactNode;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingsSection
      title={t("maintenance.library.kikoeruImport")}
      description={t("maintenance.library.kikoeruImportDescription")}
      footer={saveButton}
    >
      <SettingsRow
        title={t("maintenance.library.kikoeruPrivateAddresses")}
        description={t("maintenance.library.kikoeruPrivateAddressesDescription")}
      >
        <Switch
          checked={privateAddresses}
          disabled={readOnly}
          aria-label={t("maintenance.library.kikoeruPrivateAddresses")}
          onCheckedChange={(enabled) => (enabled ? setConfirming(true) : onChange(false))}
        />
      </SettingsRow>
      {confirming && (
        <Dialog onClose={() => setConfirming(false)} layer="sheet" size="lg" role="alertdialog">
          <DialogHeader
            title={t("maintenance.library.kikoeruPrivateEnableTitle")}
            description={t("maintenance.library.kikoeruPrivateEnableDescription")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t("maintenance.cancel")}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                onChange(true);
              }}
            >
              {t("maintenance.library.kikoeruPrivateEnable")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </SettingsSection>
  );
}

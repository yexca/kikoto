import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

/**
 * The administrator policy for Kikoeru account imports: whether every account,
 * not only administrators, may make this server connect to a LAN address.
 * Turning it on is confirmed first; the owner saves the choice.
 */
export function KikoeruImportAccessRow({
  privateAddresses,
  readOnly,
  onChange,
}: {
  privateAddresses: boolean;
  readOnly: boolean;
  onChange: (privateAddresses: boolean) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <SettingsRow
        title={t("maintenance.library.kikoeruPrivateAddresses")}
        description={`${t("maintenance.library.kikoeruImportDescription")} ${t("maintenance.library.kikoeruPrivateAddressesDescription")}`}
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
    </>
  );
}

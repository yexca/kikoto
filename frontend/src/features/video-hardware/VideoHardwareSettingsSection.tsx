import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsNumberInput, SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Input } from "@/components/ui/input";
import type { VideoHardwareAcceleration, VideoHardwareStatus } from "@/lib/api";

/** The bounds of the server-wide number of conversions that run at once. */
export const TRANSCODE_SLOTS_MINIMUM = 1;
export const TRANSCODE_SLOTS_MAXIMUM = 5;

/**
 * Administrator settings for playback conversion: how many conversions run at
 * once across the server, and the GPU encoder for converted video with the
 * server's check of the saved choice. The server encodes in software whenever
 * the encoder is off, unavailable, or fails.
 */
export function VideoHardwareSettingsSection({
  transcodeSlots,
  acceleration,
  device,
  status,
  readOnly,
  onChange,
  saveButton,
}: {
  transcodeSlots: number;
  acceleration: VideoHardwareAcceleration;
  device: string;
  status?: VideoHardwareStatus;
  readOnly: boolean;
  onChange: (next: {
    transcodeSlots?: number;
    videoHardwareAcceleration?: VideoHardwareAcceleration;
    videoHardwareDevice?: string;
  }) => void;
  saveButton: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection
      title={t("maintenance.cache.videoHardware")}
      description={t("maintenance.cache.videoHardwareDescription")}
      footer={saveButton}
    >
      <SettingsRow
        title={t("maintenance.cache.transcodeSlots")}
        description={t("maintenance.cache.transcodeSlotsDescription")}
      >
        <SettingsNumberInput
          disabled={readOnly}
          label={t("maintenance.cache.transcodeSlots")}
          value={transcodeSlots}
          min={TRANSCODE_SLOTS_MINIMUM}
          max={TRANSCODE_SLOTS_MAXIMUM}
          integer
          onChange={(next) => onChange({ transcodeSlots: next })}
        />
      </SettingsRow>
      <SettingsRow
        title={t("maintenance.cache.videoHardwareEncoder")}
        description={t("maintenance.cache.videoHardwareEncoderDescription")}
      >
        <FloatingSelect
          value={acceleration}
          options={[
            { value: "none", label: t("maintenance.cache.videoHardwareNone") },
            { value: "vaapi", label: t("maintenance.cache.videoHardwareVaapi") },
            { value: "qsv", label: t("maintenance.cache.videoHardwareQsv") },
          ]}
          onValueChange={(value) =>
            onChange({ videoHardwareAcceleration: value === "qsv" || value === "vaapi" ? value : "none" })
          }
          ariaLabel={t("maintenance.cache.videoHardwareEncoder")}
          disabled={readOnly}
        />
      </SettingsRow>
      {acceleration !== "none" && (
        <SettingsRow
          title={t("maintenance.cache.videoHardwareDevice")}
          description={t("maintenance.cache.videoHardwareDeviceDescription")}
        >
          <Input
            value={device}
            disabled={readOnly}
            autoComplete="off"
            spellCheck={false}
            aria-label={t("maintenance.cache.videoHardwareDevice")}
            className="w-48 font-mono sm:w-56"
            onChange={(event) => onChange({ videoHardwareDevice: event.target.value })}
          />
        </SettingsRow>
      )}
      {status && status.state !== "disabled" && (
        <SettingsRow
          title={t("maintenance.cache.videoHardwareStatus")}
          description={videoHardwareStatusDetail(status, t)}
        >
          <Badge
            variant={status.state === "ready" ? "success" : status.state === "unavailable" ? "warning" : "secondary"}
          >
            {t(`maintenance.cache.videoHardwareState.${status.state}`)}
          </Badge>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

function videoHardwareStatusDetail(status: VideoHardwareStatus, t: (key: string) => string) {
  if (status.state === "ready") {
    return status.lowPower
      ? t("maintenance.cache.videoHardwareReadyLowPower")
      : t("maintenance.cache.videoHardwareReadyDetail");
  }
  if (status.state === "unavailable") {
    switch (status.reason) {
      case "device_missing":
        return t("maintenance.cache.videoHardwareReason.deviceMissing");
      case "encoder_missing":
        return t("maintenance.cache.videoHardwareReason.encoderMissing");
      case "keyframes_unaligned":
        return t("maintenance.cache.videoHardwareReason.keyframesUnaligned");
      default:
        return t("maintenance.cache.videoHardwareReason.encodeFailed");
    }
  }
  return t("maintenance.cache.videoHardwareCheckingDetail");
}

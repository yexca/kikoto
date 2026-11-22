import { Check, ChevronDown, FolderTree, Languages } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import {
  metadataLanguageChoices,
  metadataVariantLabel as metadataVariantLabelFor,
  resolveMetadataVariant,
} from "@/features/work-detail/metadataPresentationModel";
import { languageLabel, languageShortLabel } from "@/features/work-detail/workDetailHelpers";
import { openWorkCodeRoute } from "@/features/work-detail/workDetailShared";
import {
  groupWorkVersions,
  type WorkVersionAvailabilityScope,
  workVersionAvailableForScope,
  workVersionKindLabel,
  workVersionMediaState,
} from "@/features/work-detail/workVersionModel";
import i18n from "@/i18n";
import type { WorkDetail, WorkMetadataPresentation } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

type WorkVersion = WorkDetail["translations"][number];

/** The wide Hero's metadata-language and directory-edition chips, beside the work code. */
export function WorkVersionMenus({
  metadataLanguage,
  metadataPresentation,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  edition,
}: {
  metadataLanguage: string;
  metadataPresentation?: WorkMetadataPresentation;
  activeMetadataVariantKey: string;
  onMetadataVariantSelect?: (key: string) => void;
  edition: DirectoryEditionInput;
}) {
  return (
    <>
      <MetadataLanguageMenu
        metadataLanguage={metadataLanguage}
        metadataPresentation={metadataPresentation}
        activeMetadataVariantKey={activeMetadataVariantKey}
        onMetadataVariantSelect={onMetadataVariantSelect}
      />
      <DirectoryEditionMenu {...edition} />
    </>
  );
}

const versionChipClassName =
  "inline-flex h-[22px] min-w-0 max-w-full items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground";

/**
 * A chip naming the current language or edition. A narrow layout shows
 * `shortLabel`, such as a language code, while assistive technology and the
 * open menu keep the full name.
 */
function VersionChipMenu({
  icon,
  label,
  shortLabel,
  menuLabel,
  align = "start",
  chevron = true,
  className,
  children,
}: {
  icon: ReactNode;
  label: string;
  shortLabel?: string;
  menuLabel: string;
  align?: "start" | "end";
  /** A chip that leads a title leaves out its chevron to stay small. */
  chevron?: boolean;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const labelId = useId();
  const visibleLabel = shortLabel || label;
  // A span, so the chip can sit inside a heading; the menu itself renders in a portal.
  return (
    <span ref={anchorRef} className={cn("inline-block min-w-0 max-w-full", className)}>
      <button
        type="button"
        className={`${versionChipClassName} bg-background/60 font-medium transition-colors hover:border-primary hover:text-primary aria-expanded:border-primary aria-expanded:text-primary`}
        aria-label={menuLabel}
        aria-describedby={labelId}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={menuLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span className="truncate">{visibleLabel}</span>
        {chevron && <ChevronDown className="h-3 w-3 shrink-0" />}
      </button>
      <span id={labelId} hidden>
        {label}
      </span>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align={align}
        className="w-[min(21rem,calc(100vw-1.5rem))] p-0 text-sm"
      >
        <div role="dialog" aria-label={menuLabel} className="app-scroll max-h-[min(28rem,70vh)] overflow-y-auto p-2">
          <h4 className="flex items-center gap-2 px-2 pb-1.5 pt-0.5 text-xs font-medium text-muted-foreground">
            {icon}
            {menuLabel}
          </h4>
          {children(() => setOpen(false))}
        </div>
      </AnchoredPopover>
    </span>
  );
}

export function MetadataLanguageMenu({
  metadataLanguage,
  metadataPresentation,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  compact = false,
}: {
  metadataLanguage: string;
  metadataPresentation?: WorkMetadataPresentation;
  activeMetadataVariantKey: string;
  onMetadataVariantSelect?: (key: string) => void;
  /**
   * The phone title: a language code without a chevron that flows as the
   * title's first word, above the title's expand control.
   */
  compact?: boolean;
}) {
  const activeMetadataVariant = resolveMetadataVariant(metadataPresentation, activeMetadataVariantKey);
  const choices = metadataLanguageChoices(metadataPresentation, activeMetadataVariantKey);
  const activeChoice = choices.find((choice) => choice.variant.key === activeMetadataVariant?.key);
  const chipLabel = (short: boolean) =>
    activeChoice
      ? metadataVariantLabel(activeChoice.variant, short)
      : metadataLanguage
        ? (short ? languageShortLabel : languageLabel)(metadataLanguage)
        : "";
  const label = chipLabel(false);
  // A work with one metadata language has nothing to choose, so the chip takes no room.
  if (!label || choices.length < 2) return null;
  return (
    <VersionChipMenu
      icon={<Languages className="h-3 w-3 shrink-0" />}
      label={label}
      shortLabel={compact ? chipLabel(true) : undefined}
      menuLabel={i18n.t("libraryDetail.metadataLanguage")}
      chevron={!compact}
      // Inside the heading the chip keeps the interface font, not the title's.
      className={compact ? "relative z-10 mr-1.5 font-[family-name:var(--font-sans)]" : undefined}
    >
      {(close) => (
        <div role="menu" aria-label={i18n.t("libraryDetail.metadataLanguage")}>
          {choices.map((choice) => {
            const active = choice === activeChoice;
            return (
              <button
                key={choice.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left ${
                  active ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent hover:text-accent-foreground"
                }`}
                onClick={() => {
                  if (!active) onMetadataVariantSelect?.(choice.variant.key);
                  close();
                }}
              >
                <span className="truncate">{metadataVariantLabel(choice.variant)}</span>
                {active && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </VersionChipMenu>
  );
}

export type DirectoryEditionInput = {
  baseCode: string;
  baseAvailable: boolean;
  translations: WorkVersion[];
  activeVersionCode: string;
  onVersionSelect?: (translation: WorkVersion) => void;
  remoteVersions: boolean;
};

export type DirectoryEditionModel = DirectoryEditionInput & {
  availabilityScope: WorkVersionAvailabilityScope;
  collapsedGroups: ReturnType<typeof groupWorkVersions>;
  expandedGroups: ReturnType<typeof groupWorkVersions>;
  hiddenEditionCount: number;
  activeCode: string;
  /** The edition's full name, e.g. "Origin · Japanese" or "English". */
  label: string;
  /** The edition's language code, or its work code when its language is unknown. */
  shortLabel: string;
};

/**
 * The directory editions of a work, or null when there is nothing to choose:
 * no other edition, listed or merely known, and no base work.
 */
export function directoryEditionModel(input: DirectoryEditionInput): DirectoryEditionModel | null {
  const { baseCode, translations, activeVersionCode, remoteVersions } = input;
  if (!baseCode && translations.length === 0) return null;
  const availabilityScope: WorkVersionAvailabilityScope = remoteVersions ? "source" : "local";
  const collapsedGroups = groupWorkVersions(translations, {
    activeCode: activeVersionCode,
    remoteVersions,
    includeMetadataOnly: false,
    availabilityScope,
  });
  const expandedGroups = groupWorkVersions(translations, {
    activeCode: activeVersionCode,
    remoteVersions,
    includeMetadataOnly: true,
    availabilityScope,
  });
  const collapsedCodes = new Set(
    collapsedGroups.flatMap((group) => group.versions.map((version) => version.primaryCode.toUpperCase())),
  );
  const hiddenEditionCount = translations.filter(
    (version) => !collapsedCodes.has(version.primaryCode.toUpperCase()),
  ).length;
  const activeCode = activeVersionCode.trim().toUpperCase();
  const activeGroup = expandedGroups.find((group) =>
    group.versions.some((version) => version.primaryCode.trim().toUpperCase() === activeCode),
  );
  const activeVersion = activeGroup?.versions.find(
    (version) => version.primaryCode.trim().toUpperCase() === activeCode,
  );
  const hasOtherEdition =
    expandedGroups.some((group) =>
      group.versions.some((version) => version.primaryCode.trim().toUpperCase() !== activeCode),
    ) ||
    (baseCode !== "" && baseCode.trim().toUpperCase() !== activeCode);
  if (!hasOtherEdition) return null;
  const activeLanguage = activeGroup?.language ? languageLabel(activeGroup.language) : "";
  const label =
    activeVersion?.translationKind === "origin" && activeLanguage
      ? `${workVersionKindLabel(activeVersion)} · ${activeLanguage}`
      : activeLanguage || activeVersionCode;
  return {
    ...input,
    availabilityScope,
    collapsedGroups,
    expandedGroups,
    hiddenEditionCount,
    activeCode,
    label,
    shortLabel: activeGroup?.language ? languageShortLabel(activeGroup.language) : activeVersionCode,
  };
}

/** The wide Hero's directory-edition chip. */
function DirectoryEditionMenu(input: DirectoryEditionInput) {
  const model = directoryEditionModel(input);
  if (!model) return null;
  return (
    <VersionChipMenu
      icon={<FolderTree className="h-3 w-3 shrink-0" />}
      label={model.label}
      menuLabel={i18n.t("libraryDetail.directoryEdition")}
    >
      {(close) => <DirectoryEditionList model={model} onClose={close} />}
    </VersionChipMenu>
  );
}

/** The editions grouped by language, with the base work and every known edition behind a disclosure. */
export function DirectoryEditionList({ model, onClose }: { model: DirectoryEditionModel; onClose: () => void }) {
  const [showAllEditions, setShowAllEditions] = useState(false);
  const { baseCode, baseAvailable, onVersionSelect, availabilityScope, activeCode, hiddenEditionCount } = model;
  const groups = showAllEditions ? model.expandedGroups : model.collapsedGroups;

  const selectVersion = (translation: WorkVersion) => {
    const active = translation.primaryCode.trim().toUpperCase() === activeCode;
    if (active || !workVersionAvailableForScope(translation, availabilityScope)) return;
    onClose();
    if (onVersionSelect) {
      onVersionSelect(translation);
    } else {
      openWorkCodeRoute(translation.primaryCode);
    }
  };

  return (
    <div className="space-y-1">
      {baseCode && (
        <div className="px-2 text-xs">
          {baseAvailable ? (
            <button
              type="button"
              className="font-semibold text-primary hover:underline"
              onClick={() => {
                onClose();
                openWorkCodeRoute(baseCode);
              }}
            >
              {i18n.t("libraryDetail.baseCode", { code: baseCode })}
            </button>
          ) : (
            <span className="font-semibold text-muted-foreground">
              {i18n.t("libraryDetail.baseCode", { code: baseCode })}
            </span>
          )}
        </div>
      )}
      {groups.map((group) => {
        const language = group.language ? languageLabel(group.language) : i18n.t("libraryDetail.unknownLanguage");
        return (
          <div
            key={group.key}
            role="group"
            aria-label={i18n.t("libraryDetail.languageVersions", { language })}
            className="pt-1"
          >
            <div className="px-2 pb-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {language}
            </div>
            <div role="menu" aria-label={i18n.t("libraryDetail.languageCodes", { language })}>
              {group.versions.map((translation) => {
                const available = workVersionAvailableForScope(translation, availabilityScope);
                const active = translation.primaryCode.trim().toUpperCase() === activeCode;
                const stateLabel = workVersionStateLabel(translation, availabilityScope);
                return (
                  <button
                    key={translation.primaryCode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    aria-label={`${translation.primaryCode} ${workVersionKindLabel(translation)} ${stateLabel}`}
                    disabled={!active && !available}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left",
                      active
                        ? "bg-primary/10 text-primary"
                        : available
                          ? "hover:bg-accent hover:text-accent-foreground"
                          : "text-muted-foreground opacity-70",
                    )}
                    onClick={() => selectVersion(translation)}
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-semibold tabular-nums">{translation.primaryCode}</span>
                      <span className="ml-2 text-xs opacity-80">{workVersionKindLabel(translation)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs opacity-80">
                      {stateLabel}
                      {active && <Check className="h-4 w-4" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {hiddenEditionCount > 0 && (
        <button
          type="button"
          className="w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-primary hover:bg-accent"
          aria-expanded={showAllEditions}
          onClick={() => setShowAllEditions((shown) => !shown)}
        >
          {showAllEditions
            ? i18n.t("libraryDetail.hideAllEditions")
            : i18n.t("libraryDetail.showAllEditions", { count: hiddenEditionCount })}
        </button>
      )}
    </div>
  );
}

function metadataVariantLabel(variant: WorkMetadataPresentation["variants"][number], short = false) {
  return metadataVariantLabelFor(variant, {
    original: i18n.t("libraryDetail.original"),
    language: short ? languageShortLabel : languageLabel,
    omitOriginal: short,
  });
}

function workVersionStateLabel(version: WorkVersion, scope: WorkVersionAvailabilityScope) {
  const mediaState = workVersionMediaState(version);
  if (scope === "local" && !version.localAvailable) {
    return mediaState === "indexed_available"
      ? i18n.t("libraryDetail.remoteOnly")
      : i18n.t("detailActions.unavailable");
  }
  switch (mediaState) {
    case "indexed_available":
      return scope === "local" ? i18n.t("libraryDetail.ready") : i18n.t("content.available");
    case "present_unindexed":
      return i18n.t("libraryDetail.indexOnOpen");
    case "metadata_only":
      return i18n.t("libraryDetail.metadataOnly");
    default:
      return i18n.t("detailActions.unavailable");
  }
}

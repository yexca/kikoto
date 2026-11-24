import { useTranslation } from "react-i18next";

import { formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ListeningProfile, ListeningProfileTrait } from "@/lib/listeningApi";

import {
  PROFILE_WORK_MINIMUM,
  listeningProfileStatements,
  radarPoints,
  sharePercent,
  type ListeningProfileTraitKind,
  type RadarPoint,
} from "./listeningHistoryModel";

// A radar needs at least a triangle.
const RADAR_MINIMUM_TAGS = 3;
const RADAR_RADIUS = 78;
const RADAR_LABEL_LENGTH = 9;

const TRAIT_KINDS: readonly ListeningProfileTraitKind[] = ["duration", "release", "popularity", "rating"];

/**
 * What the account listens to, against the library it listens from: its most
 * preferred tags as a radar of how far each one's share of listening time
 * exceeds its share of the library, where its
 * works sit by duration, release, and popularity, how its ratings compare
 * with the public ones, and the same in a few sentences.
 */
export function ListeningProfileCard({
  profile,
  formatDuration,
}: {
  profile: ListeningProfile;
  formatDuration: (seconds: number) => string;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  if (profile.workCount === 0)
    return (
      <p className="theme-card-surface rounded-xl border bg-card px-4 py-8 text-center text-xs text-muted-foreground">
        {t("personal.history.noListeningInPeriod")}
      </p>
    );

  const traitValue = (kind: ListeningProfileTraitKind, value: number) => {
    if (kind === "duration") return formatDuration(value);
    if (kind === "release") return String(Math.floor(value));
    if (kind === "rating") return value.toFixed(1);
    return formatNumber(Math.round(value), resolvedLocale);
  };
  const traits = TRAIT_KINDS.flatMap((kind) => {
    const trait = profile[kind];
    return trait ? [{ kind, trait }] : [];
  });
  const statements = listeningProfileStatements(profile);

  return (
    <div className="theme-card-surface grid gap-x-8 gap-y-5 rounded-xl border bg-card p-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{t("personal.history.profile.tags")}</h3>
        {profile.tags.length >= RADAR_MINIMUM_TAGS ? (
          <TagRadar profile={profile} />
        ) : profile.tags.length > 0 ? (
          <p className="text-sm">{profile.tags.map((tag) => tag.name).join(" · ")}</p>
        ) : (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {profile.workCount < PROFILE_WORK_MINIMUM
              ? t("personal.history.profile.fewWorks")
              : t("personal.history.breakdown.emptyPreference")}
          </p>
        )}
      </div>
      <div className="min-w-0 space-y-4">
        {statements.length > 0 && (
          <div className="space-y-0.5 text-sm leading-6">
            {statements.map((statement, index) => (
              <p key={index}>
                {statement.kind === "tags"
                  ? t(`personal.history.profile.statements.tags.${statement.names.length === 1 ? "one" : "two"}`, {
                      first: statement.names[0],
                      second: statement.names[1],
                    })
                  : statement.kind === "lean"
                    ? t(`personal.history.profile.statements.${statement.trait}.${statement.side}`)
                    : t("personal.history.profile.statements.marks", {
                        count: statement.works,
                        finished: statement.finishedPercent,
                        relisten: statement.relistenPercent,
                      })}
              </p>
            ))}
          </div>
        )}
        {traits.length > 0 ? (
          <dl className="space-y-3.5">
            {traits.map(({ kind, trait }) => (
              <TraitRow
                key={kind}
                label={t(`personal.history.profile.traits.${kind}.label`)}
                low={t(`personal.history.profile.traits.${kind}.low`)}
                high={t(`personal.history.profile.traits.${kind}.high`)}
                trait={trait}
                detail={t(`personal.history.profile.${kind === "rating" ? "compareRating" : "compare"}`, {
                  mine: traitValue(kind, trait.value),
                  library: traitValue(kind, trait.libraryValue),
                  // Only the rating comparison names how many works it reads.
                  ...(kind === "rating" ? { count: trait.workCount } : {}),
                })}
              />
            ))}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">{t("personal.history.profile.fewWorks")}</p>
        )}
      </div>
    </div>
  );
}

/** One trait as a marker on a track whose middle is the library. */
function TraitRow({
  label,
  low,
  high,
  trait,
  detail,
}: {
  label: string;
  low: string;
  high: string;
  trait: ListeningProfileTrait;
  detail: string;
}) {
  const percent = Math.min(100, Math.max(0, trait.position * 100));
  return (
    <div className="min-w-0">
      <dt className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium">{label}</span>
        <span className="min-w-0 truncate text-2xs tabular-nums text-muted-foreground">{detail}</span>
      </dt>
      <dd>
        <span className="relative mt-2 block h-1.5 rounded-full bg-muted" aria-hidden="true">
          <span className="absolute left-1/2 top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/45" />
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
            style={{ left: `${percent}%` }}
          />
        </span>
        <span className="mt-1.5 flex justify-between text-2xs text-muted-foreground" aria-hidden="true">
          <span>{low}</span>
          <span>{high}</span>
        </span>
      </dd>
    </div>
  );
}

function polygon(points: readonly RadarPoint[]) {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

/**
 * The preferred tags as a radar: each axis is how far a tag's share of
 * listening time exceeds its share of the library's works, so a tag most of
 * the library carries does not outweigh one the account seeks out. Axes keep
 * a stable order rather than the ranking's. A list for assistive technology
 * carries both shares.
 */
function TagRadar({ profile }: { profile: ListeningProfile }) {
  const { t } = useTranslation();
  const tags = [...profile.tags].sort((left, right) => left.id - right.id);
  const excess = tags.map(
    (tag) =>
      (profile.listenedSeconds > 0 ? tag.listenedSeconds / profile.listenedSeconds : 0) -
      (profile.libraryWorkCount > 0 ? (tag.libraryWorkCount ?? 0) / profile.libraryWorkCount : 0),
  );
  const scale = Math.max(0, ...excess);
  const rim = radarPoints(
    tags.map(() => 1),
    1,
    RADAR_RADIUS,
  );
  const labels = radarPoints(
    tags.map(() => 1),
    1,
    RADAR_RADIUS + 12,
  );
  return (
    <figure className="min-w-0">
      <svg viewBox="-170 -112 340 224" className="mx-auto block w-full max-w-md" role="img" aria-hidden="true">
        {[1 / 3, 2 / 3, 1].map((step) => (
          <polygon
            key={step}
            points={polygon(rim.map((point) => ({ x: point.x * step, y: point.y * step })))}
            className="fill-none stroke-border"
            strokeWidth={1}
          />
        ))}
        {rim.map((point, index) => (
          <line key={index} x1={0} y1={0} x2={point.x} y2={point.y} className="stroke-border" strokeWidth={1} />
        ))}
        <polygon
          points={polygon(radarPoints(excess, scale, RADAR_RADIUS))}
          className="fill-primary/25 stroke-primary"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {tags.map((tag, index) => {
          const point = labels[index];
          const name =
            tag.name.length > RADAR_LABEL_LENGTH ? `${tag.name.slice(0, RADAR_LABEL_LENGTH - 1)}…` : tag.name;
          return (
            <text
              key={tag.id}
              x={point.x}
              y={point.y}
              textAnchor={point.x > 8 ? "start" : point.x < -8 ? "end" : "middle"}
              dominantBaseline={point.y > 8 ? "hanging" : point.y < -8 ? "auto" : "middle"}
              className="fill-foreground text-[11px]"
            >
              {name}
            </text>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-center text-2xs text-muted-foreground">
        {t("personal.history.profile.excess")}
      </figcaption>
      <ul className="sr-only">
        {profile.tags.map((tag) => (
          <li key={tag.id}>
            {t("personal.history.profile.tagShares", {
              name: tag.name,
              time: sharePercent(tag.listenedSeconds, profile.listenedSeconds),
              library: sharePercent(tag.libraryWorkCount ?? 0, profile.libraryWorkCount),
            })}
          </li>
        ))}
      </ul>
    </figure>
  );
}

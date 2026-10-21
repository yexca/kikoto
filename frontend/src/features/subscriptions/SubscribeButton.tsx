import { Bell, BellRing, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  api,
  ApiError,
  type CreatorSubscription,
  type CreatorSubscriptionLookup,
  type CreatorSubscriptionTarget,
} from "@/lib/api";

import { subscribeButtonState, subscribeConfirmation, subscriptionSubjectName } from "./subscriptionModel";

function targetKey(target: CreatorSubscriptionTarget) {
  return target.kind === "voice"
    ? `voice:${target.personId}`
    : `${target.kind}:${target.circleId}:${target.kind === "series" ? target.seriesId : ""}`;
}

/**
 * Subscribes the account to new releases of a circle, series, or voice
 * actor. Subscribing is separate from Favorite: a favorite is a preference, a
 * subscription adds new works to the Subscriptions feed.
 */
export function SubscribeButton({
  target,
  subjectName,
  canSubscribe,
  canPullNow,
  onOpenSubscriptions,
  className,
}: {
  target: CreatorSubscriptionTarget;
  subjectName: string;
  /** Subscriptions are personal state (`favorites:write`); Demo is read-only. */
  canSubscribe: boolean;
  /** `metadata:sync`: the catalog may be pulled now to set the baseline. */
  canPullNow: boolean;
  onOpenSubscriptions: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [lookup, setLookup] = useState<CreatorSubscriptionLookup | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const key = targetKey(target);
  const latestTarget = useRef(target);
  latestTarget.current = target;

  const reload = async (signal?: AbortSignal) => {
    try {
      const next = await api.lookupCreatorSubscription(latestTarget.current, signal);
      setLookup(next);
      setFailed(false);
    } catch (error) {
      if (!signal?.aborted) setFailed(true);
      if (!(error instanceof ApiError)) throw error;
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setLookup(null);
    setMenuOpen(false);
    void reload(controller.signal).catch(() => undefined);
    return () => controller.abort();
    // The key names the target; the object may be recreated on each render.
  }, [key]);

  const state = failed ? "unavailable" : subscribeButtonState(lookup);
  const active = state === "active" || state === "pending";
  const label = active ? t("subscriptions.button.subscribed") : t("subscriptions.button.subscribe");
  const title =
    state === "covered"
      ? t("subscriptions.button.covered", {
          name: lookup?.coveredBy ? subscriptionSubjectName(lookup.coveredBy) : "",
        })
      : state === "unavailable" && !failed
        ? t("subscriptions.button.voiceUnavailable")
        : state === "pending"
          ? t("subscriptions.button.pending")
          : label;

  const subscribe = async (pullNow: boolean) => {
    if (!lookup) return;
    setBusy(true);
    try {
      const created = await api.createCreatorSubscription({
        ...target,
        replaceSeries: lookup.series.length > 0,
        pullNow,
      });
      setLookup({ ...lookup, subscription: created.subscription, series: [] });
      setDialogOpen(false);
      toast.success(
        created.pullRun ? t("subscriptions.button.subscribedPulling") : t("subscriptions.button.subscribedToast"),
      );
    } catch (error) {
      toast.notify(toastFromError(error, t("subscriptions.button.subscribeFailed")));
      void reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    if (!lookup || !canSubscribe || busy) return;
    if (active) {
      setMenuOpen((current) => !current);
      return;
    }
    const confirmation = subscribeConfirmation(lookup);
    if (confirmation.replacedSeries.length === 0 && !confirmation.needsBaseline) {
      void subscribe(false);
      return;
    }
    setDialogOpen(true);
  };

  const update = async (subscription: CreatorSubscription, watchAvailability: boolean) => {
    setBusy(true);
    try {
      const updated = await api.updateCreatorSubscription(subscription.id, { watchAvailability });
      setLookup((current) => (current ? { ...current, subscription: updated } : current));
    } catch (error) {
      toast.notify(toastFromError(error, t("subscriptions.button.updateFailed")));
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async (subscription: CreatorSubscription) => {
    setBusy(true);
    try {
      await api.deleteCreatorSubscription(subscription.id);
      setMenuOpen(false);
      setLookup((current) => (current ? { ...current, subscription: null } : current));
      toast.success(t("subscriptions.button.unsubscribedToast"));
    } catch (error) {
      toast.notify(toastFromError(error, t("subscriptions.button.updateFailed")));
    } finally {
      setBusy(false);
    }
  };

  const subscription = lookup?.subscription ?? null;
  const disabled = !canSubscribe || !lookup || state === "covered" || state === "unavailable";
  return (
    <div ref={anchorRef} className="relative">
      <Button
        variant={state === "active" ? "default" : "outline"}
        size="icon"
        className={
          className ?? "lg:h-[var(--control-height-sm)] lg:w-auto lg:px-[var(--control-padding-sm-x)] lg:text-xs"
        }
        aria-label={title}
        aria-pressed={active}
        aria-expanded={active ? menuOpen : undefined}
        title={title}
        disabled={disabled}
        onClick={open}
      >
        {busy || state === "loading" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : active || state === "covered" ? (
          <BellRing className="h-4 w-4" />
        ) : (
          <Bell className="h-4 w-4" />
        )}
        <span className="hidden lg:inline">{label}</span>
      </Button>
      {subscription && (
        <AnchoredPopover
          open={menuOpen}
          anchorRef={anchorRef}
          onOpenChange={setMenuOpen}
          ariaLabel={t("subscriptions.button.menu")}
          className="w-[min(20rem,calc(100vw-1.5rem))] space-y-3 p-3 text-sm"
          zIndex={70}
        >
          <p className="text-muted-foreground">
            {subscription.status === "active"
              ? t("subscriptions.button.activeDescription", { name: subjectName })
              : t("subscriptions.button.pendingDescription")}
          </p>
          <label className="flex items-center justify-between gap-3">
            <span>{t("subscriptions.watchAvailability")}</span>
            <Switch
              checked={subscription.watchAvailability}
              disabled={busy}
              aria-label={t("subscriptions.watchAvailability")}
              onCheckedChange={(checked) => void update(subscription, checked)}
            />
          </label>
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setMenuOpen(false);
                onOpenSubscriptions();
              }}
            >
              {t("subscriptions.button.manage")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void unsubscribe(subscription)}>
              {t("subscriptions.button.unsubscribe")}
            </Button>
          </div>
        </AnchoredPopover>
      )}
      {dialogOpen && lookup && (
        <SubscribeDialog
          lookup={lookup}
          subjectName={subjectName}
          canPullNow={canPullNow}
          busy={busy}
          onClose={() => setDialogOpen(false)}
          onSubscribe={(pullNow) => void subscribe(pullNow)}
        />
      )}
    </div>
  );
}

function SubscribeDialog({
  lookup,
  subjectName,
  canPullNow,
  busy,
  onClose,
  onSubscribe,
}: {
  lookup: CreatorSubscriptionLookup;
  subjectName: string;
  canPullNow: boolean;
  busy: boolean;
  onClose: () => void;
  onSubscribe: (pullNow: boolean) => void;
}) {
  const { t } = useTranslation();
  const { replacedSeries, needsBaseline } = subscribeConfirmation(lookup);
  // The button sits inside headers that form their own stacking context, so the
  // dialog renders at the document root to stay above the page content.
  return createPortal(
    <Dialog onClose={onClose} size="sm" dismissible={!busy}>
      <DialogHeader title={t("subscriptions.dialog.title", { name: subjectName })} />
      <DialogBody className="space-y-3 text-sm">
        {replacedSeries.length > 0 && (
          <div className="space-y-1.5">
            <p>{t("subscriptions.dialog.replacesSeries", { count: replacedSeries.length })}</p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {replacedSeries.map((series) => (
                <li key={series.id}>{subscriptionSubjectName(series)}</li>
              ))}
            </ul>
          </div>
        )}
        {needsBaseline && (
          <p className="text-muted-foreground">
            {canPullNow ? t("subscriptions.dialog.baseline") : t("subscriptions.dialog.baselineScheduled")}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
          {t("content.cancel")}
        </Button>
        {needsBaseline && canPullNow && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onSubscribe(false)}>
            {t("subscriptions.dialog.atNextRefresh")}
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => onSubscribe(needsBaseline && canPullNow)}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {needsBaseline && canPullNow ? t("subscriptions.dialog.pullNow") : t("subscriptions.button.subscribe")}
        </Button>
      </DialogFooter>
    </Dialog>,
    document.body,
  );
}

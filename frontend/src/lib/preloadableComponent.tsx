import { use, type ComponentType } from "react";

type TrackedPromise<T> = Promise<T> & {
  status?: "pending" | "fulfilled" | "rejected";
  value?: T;
  reason?: unknown;
  /** A render has waited on this load, so its failure belongs to that render. */
  rendered?: boolean;
};

/**
 * Like `lazy`, but a component whose chunk has already loaded renders without
 * suspending. React holds a Suspense boundary's fallback for at least 300ms
 * once shown, so suspending on a preloaded chunk would still delay the
 * component and every request its effects start.
 *
 * A failed load is retried by the next preload, and once by a render that
 * finds a failed preload. A load a render has waited on throws its failure to
 * the nearest error boundary instead: React retries a suspended component with
 * a fresh render, so loading again there would suspend on every retry and
 * never show the failure.
 */
export function preloadableComponent<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  let current: TrackedPromise<ComponentType<Props>> | null = null;
  const start = () => {
    const promise: TrackedPromise<ComponentType<Props>> = load();
    promise.status = "pending";
    promise.then(
      (value) => {
        promise.status = "fulfilled";
        promise.value = value;
      },
      (reason: unknown) => {
        promise.status = "rejected";
        promise.reason = reason;
      },
    );
    current = promise;
    return promise;
  };
  const preload = (): Promise<ComponentType<Props>> => (current && current.status !== "rejected" ? current : start());
  const read = (): Promise<ComponentType<Props>> => {
    const promise = current && (current.status !== "rejected" || current.rendered) ? current : start();
    promise.rendered = true;
    return promise;
  };
  function PreloadableComponent(props: Props) {
    const Loaded = use(read());
    return <Loaded {...props} />;
  }
  return { Component: PreloadableComponent, preload };
}

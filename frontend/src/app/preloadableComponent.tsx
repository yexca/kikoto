import { use, type ComponentType } from "react";

type TrackedPromise<T> = Promise<T> & {
  status?: "pending" | "fulfilled" | "rejected";
  value?: T;
  reason?: unknown;
};

/**
 * Like `lazy`, but a component whose chunk has already loaded renders without
 * suspending. React holds a Suspense boundary's fallback for at least 300ms
 * once shown, so suspending on a preloaded chunk would still delay the
 * component and every request its effects start. A failed load is forgotten so
 * a later render or preload retries it.
 */
export function preloadableComponent<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  let current: TrackedPromise<ComponentType<Props>> | null = null;
  const preload = (): Promise<ComponentType<Props>> => {
    if (current) return current;
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
        if (current === promise) current = null;
      },
    );
    current = promise;
    return promise;
  };
  function PreloadableComponent(props: Props) {
    const Loaded = use(preload());
    return <Loaded {...props} />;
  }
  return { Component: PreloadableComponent, preload };
}

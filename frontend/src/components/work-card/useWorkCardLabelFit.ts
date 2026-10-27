import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Whether a card footer action has room to show its label. `anchorRef` is the
 * action's element inside the footer group, which grows into the footer's free
 * space and packs its actions at the end, as WorkCardFooter's right group does.
 * `sampleRef` is an invisible copy of the labeled action. The label fits when
 * the sample is no wider than the action plus the free space before the
 * group's first action; that sum is the same with or without the label, so
 * the answer does not flip once the label shows.
 */
export function useWorkCardLabelFit(
  enabled: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  sampleRef: RefObject<HTMLElement | null>,
) {
  const [fits, setFits] = useState(false);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const sample = sampleRef.current;
    const group = anchor?.parentElement;
    const first = group?.firstElementChild;
    let next = false;
    // A sample without width is not laid out, as in a hidden panel; keep the icon alone.
    if (enabled && anchor && sample && group && first && sample.offsetWidth > 0) {
      const free = first.getBoundingClientRect().left - group.getBoundingClientRect().left;
      next = sample.offsetWidth <= free + anchor.offsetWidth + 0.5;
    }
    setFits((current) => (current === next ? current : next));
  }, [anchorRef, enabled, sampleRef]);

  // Sibling actions change width with their own state, such as a rating, so
  // every render measures again; an unchanged answer does not render again.
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    const group = enabled ? anchorRef.current?.parentElement : null;
    const observer = typeof ResizeObserver === "undefined" || !group ? null : new ResizeObserver(measure);
    if (group) observer?.observe(group);
    return () => observer?.disconnect();
  }, [anchorRef, enabled, measure]);

  return fits;
}

import { describe, expect, it } from "vitest";

import type { SourceTabInfo } from "./sourceContextModel";
import { sourceTabStrip, sourceTabVisibilityEntries } from "./sourceTabVisibility";

const local: SourceTabInfo = {
  key: "3:local",
  label: "Local",
  sourceName: "Main local library",
  fileSourceId: 3,
  kind: "local",
  status: "available",
  statusLabel: "Local files available",
  visibilityKey: "local",
};
const trackedPlaceholder: SourceTabInfo = {
  key: "tracked",
  label: "Tracked",
  fileSourceId: null,
  kind: "tracked",
  status: "degraded",
  statusLabel: "No tracked source linked",
  visibilityKey: "tracked",
  autoVisible: false,
};
const remote: SourceTabInfo = {
  key: "remote-source:7",
  label: "Example Remote",
  fileSourceId: null,
  kind: "remote",
  status: "available",
  statusLabel: "Available",
  visibilityKey: "remote:7",
};
const disabledRemote: SourceTabInfo = {
  ...remote,
  key: "remote-source:8",
  label: "Disabled Remote",
  status: "unavailable",
  statusLabel: "Disabled",
  visibilityKey: "remote:8",
  autoVisible: false,
};

const keys = (tabs: SourceTabInfo[]) => tabs.map((tab) => tab.key);

describe("source tab visibility", () => {
  it("names a lone source in the header unless it is always shown", () => {
    expect(sourceTabStrip([local, trackedPlaceholder], {}, local.key)).toMatchObject({ showStrip: false });
    const strip = sourceTabStrip([local, trackedPlaceholder], { local: "always" }, local.key);
    expect(keys(strip.visibleTabs)).toEqual([local.key]);
    expect(strip.showStrip).toBe(true);
  });

  it("follows always and never choices but keeps the active tab", () => {
    const tabs = [local, trackedPlaceholder, remote, disabledRemote];
    expect(keys(sourceTabStrip(tabs, {}, local.key).visibleTabs)).toEqual([local.key, remote.key]);
    expect(keys(sourceTabStrip(tabs, { tracked: "always", "remote:7": "never" }, local.key).visibleTabs)).toEqual([
      local.key,
      trackedPlaceholder.key,
    ]);
    expect(keys(sourceTabStrip(tabs, { "remote:7": "never" }, remote.key).visibleTabs)).toEqual([
      local.key,
      remote.key,
    ]);
  });

  it("lists one entry per source with disabled remotes marked", () => {
    const entries = sourceTabVisibilityEntries(
      [local, { ...local, key: "4:local", fileSourceId: 4, label: "Pool B" }, trackedPlaceholder, disabledRemote],
      {},
      { local: "Local", tracked: "Tracked" },
    );
    expect(entries).toEqual([
      { key: "local", kind: "local", label: "Local", disabled: false, visible: true },
      { key: "tracked", kind: "tracked", label: "Tracked", disabled: false, visible: false },
      { key: "remote:8", kind: "remote", label: "Disabled Remote", disabled: true, visible: false },
    ]);
  });
});

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The browser suite runs in the Playwright image that PLAYWRIGHT_IMAGE in the
// Makefile pins. Its browsers belong to one Playwright release, so the image
// tag must name the release that frontend/package-lock.json installs.

const image =
  /^PLAYWRIGHT_IMAGE \?= mcr\.microsoft\.com\/playwright:v(\S+)-noble@sha256:[0-9a-f]{64}$/m;

export function checkPlaywrightImage(makefile, lockfile) {
  const pinned = image.exec(makefile)?.[1];
  if (!pinned)
    throw new Error(
      "The Makefile must pin PLAYWRIGHT_IMAGE as mcr.microsoft.com/playwright:v<version>-noble@sha256:<digest>.",
    );
  const packages = JSON.parse(lockfile).packages ?? {};
  for (const name of ["@playwright/test", "playwright-core"]) {
    const installed = packages[`node_modules/${name}`]?.version;
    if (installed !== pinned)
      throw new Error(
        `PLAYWRIGHT_IMAGE is Playwright ${pinned}, but the lockfile installs ${name} ${installed ?? "nowhere"}. ` +
          `Pin mcr.microsoft.com/playwright:v${installed}-noble with the digest that ` +
          `docker buildx imagetools inspect reports for it.`,
      );
  }
  return pinned;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const version = checkPlaywrightImage(
    read("../Makefile"),
    read("../frontend/package-lock.json"),
  );
  console.log(
    `The Playwright image matches the lockfile's Playwright ${version}.`,
  );
}

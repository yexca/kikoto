import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const docker = process.env.DOCKER || "docker";
const image = process.argv[2];
assert.ok(image, "Pass the locally built production image");
const container = `kikoto-production-smoke-${randomUUID()}`;
const temporaryRoot = resolve(tmpdir());
const fixtureRoot = await mkdtemp(
  join(temporaryRoot, "kikoto-production-smoke-"),
);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => controller.abort());
let created = false;
let baseURL;

async function command(args, cleanup = false) {
  const result = await execute(docker, args, {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    signal: cleanup ? undefined : controller.signal,
  });
  return (result.stdout + (cleanup ? result.stderr : "")).trim();
}

async function request(
  path,
  { expected = 200, limit = 128 * 1024, ...options } = {},
) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  const response = await fetch(baseURL + path, {
    ...options,
    redirect: "error",
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    assert.ok(
      [expected].flat().includes(response.status),
      `${path}: HTTP ${response.status}`,
    );
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= limit, `${path}: response exceeds limit`);
      chunks.push(value);
    }
  } finally {
    await reader?.cancel();
  }
  return { response, body: Buffer.concat(chunks) };
}

async function waitFor(check, description) {
  const deadline = Date.now() + 60_000;
  let lastError;
  do {
    controller.signal.throwIfAborted();
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500, undefined, { signal: controller.signal });
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

function silentWav(seconds) {
  const dataSize = 8000 * seconds;
  const wav = Buffer.alloc(44 + dataSize, 128);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

try {
  // Deterministic PCM and generated test signals; no downloaded or private media.
  const wav = silentWav(1);
  await mkdir(join(fixtureRoot, "RJ00000000"));
  await writeFile(join(fixtureRoot, "RJ00000000", "example.wav"), wav);
  await writeFile(join(fixtureRoot, "RJ00000000", "02-next.wav"), silentWav(5));

  created = true;
  await command([
    "create",
    "--pull=never",
    "--name",
    container,
    "--publish",
    "127.0.0.1::7659",
    "--mount",
    "type=volume,destination=/config",
    "--mount",
    "type=volume,destination=/cache",
    "--mount",
    "type=volume,destination=/data",
    "--env",
    "KIKOTO_MODE=production",
    "--env",
    "KIKOTO_SESSION_COOKIE_SECURE=false",
    "--env",
    "KIKOTO_REMOTE_SOURCES_ENABLED=false",
    image,
  ]);
  await command(["cp", `${fixtureRoot}/.`, `${container}:/data`]);
  await command(["start", container]);
  // Use the shipped codecs and publish complete fixtures on the data filesystem.
  const staging = "/data/.kikoto-staging/production-smoke";
  await command(["exec", container, "mkdir", "-p", staging]);
  await command([
    "exec",
    container,
    "ffmpeg",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "40",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-f",
    "adts",
    `${staging}/01-example.aac`,
  ]);
  await command([
    "exec",
    container,
    "ffmpeg",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:sample_rate=48000",
    "-t",
    "14",
    "-c:v",
    "mpeg4",
    "-q:v",
    "8",
    "-threads:v",
    "2",
    "-c:a",
    "pcm_s16le",
    `${staging}/example.avi`,
  ]);
  await command([
    "exec",
    container,
    "mv",
    "--",
    `${staging}/01-example.aac`,
    `${staging}/example.avi`,
    "/data/RJ00000000/",
  ]);
  const port = await command(["port", container, "7659/tcp"]);
  assert.match(port, /^127\.0\.0\.1:\d+$/);
  const origin = new URL("http://127.0.0.1");
  origin.port = port.split(":")[1];
  baseURL = origin.origin;
  await waitFor(() => request("/health"), "production readiness");

  const { body: index } = await request("/");
  assert.match(index.toString(), /<div id="root"/);
  assert.match(index.toString(), /viewport-fit=cover/);
  const { body: manifestBody } = await request("/manifest.webmanifest");
  const manifest = JSON.parse(manifestBody);
  assert.equal(manifest.display, "standalone");
  for (const [size, purpose] of [
    ["192x192", "any"],
    ["512x512", "maskable"],
  ]) {
    const icon = manifest.icons.find(
      (entry) =>
        entry.sizes === size &&
        (entry.purpose || "any").split(" ").includes(purpose),
    );
    assert.ok(icon, `PWA manifest must include ${size} ${purpose} icon`);
    const { response, body } = await request(icon.src, {
      limit: 2 * 1024 * 1024,
    });
    assert.match(response.headers.get("content-type"), /image\/png/);
    assert.ok(body.length > 8, "PWA icon must not be empty");
  }
  const { response: serviceWorker } = await request("/sw.js");
  assert.match(serviceWorker.headers.get("content-type"), /javascript/);
  const bundle = index.toString().match(/src="(\/assets\/[^"\s]+\.js)"/)?.[1];
  assert.ok(
    bundle,
    "Production HTML must reference a compiled JavaScript bundle",
  );
  const { response: bundleResponse } = await request(bundle, {
    limit: 8 * 1024 * 1024,
  });
  assert.match(bundleResponse.headers.get("content-type"), /javascript/);
  const { body: spa } = await request("/about");
  assert.deepEqual(spa, index, "SPA navigation must serve the production app");
  const { body: runtime } = await request("/api/runtime-settings");
  assert.equal(JSON.parse(runtime).mode, "production");
  assert.equal(JSON.parse(runtime).anonymousAccessEnabled, false);
  await request("/api/works", { expected: 401 });
  // A new instance is claimed with the setup token from the config mount.
  const { body: anonymousUser } = await request("/api/auth/me");
  assert.equal(JSON.parse(anonymousUser).setupRequired, true);
  const setupToken = await command([
    "exec",
    container,
    "cat",
    "/config/setup-token",
  ]);
  const setup = (token) =>
    JSON.stringify({
      setupToken: token,
      username: "synthetic-user",
      password: "synthetic-password",
    });
  const jsonHeaders = { "Content-Type": "application/json" };
  await request("/api/auth/setup", {
    method: "POST",
    headers: jsonHeaders,
    body: setup("synthetic-wrong-token"),
    expected: 403,
  });
  await request("/api/auth/setup", {
    method: "POST",
    headers: jsonHeaders,
    body: setup(setupToken),
    expected: 201,
  });
  await request("/api/auth/setup", {
    method: "POST",
    headers: jsonHeaders,
    body: setup(setupToken),
    expected: 409,
  });
  // The host-side reset command runs beside the live server.
  const reset = await command([
    "exec",
    container,
    "/app/kikoto",
    "admin",
    "reset-password",
  ]);
  assert.match(reset, /^Username: synthetic-user$/m);
  const password = reset.match(/^Password: (\S+)$/m)?.[1];
  assert.ok(password, "The reset command must print a new password");
  const { response: login } = await request("/api/auth/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ username: "synthetic-user", password }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie, "Login must establish a session");
  const headers = { Cookie: cookie, "Content-Type": "application/json" };
  const { body: currentUser } = await request("/api/auth/me", { headers });
  assert.equal(JSON.parse(currentUser).authenticated, true);
  await request("/api/workflow-runs/local-scan", {
    method: "POST",
    headers,
    body: JSON.stringify({ followUpRun: false }),
    expected: 202,
  });
  const work = await waitFor(async () => {
    const { body } = await request("/api/works", { headers });
    return JSON.parse(body).works.find(
      (entry) => entry.primaryCode === "RJ00000000",
    );
  }, "the synthetic local work");
  const findLocalFile = (items, name) => {
    for (const item of items) {
      const location = item.locations.find(
        (entry) =>
          entry.locationType === "local" && basename(entry.path) === name,
      );
      if (location) return { item, location };
    }
    return null;
  };
  const mediaItems = await waitFor(async () => {
    const { body } = await request(`/api/works/${work.id}/media`, { headers });
    const items = JSON.parse(body).mediaItems;
    return (
      ["example.wav", "01-example.aac", "02-next.wav", "example.avi"].every(
        (name) => findLocalFile(items, name),
      ) && items
    );
  }, "all synthetic media fixtures to be indexed");
  const localLocation = (name, kind) => {
    const file = findLocalFile(mediaItems, name);
    assert.ok(file, `${name} must expose a local playback location`);
    assert.equal(file.item.kind, kind, `${name} must be recognized as ${kind}`);
    return file.location;
  };
  const location = localLocation("example.wav", "audio");
  const aac = localLocation("01-example.aac", "audio");
  const next = localLocation("02-next.wav", "audio");
  const video = localLocation("example.avi", "video");
  assert.ok(location, "Local scan must expose a playable audio location");
  const stream = `/api/media/${location.id}/stream?forceDirect=1`;
  await request(stream, { expected: 401 });
  const { response: audio, body: range } = await request(stream, {
    headers: { ...headers, Range: "bytes=0-43" },
    expected: 206,
  });
  assert.equal(audio.headers.get("content-range"), `bytes 0-43/${wav.length}`);
  assert.deepEqual(range, wav.subarray(0, 44));
  await request("/api/auth/logout", {
    method: "POST",
    headers,
    body: "{}",
    expected: [200, 204],
  });
  await request("/api/works", { headers, expected: 401 });
  if (process.argv.includes("--browser")) {
    const { verifyProductionBrowser } =
      await import("./production-browser-smoke.mjs");
    await verifyProductionBrowser(
      baseURL,
      {
        workCode: work.primaryCode,
        aacLocationId: aac.id,
        nextLocationId: next.id,
        videoLocationId: video.id,
        password,
      },
      controller.signal,
    );
  }
  console.log(
    "Production smoke passed: static assets, SPA routing, authentication, local scan and audio Range playback.",
  );
} catch (error) {
  if (created) {
    try {
      console.error(await command(["logs", "--tail", "100", container], true));
    } catch {
      // Keep the validation failure if Docker diagnostics also fail.
    }
  }
  throw error;
} finally {
  try {
    if (created) {
      try {
        await command(["rm", "--force", "--volumes", container], true);
      } catch (error) {
        if (!error.stderr?.includes("No such container")) throw error;
      }
    }
  } finally {
    assert.equal(dirname(fixtureRoot), temporaryRoot);
    assert.ok(basename(fixtureRoot).startsWith("kikoto-production-smoke-"));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

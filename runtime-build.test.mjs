import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLD_BUILD_SECONDS, COMMIT, LIMITS, SWITCH_TIMEOUT_MS, VERSION,
  assertSafe, cacheMatches, readBuild, readRustChannel, reuseWarmNative,
  runCommand, runtimeManager, rustChannel,
} from './runtime-build.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const patchPath = fileURLToPath(new URL('./patches/omp-native-doubao.patch', import.meta.url));
const LOG_NAME = 'build-123e4567-e89b-12d3-a456-426614174000.log';
const TOOLCHAIN = `[toolchain]
channel = "nightly-2026-10-06" # upstream pin
components = ["rustfmt", "clippy", "rust-analyzer"]
targets = ["x86_64-unknown-linux-gnu"]

[profile]
channel = "stable"
`;

async function makeHome() {
  const created = await mkdtemp(join(tmpdir(), 'carly-switch-'));
  const home = await realpath(created);
  if (home === homedir() || home.startsWith(`${homedir()}/`)) {
    await rm(created, { recursive: true, force: true });
    throw new Error('Refusing to use a temporary home inside the real home');
  }
  const root = join(home, '.local', 'share', 'carly-switch');
  const data = join(home, 'Library', 'Application Support', 'Tern', 'plugin-data', 'carly-switch');
  await mkdir(root, { recursive: true });
  await mkdir(data, { recursive: true });
  let current = home;
  for (const segment of root.slice(home.length + 1).split('/')) {
    current = join(current, segment);
    await chmod(current, 0o700);
  }
  await chmod(data, 0o700);
  const fail = message => { throw new Error(message); };
  return {
    home, root, data, runtime: join(root, 'omp'), patch: patchPath, fail,
    manager(limits) {
      return runtimeManager({ home, data, runtime: join(root, 'omp'), patch: patchPath, fail, ...(limits ? { limits } : {}) });
    },
    async cleanup() { await rm(home, { recursive: true, force: true }); },
  };
}

async function writeMode(path, contents, mode) {
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
}

async function writeFakeOmp(path, version = VERSION) {
  await writeMode(path, `#!/bin/sh
set -eu
store="\${TMPDIR:-/tmp}/carly-switch-smoke"
mkdir -p "$store"
if [ "\${1:-}" = "--version" ]; then
  printf 'omp/${version}\\n'
  exit 0
fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "set" ]; then
  printf '%s' "$4" > "$store/$(printf '%s' "$3" | tr '/' '_')"
  exit 0
fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "get" ]; then
  printf '{"value":"%s"}\\n' "$(cat "$store/$(printf '%s' "$3" | tr '/' '_')")"
  exit 0
fi
exit 1
`, 0o700);
}

function recordFor(directory, candidateBytes, { beforeBinary = null, beforeManifest = null, manifest = {} } = {}) {
  const body = {
    version: VERSION, commit: COMMIT, patchSHA256: 'e'.repeat(64),
    platform: process.platform, arch: process.arch, binarySHA256: sha(candidateBytes), ...manifest,
  };
  return {
    version: 1, directory, beforeBinary, beforeManifest, afterBinary: sha(candidateBytes),
    afterManifest: sha(`${JSON.stringify(body)}\n`), manifest: body,
  };
}

async function writeJournal(root, record, mode = 0o600) {
  await writeMode(join(root, 'runtime-transaction.json'), `${JSON.stringify(record)}\n`, mode);
}

async function stageCandidate(root, directory, bytes) {
  const path = join(root, directory);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  await writeMode(join(path, 'candidate'), bytes, 0o600);
  return path;
}

test('stage caps outlast a cold build and stay at least as generous as the review', () => {
  expect(LIMITS).toEqual({
    version: 30, probe: 60, smoke: 30, clone: 15 * 60, dependencies: 15 * 60,
    toolchain: 30 * 60, native: 60 * 60, compile: 30 * 60, addon: 30,
  });
  expect(COLD_BUILD_SECONDS).toBe(
    LIMITS.version + LIMITS.addon + (LIMITS.probe * 5) + LIMITS.clone + LIMITS.dependencies
    + LIMITS.toolchain + LIMITS.native + LIMITS.compile + (LIMITS.smoke * 9),
  );
  expect(SWITCH_TIMEOUT_MS).toBe(4 * 60 * 60 * 1000);
  expect(SWITCH_TIMEOUT_MS).toBeGreaterThan((COLD_BUILD_SECONDS + 15 * 60) * 1000);
});

test('the panel switch cap is only the helper-reported SWITCH_TIMEOUT_MS', async () => {
  const host = await Bun.file(new URL('./host.luau', import.meta.url)).text();
  const helper = await Bun.file(new URL('./helper.mjs', import.meta.url)).text();
  expect(host).not.toMatch(/SWITCH_TIMEOUT_MS\s*=/);
  expect(host).not.toContain(`${SWITCH_TIMEOUT_MS}`);
  expect(host).toContain('state.status.switchTimeoutMs');
  expect(helper).toContain('switchTimeoutMs: SWITCH_TIMEOUT_MS');
});

test('readBuild accepts a private progress record and rejects unsafe or malformed ones', async () => {
  const fixture = await makeHome();
  try {
    expect(await readBuild(fixture.data)).toBeNull();
    const startedAt = Date.now() - 5000;
    await writeMode(join(fixture.data, 'build.json'), `${JSON.stringify({
      state: 'running', stage: 'source', startedAt, logName: LOG_NAME,
    })}\n`, 0o600);
    const running = await readBuild(fixture.data);
    expect(running).toMatchObject({ state: 'running', stage: 'source', message: `Fetching pinned OMP v${VERSION} source.` });
    expect(running.elapsedSeconds).toBeGreaterThanOrEqual(4);
    expect(running.logPath).toBe(join(fixture.data, LOG_NAME));
    await writeMode(join(fixture.data, 'build.json'), `${JSON.stringify({
      state: 'failed', stage: 'compile', startedAt, finishedAt: startedAt + 1000, logName: LOG_NAME,
    })}\n`, 0o600);
    expect(await readBuild(fixture.data)).toMatchObject({
      state: 'failed', stage: 'compile', elapsedSeconds: 1,
      message: 'Runtime preparation failed during compile. See the private build log.',
    });
    await chmod(join(fixture.data, 'build.json'), 0o640);
    expect(await readBuild(fixture.data)).toBeNull();
    await chmod(join(fixture.data, 'build.json'), 0o600);
    await writeMode(join(fixture.data, 'real.json'), '{}', 0o600);
    await rm(join(fixture.data, 'build.json'));
    await symlink('real.json', join(fixture.data, 'build.json'));
    expect(await readBuild(fixture.data)).toBeNull();
    await rm(join(fixture.data, 'build.json'));
    for (const bad of [
      { state: 'running', stage: 'nope', startedAt, logName: LOG_NAME },
      { state: 'paused', stage: 'source', startedAt, logName: LOG_NAME },
      { state: 'running', stage: 'source', startedAt, logName: 'build-short.log' },
      { state: 'running', stage: 'source', startedAt: 'now', logName: LOG_NAME },
    ]) {
      await writeMode(join(fixture.data, 'build.json'), `${JSON.stringify(bad)}\n`, 0o600);
      expect(await readBuild(fixture.data)).toBeNull();
    }
  } finally { await fixture.cleanup(); }
});

test('assertSafe hashes a private file and rejects anything else', async () => {
  const fixture = await makeHome();
  try {
    const file = join(fixture.home, 'manifest.json');
    expect(await assertSafe(join(fixture.home, 'missing'))).toBeNull();
    await writeMode(file, 'manifest', 0o600);
    expect(await assertSafe(file)).toBe(sha('manifest'));
    await expect(assertSafe(fixture.home)).rejects.toThrow(/private regular file/);
    await symlink(file, join(fixture.home, 'linked'));
    await expect(assertSafe(join(fixture.home, 'linked'))).rejects.toThrow(/private regular file/);
  } finally { await fixture.cleanup(); }
});

test('rust channel comes from the toolchain table only', async () => {
  expect(rustChannel(TOOLCHAIN)).toBe('nightly-2026-10-06');
  expect(rustChannel('channel = "stable"\n[toolchain]\nchannel = nightly-2026-10-06\n')).toBe('nightly-2026-10-06');
  expect(() => rustChannel('[toolchain]\ncomponents = ["rustfmt"]\n')).toThrow(/usable channel/);
  expect(() => rustChannel('[toolchain]\nchannel = "nightly;touch /tmp/x"\n')).toThrow(/usable channel/);
  const fixture = await makeHome();
  try {
    const source = join(fixture.home, 'source');
    await mkdir(source, { mode: 0o700 });
    await expect(readRustChannel(source)).rejects.toThrow(/missing rust-toolchain.toml/);
    await writeMode(join(source, 'real.toml'), TOOLCHAIN, 0o600);
    await symlink('real.toml', join(source, 'rust-toolchain.toml'));
    await expect(readRustChannel(source)).rejects.toThrow(/missing rust-toolchain.toml/);
    await rm(join(source, 'rust-toolchain.toml'));
    await writeMode(join(source, 'rust-toolchain.toml'), TOOLCHAIN, 0o600);
    expect(await readRustChannel(source)).toBe('nightly-2026-10-06');
  } finally { await fixture.cleanup(); }
});

test('cache match requires the pinned identity and binary hash, not native provenance', () => {
  const base = { version: VERSION, commit: COMMIT, patchSHA256: 'a'.repeat(64), platform: 'darwin', arch: 'arm64' };
  const binary = 'b'.repeat(64);
  const cached = { ...base, binarySHA256: binary, nativeSHA256: 'c'.repeat(64) };
  expect(cacheMatches(cached, base, binary)).toBe(true);
  expect(cacheMatches({ ...base, binarySHA256: binary }, base, binary)).toBe(true);
  for (const key of Object.keys(base)) expect(cacheMatches({ ...cached, [key]: 'other' }, base, binary)).toBe(false);
  expect(cacheMatches({ ...cached, binarySHA256: 'd'.repeat(64) }, base, binary)).toBe(false);
  expect(cacheMatches(null, base, binary)).toBe(false);
  expect(cacheMatches([], base, binary)).toBe(false);
});

test('pending rejects invalid journals before it will roll anything back', async () => {
  const fixture = await makeHome();
  try {
    const builder = fixture.manager();
    expect(await builder.pending()).toBeNull();
    const candidate = Buffer.from('candidate-bytes');
    const valid = recordFor('.build-abc', candidate);
    await stageCandidate(fixture.root, '.build-abc', candidate);
    for (const record of [
      { ...valid, version: 2 },
      { ...valid, directory: '../outside' },
      { ...valid, directory: '.build-abc/nested' },
      { ...valid, afterBinary: null },
      { ...valid, afterManifest: 'f'.repeat(64) },
      { ...valid, beforeBinary: 'not-a-hash' },
    ]) {
      await writeJournal(fixture.root, record);
      await expect(builder.pending()).rejects.toThrow(/Invalid runtime recovery record/);
      expect(await lstat(join(fixture.root, '.build-abc', 'candidate'))).toBeTruthy();
    }
    await writeJournal(fixture.root, valid, 0o644);
    await expect(builder.pending()).rejects.toThrow(/Unsafe runtime recovery record/);
    await writeJournal(fixture.root, valid);
    await rm(join(fixture.root, 'runtime-transaction.json'));
    await symlink('missing-journal', join(fixture.root, 'runtime-transaction.json'));
    await expect(builder.pending()).rejects.toThrow(/Unsafe runtime recovery record/);
    await rm(join(fixture.root, 'runtime-transaction.json'));
    await writeJournal(fixture.root, valid);
    await chmod(join(fixture.root, '.build-abc'), 0o755);
    await expect(builder.pending()).rejects.toThrow(/candidate is missing or changed/);
    await chmod(join(fixture.root, '.build-abc'), 0o700);
    await writeMode(join(fixture.root, '.build-abc', 'candidate'), 'tampered', 0o600);
    await expect(builder.pending()).rejects.toThrow(/candidate is missing or changed/);
  } finally { await fixture.cleanup(); }
});

test('rollback restores, deletes, or keeps the previous runtime and retains bad evidence', async () => {
  const fixture = await makeHome();
  try {
    const oldBytes = Buffer.from('previous-runtime');
    const newBytes = Buffer.from('installed-runtime');
    const directory = await stageCandidate(fixture.root, '.build-restore', newBytes);
    await writeMode(join(directory, 'previous-omp'), oldBytes, 0o600);
    const record = recordFor('.build-restore', newBytes, { beforeBinary: sha(oldBytes) });
    await writeMode(fixture.runtime, newBytes, 0o700);
    await writeJournal(fixture.root, record);
    const restored = await fixture.manager().pending();
    await restored.rollback();
    expect(sha(await readFile(fixture.runtime))).toBe(sha(oldBytes));
    await expect(lstat(join(fixture.root, 'runtime-transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });

    const deleteDir = await stageCandidate(fixture.root, '.build-delete', newBytes);
    const deleteRecord = recordFor('.build-delete', newBytes);
    await writeMode(fixture.runtime, newBytes, 0o700);
    await writeJournal(fixture.root, deleteRecord);
    await (await fixture.manager().pending()).rollback();
    await expect(lstat(fixture.runtime)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(deleteDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const sameDir = await stageCandidate(fixture.root, '.build-same', newBytes);
    await writeMode(join(sameDir, 'previous-omp'), oldBytes, 0o600);
    const same = recordFor('.build-same', newBytes, { beforeBinary: sha(oldBytes) });
    await writeMode(fixture.runtime, oldBytes, 0o700);
    await writeJournal(fixture.root, same);
    await (await fixture.manager().pending()).rollback();
    expect(sha(await readFile(fixture.runtime))).toBe(sha(oldBytes));

    const badDir = await stageCandidate(fixture.root, '.build-badbackup', newBytes);
    await writeMode(join(badDir, 'previous-omp'), Buffer.from('not-the-backup'), 0o600);
    const bad = recordFor('.build-badbackup', newBytes, { beforeBinary: sha(oldBytes) });
    await writeMode(fixture.runtime, newBytes, 0o700);
    await writeJournal(fixture.root, bad);
    await expect(fixture.manager().pending().then(found => found.rollback())).rejects.toThrow(/backup changed/);
    expect(sha(await readFile(fixture.runtime))).toBe(sha(newBytes));
    expect(await lstat(join(fixture.root, 'runtime-transaction.json'))).toBeTruthy();
    expect(await lstat(badDir)).toBeTruthy();

    const outsideDir = await stageCandidate(fixture.root, '.build-outside', newBytes);
    await writeMode(join(outsideDir, 'previous-omp'), oldBytes, 0o600);
    const outside = recordFor('.build-outside', newBytes, { beforeBinary: sha(oldBytes) });
    await writeMode(fixture.runtime, Buffer.from('third-party'), 0o700);
    await writeJournal(fixture.root, outside);
    await expect(fixture.manager().pending().then(found => found.rollback())).rejects.toThrow(/changed outside this transaction/);
    expect(await readFile(join(fixture.root, 'runtime-transaction.json'), 'utf8')).toContain('.build-outside');
  } finally { await fixture.cleanup(); }
});

test('reused native addons are hashed only after stamp and load checks', async () => {
  const fixture = await makeHome();
  try {
    const warm = join(fixture.home, 'warm.node');
    const native = join(fixture.home, 'copied.node');
    const stamp = Buffer.from(`prefix PI_NATIVES_VERSION_STAMP:${VERSION}\0 suffix`);
    await writeMode(warm, stamp, 0o600);
    const calls = [];
    const lines = [];
    const sha256 = await reuseWarmNative({
      warm, native,
      command: async args => { calls.push(args); return ''; },
      append: async line => { lines.push(line); },
    });
    expect(sha256).toBe(sha(stamp));
    expect(sha(await readFile(native))).toBe(sha256);
    expect(calls[0][2]).toContain(JSON.stringify(VERSION));
    expect(lines[0]).toBe(`Considering native addon SHA-256 ${sha256}.`);
    expect(lines[1]).toBe(`Reused native addon SHA-256 ${sha256}.`);
    await rm(native);
    const rejected = [];
    await expect(reuseWarmNative({
      warm, native, command: async () => null, append: async line => { rejected.push(line); },
    })).resolves.toBeNull();
    expect(rejected).toEqual([`Considering native addon SHA-256 ${sha(stamp)}.`]);
    await expect(lstat(native)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeMode(warm, Buffer.from('no-stamp'), 0o600);
    await expect(reuseWarmNative({
      warm, native, command: async () => '', append: async () => {},
    })).resolves.toBeNull();
    await expect(lstat(native)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeMode(join(fixture.home, 'real.node'), stamp, 0o600);
    await symlink('real.node', join(fixture.home, 'linked.node'));
    await expect(reuseWarmNative({
      warm: join(fixture.home, 'linked.node'), native, command: async () => '', append: async () => {},
    })).resolves.toBeNull();
  } finally { await fixture.cleanup(); }
});

test('a bounded command is killed when it exceeds its limit', async () => {
  const started = Date.now();
  const result = await runCommand(['/bin/sleep', '20'], { cwd: '/', env: { PATH: '/usr/bin:/bin' }, seconds: 1 });
  expect(result.timedOut).toBe(true);
  expect(result.code).not.toBe(0);
  expect(Date.now() - started).toBeLessThan(8000);
  const ok = await runCommand(['/bin/echo', 'omp-ok'], { cwd: '/', env: { PATH: '/bin:/usr/bin' }, seconds: 5, capture: true });
  expect(ok).toEqual({ code: 0, output: 'omp-ok', timedOut: false });
  await expect(runCommand(['/bin/echo', 'x'], { seconds: 0 })).rejects.toThrow(/no time limit/);
  await expect(runCommand(['/no/such/carly-switch-command'], { seconds: 5, env: { PATH: '/usr/bin:/bin' } })).rejects.toThrow(/Cannot start build command/);
}, 15000);

async function withGit(home, script, fn) {
  const bin = join(home, 'stub-bin');
  await mkdir(bin, { mode: 0o700 });
  await writeMode(join(bin, 'git'), script, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try { return await fn(); }
  finally { process.env.PATH = previous; }
}

test.serial('prepare reuses a matching runtime and does not fetch source', async () => {
  const fixture = await makeHome();
  try {
    await writeFakeOmp(fixture.runtime);
    const base = {
      version: VERSION, commit: COMMIT, patchSHA256: sha(await readFile(patchPath)),
      platform: process.platform, arch: process.arch,
    };
    await writeMode(join(fixture.root, 'manifest.json'), `${JSON.stringify({
      ...base, binarySHA256: sha(await readFile(fixture.runtime)), nativeSHA256: 'c'.repeat(64),
    })}\n`, 0o600);
    const log = join(fixture.home, 'git.log');
    await withGit(fixture.home, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 9\n`, async () => {
      const builder = fixture.manager();
      await builder.validateOfficial(fixture.runtime);
      const prepared = await builder.prepare();
      expect(prepared.reused).toBe(true);
      expect(prepared.path).toBe(fixture.runtime);
      await builder.close();
    });
    await expect(lstat(log)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fixture.cleanup(); }
}, 20000);

test.serial.skipIf(process.platform !== 'darwin')('a cache miss fails before clone when git cannot start the fetch', async () => {
  const fixture = await makeHome();
  try {
    await writeFakeOmp(fixture.runtime);
    const before = sha(await readFile(fixture.runtime));
    const log = join(fixture.home, 'git.log');
    await withGit(fixture.home, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 9\n`, async () => {
      const builder = fixture.manager();
      await builder.validateOfficial(fixture.runtime);
      await expect(builder.prepare()).rejects.toThrow(/failed during prerequisites/);
      await builder.close();
    });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['--version']);
    expect(sha(await readFile(fixture.runtime))).toBe(before);
  } finally { await fixture.cleanup(); }
}, 20000);

test.serial.skipIf(process.platform !== 'darwin')('a stalled prerequisite times out into the failed build record', async () => {
  const fixture = await makeHome();
  try {
    await writeFakeOmp(fixture.runtime);
    const started = Date.now();
    await withGit(fixture.home, '#!/bin/sh\nexec /bin/sleep 20\n', async () => {
      const builder = fixture.manager({ ...LIMITS, probe: 1 });
      await builder.validateOfficial(fixture.runtime);
      await expect(builder.prepare()).rejects.toThrow(/prerequisites stage exceeded its time limit/);
      await builder.close();
    });
    expect(Date.now() - started).toBeLessThan(12000);
    const progress = await readBuild(fixture.data);
    expect(progress).toMatchObject({ state: 'failed', stage: 'prerequisites' });
    const log = await readFile(progress.logPath, 'utf8');
    expect(log).toContain('Command git completed in prerequisites: exit 1 (timeout).');
    expect(log).not.toContain('/bin/sleep');
  } finally { await fixture.cleanup(); }
}, 20000);

test.serial('the official version gate uses the single VERSION source', async () => {
  const fixture = await makeHome();
  try {
    await writeFakeOmp(fixture.runtime, '9.9.9');
    const builder = fixture.manager();
    await expect(builder.validateOfficial(fixture.runtime)).rejects.toThrow(new RegExp(`Only official OMP ${VERSION}`));
    await builder.close();
    expect(await readBuild(fixture.data)).toMatchObject({ state: 'failed', stage: 'version' });
  } finally { await fixture.cleanup(); }
}, 20000);

test('a symlink manifest is not treated as a cache', async () => {
  const fixture = await makeHome();
  try {
    await writeFakeOmp(fixture.runtime);
    await writeMode(join(fixture.root, 'real.json'), '{}\n', 0o600);
    await symlink('real.json', join(fixture.root, 'manifest.json'));
    const builder = fixture.manager();
    await builder.validateOfficial(fixture.runtime);
    await expect(builder.prepare()).rejects.toThrow(/private regular file/);
    await builder.close();
  } finally { await fixture.cleanup(); }
}, 20000);

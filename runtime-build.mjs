import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'node:path';

// Single source for the pinned OMP release. User-facing copy derives from this.
export const VERSION = '18.10.3';
export const COMMIT = '81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b';
const REPOSITORY = 'https://github.com/can1357/oh-my-pi.git';

// Worst-case commands, in order: version; warm-addon load; git --version;
// clone; rev-parse; apply --check; apply; bun install; xcrun; rustup;
// build:native; bun run build; smoke --version plus four config set/get pairs.
// A hanging warm addon is tried before the cold compile, so its cap is part of
// the sum. The panel backstop must outlast that sum so a slow compile is not
// killed during activation.
export const LIMITS = Object.freeze({
  version: 30,
  probe: 60,
  smoke: 30,
  clone: 15 * 60,
  // A clean macOS install was still running when 15 minutes killed it, before
  // rustup or the native compile started. 60 minutes still fails a hung
  // install and stays inside the 4-hour panel backstop.
  dependencies: 60 * 60,
  toolchain: 30 * 60,
  native: 60 * 60,
  compile: 30 * 60,
  addon: 30,
});
export const COLD_BUILD_SECONDS = LIMITS.version
  + LIMITS.addon
  + (LIMITS.probe * 5)
  + LIMITS.clone
  + LIMITS.dependencies
  + LIMITS.toolchain
  + LIMITS.native
  + LIMITS.compile
  + (LIMITS.smoke * 9);
export const SWITCH_TIMEOUT_MS = 4 * 60 * 60 * 1000;
if (SWITCH_TIMEOUT_MS <= (COLD_BUILD_SECONDS + 15 * 60) * 1000) {
  throw new Error('Switch timeout does not cover a cold build');
}

const MESSAGES = {
  version: 'Checking the official OMP version.',
  prerequisites: 'Checking local build prerequisites.',
  source: `Fetching pinned OMP v${VERSION} source.`,
  patch: 'Applying the shipped Doubao patch.',
  dependencies: 'Installing locked build dependencies.',
  native: 'Preparing the version-matched native addon.',
  compile: 'Compiling the compatible OMP runtime.',
  smoke: 'Checking the candidate in an isolated home.',
  cache: 'Reusing the verified compatible runtime.',
  install: 'Installing the compatible runtime atomically.',
  activate: 'Applying the voice settings and entry transaction.',
  complete: 'The compatible runtime is ready.',
  manual: 'The supplied runtime settings and official OMP version were validated; no runtime was built.',
  rollback: 'Rolling back the runtime installation.',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = error => error?.code === 'ENOENT';
const validHash = value => value === null || /^[a-f0-9]{64}$/u.test(value);
class BuildError extends Error {}

async function info(path) {
  try { return await lstat(path); } catch (error) { if (absent(error)) return null; throw error; }
}
async function fingerprint(path) {
  const value = await info(path);
  if (!value) return null;
  if (!value.isFile() || value.uid !== process.getuid()) throw new Error('Unsafe runtime file');
  return digest(await readFile(path));
}

// Explicit safety check: absence is allowed, anything that is not a
// user-owned regular file throws. Callers that only need the throw can
// ignore the returned hash.
export async function assertSafe(path) {
  try {
    return await fingerprint(path);
  } catch (error) {
    if (error?.message === 'Unsafe runtime file') {
      throw new BuildError('The runtime manifest is not a private regular file owned by the current user.');
    }
    throw error;
  }
}

export function cacheMatches(cached, base, binarySHA256) {
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return false;
  return Object.entries(base).every(([key, value]) => cached[key] === value) && cached.binarySHA256 === binarySHA256;
}

export function rustChannel(text) {
  let inToolchain = false;
  let channel;
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/u);
    if (header) {
      inToolchain = header[1] === 'toolchain';
      continue;
    }
    if (!inToolchain) continue;
    const match = line.match(/^channel\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9._+-]+))\s*(?:#.*)?$/u);
    if (match) channel = match[1] ?? match[2] ?? match[3];
  }
  if (!channel || !/^[A-Za-z0-9._+-]{1,80}$/u.test(channel)) {
    throw new BuildError('The pinned source rust-toolchain.toml does not name a usable channel.');
  }
  return channel;
}

export async function readRustChannel(source) {
  const path = join(source, 'rust-toolchain.toml');
  const value = await info(path);
  if (!value?.isFile()) throw new BuildError('The pinned source is missing rust-toolchain.toml.');
  return rustChannel(await readFile(path, 'utf8'));
}

function killGroup(child) {
  const pid = child.pid;
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch {} }
}

// `seconds` is required. A missing limit is a programming error, not an
// unbounded build. The child is a process-group leader so a timeout also
// stops compilers it spawned.
export async function runCommand(args, { cwd = '/', env = process.env, seconds, capture = false } = {}) {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('Build command has no time limit');
  let child;
  try {
    child = spawn(args[0], args.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('Cannot start build command');
  }
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, seconds * 1000);
  async function drain(stream, keep) {
    if (!stream) return '';
    const chunks = [];
    let size = 0;
    try {
      for await (const bytes of stream) {
        if (keep && size < 64 * 1024) {
          const part = bytes.subarray(0, 64 * 1024 - size);
          chunks.push(part);
          size += part.length;
        }
      }
    } catch { /* The timeout path closes the pipes. */ }
    return keep ? Buffer.concat(chunks).toString('utf8').trim() : '';
  }
  try {
    const exited = new Promise((resolve, reject) => {
      child.once('error', () => {
        if (settled) return;
        settled = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(new Error('Cannot start build command'));
      });
      child.once('exit', status => {
        settled = true;
        resolve(status ?? 1);
      });
    });
    const [code, output] = await Promise.all([exited, drain(child.stdout, capture), drain(child.stderr, false)]);
    return { code, output, timedOut };
  } finally { clearTimeout(timer); }
}

// Reuse a same-user native addon only after its stamp and load check.
// There is no separate signature; the SHA-256 is the provenance we record.
// Returns null when the addon cannot be reused.
export async function reuseWarmNative({ warm, native, command, append = async () => {}, seconds = LIMITS.addon }) {
  const warmInfo = await info(warm);
  if (!warmInfo?.isFile() || warmInfo.uid !== process.getuid()) return null;
  const bytes = await readFile(warm);
  if (!bytes.includes(Buffer.from(`PI_NATIVES_VERSION_STAMP:${VERSION}\0`))) return null;
  await copyFile(warm, native, constants.COPYFILE_EXCL);
  if (digest(await readFile(native)) !== digest(bytes)) throw new Error('Native addon changed while copying');
  const sha256 = digest(bytes);
  await append(`Considering native addon SHA-256 ${sha256}.`);
  const script = `const m={exports:{}};process.dlopen(m,process.argv[1]);if(m.exports.__piNativesBuildVersion()!==${JSON.stringify(VERSION)})process.exit(1);`;
  const loaded = await command([process.execPath, '-e', script, native], '/', { seconds, allowFailure: true });
  if (loaded === null) {
    await unlink(native);
    return null;
  }
  await append(`Reused native addon SHA-256 ${sha256}.`);
  return sha256;
}

async function privateDirectory(path, home, create = true) {
  let current = home;
  const base = await lstat(home);
  if (!base.isDirectory() || base.uid !== process.getuid()) throw new Error('Unsafe home directory');
  for (const segment of path.slice(home.length + 1).split('/')) {
    current = join(current, segment);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const value = await lstat(current);
    if (!value.isDirectory() || value.uid !== process.getuid()) throw new Error('Unsafe runtime directory');
  }
}
async function atomicJSON(path, value) {
  const temp = `${path}.${randomUUID()}`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
    await file.close(); file = undefined;
    await rename(temp, path);
  } finally { await file?.close(); await unlink(temp).catch(error => { if (!absent(error)) throw error; }); }
}

// Child processes never inherit provider credentials, proxy credentials, config,
// npm tokens, Git credential helpers, or the user's HOME/configuration.
function isolatedEnvironment(home, temporary) {
  return {
    PATH: `${dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`, HOME: home,
    TMPDIR: temporary, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'), OMP_CODING_AGENT_DIR: join(home, '.omp', 'agent'),
    PI_PROFILE: 'default', OMP_PROFILE: 'default', PI_CONFIG_FILES: ':', OMP_CONFIG_FILES: ':',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1', CI: '1', LANG: 'en_US.UTF-8',
  };
}

/**
 * Private build progress from `build.json`, or null when the record is missing
 * or fails the ownership, mode, stage, state, or log-name checks.
 */
export async function readBuild(data) {
  try {
    const path = join(data, 'build.json');
    const value = await lstat(path);
    if (!value.isFile() || value.uid !== process.getuid() || (value.mode & 0o077)) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!Object.hasOwn(MESSAGES, parsed.stage) || !['running', 'ready', 'failed', 'complete'].includes(parsed.state) ||
        !Number.isFinite(parsed.startedAt) || !/^build-[a-f0-9-]{36}\.log$/u.test(parsed.logName)) return null;
    const end = Number.isFinite(parsed.finishedAt) ? parsed.finishedAt : Date.now();
    return { state: parsed.state, stage: parsed.stage, elapsedSeconds: Math.max(0, Math.floor((end - parsed.startedAt) / 1000)),
      logPath: join(data, parsed.logName), message: parsed.state === 'failed' ? `Runtime preparation failed during ${parsed.stage}. See the private build log.` : MESSAGES[parsed.stage] };
  } catch { return null; }
}

/**
 * One switch/restore build lifecycle.
 * Call `validateOfficial` before `prepare`: it checks the pinned version and
 * opens the private log and staging directory. `pending` reloads an
 * interrupted install journal. `prepare` reuses a cache hit or builds a
 * candidate and writes the journal; it does not change the live entry.
 * `install` publishes that candidate, `rollback` restores the previous
 * runtime, and `finalize` retires the journal only after the helper commits
 * settings. `failed` and `close` record the outcome and drop staging that is
 * not retained for recovery. Command timeouts apply inside `prepare`, before
 * that journal is installed; `install` and `rollback` are not timer-killed.
 */
export function runtimeManager({ home, data, runtime, patch, fail, limits = LIMITS }) {
  const root = dirname(runtime);
  const manifestPath = join(root, 'manifest.json');
  const journalPath = join(root, 'runtime-transaction.json');
  let progress;
  let log;
  let logged = 0;
  let workspace;
  let env;
  let currentStage = 'version';
  const warnings = [];
  const retained = new Set();
  function warn(message) {
    if (!warnings.includes(message)) warnings.push(message);
    try { process.stderr.write(`[carly-switch] Warning: ${message}\n`); } catch {}
  }
  async function finish(name = 'complete') {
    try { await stage(name, 'complete'); }
    catch { warn('The operation committed, but its final progress or log update could not be written.'); }
  }
  async function append(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    // Only controlled summaries are logged: never raw subprocess output.
    if (log && logged + Buffer.byteLength(line) <= 256 * 1024) { await log.write(line); logged += Buffer.byteLength(line); }
  }
  async function stage(name, state = 'running') {
    currentStage = name;
    if (!progress) return;
    progress = { ...progress, stage: name, state, ...(state === 'failed' || state === 'complete' ? { finishedAt: Date.now() } : {}) };
    if (state === 'running' || state === 'ready') delete progress.finishedAt;
    await atomicJSON(join(data, 'build.json'), progress);
    await append(`${state}: ${MESSAGES[name]}`);
    process.stderr.write(`[carly-switch] ${MESSAGES[name]} Log: ${join(data, progress.logName)}\n`);
  }
  async function command(args, cwd, { capture = false, seconds, allowFailure = false } = {}) {
    if (!env) throw new Error('Build environment is not initialized');
    const result = await runCommand(args, { cwd, env, seconds, capture });
    const name = args[0] === process.execPath ? 'bun' : basename(String(args[0] ?? ''));
    const executableName = /^[A-Za-z0-9._-]{1,80}$/u.test(name) ? name : 'executable';
    await append(`Command ${executableName} completed in ${currentStage}: exit ${result.code}${result.timedOut ? ' (timeout)' : ''}.`);
    if (result.timedOut || result.code !== 0) {
      if (allowFailure) return null;
      if (result.timedOut) throw new BuildError(`The ${currentStage} stage exceeded its time limit.`);
      throw new Error('Build command failed');
    }
    return result.output;
  }
  function errorMessage() {
    return `Runtime preparation failed during ${currentStage}. No raw child output is displayed.${progress ? ` Private build log: ${join(data, progress.logName)}.` : ''}`;
  }
  async function guarded(fn) {
    try { return await fn(); }
    catch (error) {
      if (error instanceof BuildError) await append(error.message).catch(() => {});
      await stage(currentStage, 'failed').catch(() => {});
      fail(`${error instanceof BuildError ? `${error.message} ` : ''}${errorMessage()}`);
    }
  }
  async function initialize() {
    await privateDirectory(root, home);
    await chmod(root, 0o700);
    const logName = `build-${randomUUID()}.log`;
    log = await open(join(data, logName), 'wx', 0o600);
    progress = { state: 'running', stage: 'version', startedAt: Date.now(), logName };
    workspace = await mkdtemp(join(root, '.build-'));
    await mkdir(join(workspace, 'home'), { mode: 0o700 });
    await mkdir(join(workspace, 'tmp'), { mode: 0o700 });
    env = isolatedEnvironment(join(workspace, 'home'), join(workspace, 'tmp'));
  }
  async function smoke(path) {
    await stage('smoke');
    const version = await command([path, '--version'], '/', { capture: true, seconds: limits.version });
    if (version !== `omp/${VERSION}`) throw new BuildError(`The candidate does not report exactly omp/${VERSION}.`);
    for (const [key, value] of [['live.provider', 'doubao'], ['live.doubao.apiKeyFile', join(workspace, 'unused-key')], ['live.doubao.voice', 'zh_female_vv_jupiter_bigtts'], ['live.provider', 'codex']]) {
      await command([path, 'config', 'set', key, value, '--json'], '/', { seconds: limits.smoke });
      const output = await command([path, 'config', 'get', key, '--json'], '/', { capture: true, seconds: limits.smoke });
      const parsed = JSON.parse(output);
      if (parsed.value !== value) throw new Error('Candidate setting mismatch');
    }
  }
  function transaction(record) {
    const directory = join(root, record.directory);
    const candidate = join(directory, 'candidate');
    const oldRuntime = join(directory, 'previous-omp');
    const oldManifest = join(directory, 'previous-manifest.json');
    async function checkedCurrent() {
      const [binary, manifest] = await Promise.all([fingerprint(runtime), fingerprint(manifestPath)]);
      if (![record.beforeBinary, record.afterBinary].includes(binary) || ![record.beforeManifest, record.afterManifest].includes(manifest)) {
        fail('The runtime changed outside this transaction. Runtime recovery evidence was retained; do not overwrite it.');
      }
      return { binary, manifest };
    }
    async function restoreFile(path, backup, before, current) {
      if (current === before) return;
      if (before === null) {
        if (await fingerprint(path) !== current) fail('The runtime changed during recovery; evidence was retained.');
        await unlink(path);
        return;
      }
      if (await fingerprint(backup) !== before) fail('The runtime recovery backup changed; recovery evidence was retained.');
      const temp = join(directory, `restore-${randomUUID()}`);
      await copyFile(backup, temp, constants.COPYFILE_EXCL);
      if (await fingerprint(path) !== current) fail('The runtime changed during recovery; evidence was retained.');
      await rename(temp, path);
    }
    return {
      id: record.directory, path: candidate, target: runtime, reused: false,
      async install() {
        await stage('install');
        const current = await checkedCurrent();
        if (current.binary !== record.beforeBinary || current.manifest !== record.beforeManifest) fail('The runtime changed before installation; recovery evidence was retained.');
        const temp = join(directory, 'install-omp');
        await copyFile(candidate, temp, constants.COPYFILE_EXCL);
        if (await fingerprint(candidate) !== record.afterBinary || await fingerprint(runtime) !== record.beforeBinary ||
            await fingerprint(manifestPath) !== record.beforeManifest) fail('The runtime changed during installation; recovery evidence was retained.');
        await rename(temp, runtime);
        if (await fingerprint(manifestPath) !== record.beforeManifest) fail('The runtime manifest changed during installation; recovery evidence was retained.');
        await atomicJSON(manifestPath, record.manifest);
        await stage('activate');
      },
      async rollback() {
        await stage('rollback');
        const current = await checkedCurrent();
        await restoreFile(runtime, oldRuntime, record.beforeBinary, current.binary);
        await restoreFile(manifestPath, oldManifest, record.beforeManifest, current.manifest);
        await unlink(journalPath);
        await rm(directory, { recursive: true });
        await stage('rollback', 'failed');
      },
      async finalize() {
        // The helper's clean state record is the activation commit point.
        // Detach the recovery journal before deleting any candidate/backup data.
        // A failed cleanup leaves a separate receipt, never a half-cleaned active
        // transaction that could prevent the next switch or restore.
        const receipt = join(root, `.committed-${randomUUID()}.json`);
        try {
          const current = await checkedCurrent();
          if (current.binary !== record.afterBinary || current.manifest !== record.afterManifest) throw new Error('Committed runtime changed');
          if (await info(receipt)) throw new Error('Existing cleanup receipt');
          await rename(journalPath, receipt);
        } catch {
          retained.add(directory);
          warn('Activation committed, but the runtime recovery journal could not be retired safely. Recovery evidence was retained; cleanup will be retried on the next operation.');
          await finish();
          return;
        }
        try {
          const remaining = await info(directory);
          if (remaining && (!remaining.isDirectory() || remaining.uid !== process.getuid())) throw new Error('Unsafe cleanup directory');
          await rm(directory, { recursive: true, force: true });
          await unlink(receipt);
        } catch {
          retained.add(directory);
          warn('Activation committed, but private build cleanup is incomplete. A committed cleanup receipt and remaining artifacts were retained in the managed runtime directory; later switches and restore remain available.');
        }
        await finish();
      },
    };
  }
  function recoveryRecordValid(record) {
    return record?.version === 1 && /^\.build-[A-Za-z0-9]+$/u.test(record.directory) &&
      [record.beforeBinary, record.beforeManifest, record.afterBinary, record.afterManifest].every(validHash) &&
      !!record.afterBinary && !!record.afterManifest && digest(`${JSON.stringify(record.manifest)}\n`) === record.afterManifest;
  }
  return {
    async pending(committedId) {
      const value = await info(journalPath);
      if (!value) return null;
      try { await privateDirectory(root, home, false); }
      catch { fail('Unsafe runtime recovery directory; refusing changes.'); }
      if (!value.isFile() || value.uid !== process.getuid() || value.mode & 0o077) fail('Unsafe runtime recovery record; refusing changes.');
      let record;
      try { record = JSON.parse(await readFile(journalPath, 'utf8')); } catch { fail('Unreadable runtime recovery record; refusing changes.'); }
      if (!recoveryRecordValid(record)) fail('Invalid runtime recovery record; refusing changes.');
      // A committed activation no longer depends on candidate or backup files.
      if (record.directory === committedId) return transaction(record);
      const directory = join(root, record.directory);
      const valueDirectory = await lstat(directory);
      if (!valueDirectory.isDirectory() || valueDirectory.uid !== process.getuid() || valueDirectory.mode & 0o077 ||
          await fingerprint(join(directory, 'candidate')) !== record.afterBinary) fail('Runtime recovery candidate is missing or changed; refusing changes.');
      return transaction(record);
    },
    async validateOfficial(path) {
      // Official version inspection must precede recovery, builds, or settings writes.
      await guarded(async () => {
        await initialize();
        await stage('version');
        const version = await command([path, '--version'], '/', { capture: true, seconds: limits.version });
        if (version !== `omp/${VERSION}`) throw new BuildError(`Only official OMP ${VERSION} is supported; the detected version is not an exact match. No runtime, settings, or entry was changed.`);
      });
    },
    async prepare() {
      return guarded(async () => {
        const base = { version: VERSION, commit: COMMIT, patchSHA256: digest(await readFile(patch)), platform: process.platform, arch: process.arch };
        let cached;
        // Throw if manifest.json exists but is not a user-owned regular file.
        await assertSafe(manifestPath);
        try { cached = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
        if (cacheMatches(cached, base, await fingerprint(runtime))) {
          await access(runtime, constants.X_OK);
          await stage('cache');
          await smoke(runtime);
          return { path: runtime, target: runtime, reused: true,
            install: async () => stage('activate'), rollback: async () => stage('rollback', 'failed'),
            finalize: async () => finish() };
        }
        await stage('prerequisites');
        const [major, minor] = Bun.version.split('.').map(Number);
        if (major < 1 || (major === 1 && minor < 4)) throw new BuildError('Install Bun 1.4 or newer before building.');
        if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new BuildError('This build supports macOS arm64 and x64 only.');
        for (const tool of ['git', 'codesign']) if (!Bun.which(tool)) throw new BuildError(`Required build tool is missing: ${tool}.`);
        await command(['git', '--version'], '/', { seconds: limits.probe });
        await stage('source');
        const source = join(workspace, 'source');
        await command(['git', '-c', 'credential.helper=', 'clone', '--depth', '1', '--branch', `v${VERSION}`, '--single-branch', REPOSITORY, source], '/', { seconds: limits.clone });
        if (await command(['git', 'rev-parse', 'HEAD'], source, { capture: true, seconds: limits.probe }) !== COMMIT) throw new BuildError('The fetched tag does not match the pinned source commit.');
        await stage('patch');
        await command(['git', 'apply', '--check', patch], source, { seconds: limits.probe });
        await command(['git', 'apply', patch], source, { seconds: limits.probe });
        await stage('dependencies');
        await command([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts'], source, { seconds: limits.dependencies });
        await stage('native');
        const nativeName = `pi_natives.darwin-${process.arch === 'arm64' ? 'arm64' : 'x64-baseline'}.node`;
        const native = join(source, 'packages', 'natives', 'native', nativeName);
        const warm = join(home, '.omp', 'natives', VERSION, nativeName);
        let nativeSHA256 = await reuseWarmNative({ warm, native, command, append, seconds: limits.addon });
        if (!nativeSHA256) {
          for (const tool of ['cargo', 'rustc', 'rustup', 'xcrun', 'clang', 'ar', 'ranlib', 'make', 'cmake']) {
            if (!Bun.which(tool)) throw new BuildError(`Required cold native build tool is missing: ${tool}.`);
          }
          await command(['xcrun', '--find', 'clang'], '/', { seconds: limits.probe });
          // Keep Cargo tokens/config and Rustup settings out of the build environment.
          env.CARGO_HOME = join(workspace, 'home', '.cargo');
          env.RUSTUP_HOME = join(workspace, 'home', '.rustup');
          env.RUSTUP_TOOLCHAIN = await readRustChannel(source);
          await append(`Using Rust toolchain ${env.RUSTUP_TOOLCHAIN} from rust-toolchain.toml.`);
          await command(['rustup', 'toolchain', 'install', env.RUSTUP_TOOLCHAIN, '--profile', 'minimal'], '/', { seconds: limits.toolchain });
          await command([process.execPath, 'run', 'build:native'], source, { seconds: limits.native });
          nativeSHA256 = digest(await readFile(native));
          await append(`Built native addon SHA-256 ${nativeSHA256}.`);
        }
        await stage('compile');
        await command([process.execPath, 'run', 'build'], join(source, 'packages', 'coding-agent'), { seconds: limits.compile });
        const candidate = join(workspace, 'candidate');
        await copyFile(join(source, 'packages', 'coding-agent', 'dist', 'omp'), candidate, constants.COPYFILE_EXCL);
        await chmod(candidate, 0o700);
        await smoke(candidate);
        const manifest = { ...base, binarySHA256: await fingerprint(candidate), nativeSHA256 };
        const beforeBinary = await fingerprint(runtime);
        const beforeManifest = await fingerprint(manifestPath);
        if (beforeBinary !== null) await copyFile(runtime, join(workspace, 'previous-omp'), constants.COPYFILE_EXCL);
        if (beforeManifest !== null) await copyFile(manifestPath, join(workspace, 'previous-manifest.json'), constants.COPYFILE_EXCL);
        if (await fingerprint(runtime) !== beforeBinary || await fingerprint(manifestPath) !== beforeManifest) throw new Error('Runtime changed during preparation');
        const record = { version: 1, directory: workspace.slice(root.length + 1), beforeBinary, beforeManifest,
          afterBinary: manifest.binarySHA256, afterManifest: digest(`${JSON.stringify(manifest)}\n`), manifest };
        if (await info(journalPath)) throw new Error('Existing runtime transaction');
        await atomicJSON(journalPath, record);
        await stage('smoke', 'ready');
        return transaction(record);
      });
    },
    async complete() { await finish('manual'); },
    warnings() { return [...warnings]; },
    async failed() { await stage(currentStage, 'failed').catch(() => {}); },
    async close() {
      try { await log?.close(); }
      catch { warn('The operation finished, but its private build log could not be closed normally.'); }
      log = undefined;
      // Preserve active recovery data and incomplete committed cleanup receipts.
      if (workspace && !retained.has(workspace)) {
        try {
          let pending;
          try { pending = JSON.parse(await readFile(journalPath, 'utf8')); }
          catch (error) { if (!absent(error)) throw error; }
          if (pending?.directory !== workspace.slice(root.length + 1)) await rm(workspace, { recursive: true, force: true });
        } catch { warn('Private staging cleanup is incomplete; remaining build artifacts were retained.'); }
      }
    },
  };
}

#!/usr/bin/env bun
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readlink, realpath, rename, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { YAML } from 'bun';
import { fileURLToPath } from 'node:url';
import { readBuild, runtimeManager, SWITCH_TIMEOUT_MS, VERSION } from './runtime-build.mjs';

// No key contents, child output, server payloads, or raw exceptions are logged.
const HOME = homedir();
const DEFAULT_RUNTIME = join(HOME, '.local', 'share', 'carly-switch', 'omp');
let CUSTOM = DEFAULT_RUNTIME;
let CONFIG_RUNTIME;
const canAutoBuild = process.env.CARLY_SWITCH_OMP === undefined;
const ENTRY = join(HOME, '.local', 'bin', 'omp');
const CONFIG = join(HOME, '.omp', 'agent');
const DATA = join(HOME, 'Library', 'Application Support', 'Tern', 'plugin-data', 'carly-switch');
const STATE = join(DATA, 'state.json');
const LOCK = join(DATA, 'operation.lock');
const DEFAULT_VOICE = 'zh_female_vv_jupiter_bigtts';
const MAX_KEY_BYTES = 16 * 1024;
// Provider is written last, including during rollback and restore.
const KEYS = ['live.doubao.apiKeyFile', 'live.doubao.voice', 'live.provider'];
const RUNTIME_HELP = canAutoBuild
  ? `The first Save/apply builds the pinned compatible OMP v${VERSION} runtime. Opening this panel does not build or change files.`
  : 'The explicitly selected CARLY_SWITCH_OMP runtime is missing or not executable. Supply a compatible runtime; explicit overrides are never built or overwritten.';
const HELP = `Carly Switch (macOS only; default ~/.omp/agent global configuration)
Usage: bun helper.mjs status|build-status|switch|restore|check [--provider codex|doubao] [--key-stdin] [--voice VOICE_ID]
Runtime: first Save/apply builds pinned OMP v${VERSION} with the shipped patch at ~/.local/share/carly-switch/omp. Official Tern OMP must be exactly v${VERSION}. Each build stage has a time limit and fails closed before settings change. Requires Bun >=1.4, Git and codesign; a cold native build also requires Cargo/Rustup, CMake and Xcode Command Line Tools. CARLY_SWITCH_OMP is a manual compatible-runtime override and is never overwritten.
status: read-only; does not execute OMP or read key contents.
build-status: read-only progress metadata; never executes OMP. Private logs contain only controlled stage and command-exit summaries, not raw child output.
switch --provider doubao: save and apply Doubao voice settings; first takeover backs up the original entry and three live fields.
switch --provider codex: use the compatible runtime's OpenAI voice implementation; Doubao key and voice arguments are rejected. This does not restore the original executable.
--key-stdin: for Doubao switch/check only; read one UTF-8 API key directly from stdin (maximum 16 KiB). Never put keys in command arguments, environment variables, or public files. Empty or invalid input is rejected.
Leave the input blank and omit --key-stdin to reuse the explicitly configured apiKeyFile. No key file is assumed by default; existing external key files are never overwritten or deleted.
New keys are saved only as separate files (0600) in the plugin's private directory (0700). Configuration and backups record paths only.
check: draft keys stay in memory; authenticate with the official Doubao service, create a session, mute, and close normally. No microphone, recording, playback, key writes, or configuration writes.
restore: restore the original Tern-managed OMP symlink and previous fields; refuse to overwrite third-party changes and never delete personal files.
The first switch changes the entry for new OMP sessions and requires restarting Tern; existing sessions are unaffected. Later settings apply when voice is next started.
All output is one JSON object; a nonzero exit indicates failure. Key contents are never output or written to backups or transaction records.
Operations use an exclusive cross-window lock. After forced termination, remove operation.lock manually only after confirming no helper is running, then run restore to recover the unfinished transaction.`;
class SafeError extends Error {}
const fail = message => { throw new SafeError(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const missing = error => error?.code === 'ENOENT';

function runtimePath() {
  const value = process.env.CARLY_SWITCH_OMP;
  if (value === undefined) return CUSTOM;
  if (!value || /[\x00-\x1f\x7f]/u.test(value) || (!isAbsolute(value) && !value.startsWith('~/'))) {
    fail('Invalid CARLY_SWITCH_OMP. Use an absolute or ~/ path to a compatible executable; the supplied value is not displayed.');
  }
  return resolve(value.startsWith('~/') ? join(HOME, value.slice(2)) : value);
}

async function maybeStat(path, follow = false) {
  try { return await (follow ? stat(path) : lstat(path)); }
  catch (error) { if (missing(error)) return null; throw error; }
}
async function executable(path) {
  try { return (await stat(path)).isFile() && (await access(path, constants.X_OK), true); }
  catch { return false; }
}
async function keyExists(path) {
  if (!path) return false;
  try { return (await stat(path)).isFile() && (await access(path, constants.R_OK), true); }
  catch { return false; }
}
function assertScope() {
  if (process.platform !== 'darwin') fail('Only macOS is supported; no configuration was changed.');
  if ((process.env.PI_PROFILE && process.env.PI_PROFILE !== 'default') ||
      (process.env.OMP_PROFILE && process.env.OMP_PROFILE !== 'default') ||
      (process.env.PI_CODING_AGENT_DIR && resolve(process.env.PI_CODING_AGENT_DIR) !== CONFIG) ||
      (process.env.OMP_CODING_AGENT_DIR && resolve(process.env.OMP_CODING_AGENT_DIR) !== CONFIG)) {
    fail('The plugin manages only the default ~/.omp/agent directory. Remove inherited non-default profile or agent-dir environment variables and retry.');
  }
}
function options() {
  const args = process.argv.slice(2);
  const action = args.shift() ?? 'status';
  if (action === '--help' || action === '-h') {
    if (args.length) fail('--help does not accept additional arguments.');
    return { action: 'help' };
  }
  if (!['status', 'build-status', 'switch', 'restore', 'check'].includes(action)) fail('Unknown action; see --help.');
  const result = { action };
  const names = { '--provider': 'provider', '--voice': 'voice' };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--key-stdin') {
      if (result.keyStdin) fail('Invalid or duplicate argument; see --help.');
      result.keyStdin = true;
      continue;
    }
    const name = names[flag];
    const value = args.shift();
    if (!name || value === undefined || value.startsWith('--') || Object.hasOwn(result, name)) fail('Invalid or duplicate argument; see --help.');
    result[name] = value;
  }
  if (result.provider !== undefined && !['codex', 'doubao'].includes(result.provider)) fail('Provider must be codex or doubao.');
  if (action === 'switch' && result.provider === undefined) fail('Switch requires an explicit --provider codex or doubao.');
  if (['status', 'build-status', 'restore'].includes(action) && Object.keys(result).length !== 1) fail('status, build-status and restore do not accept settings arguments.');
  if (action === 'check' && result.provider === 'codex') fail('check tests only the Doubao connection, not OpenAI.');
  if (result.provider === 'codex' && (result.keyStdin || result.voice !== undefined)) fail('OpenAI does not accept Doubao key or voice arguments.');
  if (result.voice !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,159}$/u.test(result.voice)) fail('Voice IDs must contain 1-160 letters, digits, underscores, or hyphens and cannot begin with a hyphen.');
  return result;
}

function validateKey(key) {
  const value = key.trim();
  if (!value || !/^[\x21-\x7e]+$/u.test(value)) fail('Invalid API key format: provide one key with no internal whitespace or control characters.');
  return value;
}
async function readStdinKey() {
  const bytes = Buffer.alloc(MAX_KEY_BYTES);
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      if (length + chunk.length > MAX_KEY_BYTES) fail('API key input exceeds the 16 KiB limit.');
      chunk.copy(bytes, length);
      length += chunk.length;
    }
    let key;
    try { key = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { fail('API key input must be valid UTF-8.'); }
    return validateKey(key);
  } finally { bytes.fill(0); }
}

function privateKeyPath(path) {
  return typeof path === 'string' && dirname(path) === DATA && /^key-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(path.slice(DATA.length + 1));
}
async function savePrivateKey(path, key) {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(key, 'utf8');
    await handle.sync();
  } catch (error) {
    if (handle) await unlink(path).catch(cause => { if (!missing(cause)) throw cause; });
    throw error;
  } finally { await handle?.close(); }
}

async function fields() {
  let parsed = {};
  for (const name of ['config.yml', 'config.yaml']) {
    let source;
    try { source = await readFile(join(CONFIG, name), 'utf8'); }
    catch (error) { if (missing(error)) continue; fail('Cannot read the OMP configuration.'); }
    try { parsed = YAML.parse(source) ?? {}; }
    catch { fail('Cannot parse the OMP YAML configuration; stopped to avoid automatic quarantine by the native CLI.'); }
    if (!record(parsed)) fail('The OMP configuration root must be a mapping.');
    break;
  }
  const result = {};
  for (const key of KEYS) {
    let current = parsed;
    const segments = key.split('.');
    let present = true;
    for (const segment of segments) {
      if (!record(current)) fail('The live configuration contains a non-mapping parent and cannot be safely backed up.');
      if (!Object.hasOwn(current, segment)) { present = false; break; }
      current = current[segment];
    }
    if (present && typeof current !== 'string') fail('A live configuration field is not a string and cannot be restored exactly through the native CLI.');
    result[key] = present ? { present: true, value: current } : { present: false };
  }
  const provider = result['live.provider'];
  if (provider.present && !['codex', 'doubao'].includes(provider.value)) fail('Unsupported live.provider value; stopped to protect the original configuration.');
  const savedPath = result['live.doubao.apiKeyFile'];
  if (savedPath.present && savedPath.value && (!isAbsolute(savedPath.value) || /[\x00-\x1f\x7f]/u.test(savedPath.value))) fail('The saved key field is not a valid absolute file path; its value will not be displayed or copied.');
  const savedVoice = result['live.doubao.voice'];
  if (savedVoice.present && !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,159}$/u.test(savedVoice.value)) fail('The saved voice ID cannot be safely restored through the native CLI.');
  return result;
}
function validFields(value) {
  return record(value) && Object.keys(value).length === KEYS.length && KEYS.every(key => {
    const field = value[key];
    return record(field) && typeof field.present === 'boolean' &&
      (field.present ? typeof field.value === 'string' : !Object.hasOwn(field, 'value'));
  });
}
async function loadState() {
  const info = await maybeStat(STATE);
  if (!info) return null;
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) fail('Unsafe plugin backup permissions; a regular 0600 file owned by the current user is required.');
  let value;
  try { value = JSON.parse(await readFile(STATE, 'utf8')); }
  catch { fail('Cannot read the plugin backup; refusing to overwrite the original entry.'); }
  if (value?.version !== 1 || value.entry !== ENTRY || value.configDir !== CONFIG || value.custom !== CUSTOM ||
      typeof value.originalTarget !== 'string' || !value.originalTarget ||
      !validFields(value.originalFields) || !validFields(value.managedFields)) fail('The plugin backup does not match this installation or runtime path; refusing changes.');
  if (value.pending && (!validFields(value.pending.beforeFields) || !validFields(value.pending.afterFields) ||
      typeof value.pending.beforeTarget !== 'string' || typeof value.pending.afterTarget !== 'string' ||
      typeof value.pending.first !== 'boolean')) fail('Invalid plugin transaction record; refusing changes.');
  if (value.pending?.newKeyFile !== undefined &&
      (!privateKeyPath(value.pending.newKeyFile) ||
       value.pending.afterFields['live.doubao.apiKeyFile'].value !== value.pending.newKeyFile ||
       value.pending.beforeFields['live.doubao.apiKeyFile'].value === value.pending.newKeyFile ||
       value.originalFields['live.doubao.apiKeyFile'].value === value.pending.newKeyFile)) fail('Invalid plugin key transaction record; refusing changes.');
  return value;
}
async function entryInfo() {
  const info = await maybeStat(ENTRY);
  if (!info) return { kind: 'missing', target: null };
  if (!info.isSymbolicLink()) return { kind: 'file', target: null };
  return { kind: 'link', target: await readlink(ENTRY), ino: info.ino, dev: info.dev };
}
async function snapshot(action) {
  const [current, state, link, customBinaryExists] = await Promise.all([fields(), loadState(), entryInfo(), executable(CUSTOM)]);
  const provider = current['live.provider'].present ? current['live.provider'].value : 'codex';
  const keyFile = current['live.doubao.apiKeyFile'].present ? current['live.doubao.apiKeyFile'].value : '';
  const voice = current['live.doubao.voice'].present ? current['live.doubao.voice'].value : DEFAULT_VOICE;
  const installed = !!state && link.kind === 'link' && link.target === CUSTOM;
  let message = installed ? 'Compatible native OMP is active. Showing default global voice settings; project overrides may differ.' : 'The plugin-managed entry is not active.';
  let error;
  if (state?.pending) error = 'An unfinished transaction was detected. Run restore, or switch again to roll it back safely first.';
  else if (state && (link.target !== CUSTOM || !same(current, state.managedFields))) error = 'Third-party entry or live configuration changes were detected. The plugin will not overwrite them; revert those changes or reconcile the backup manually.';
  else if (!state && link.kind === 'link' && resolve(dirname(ENTRY), link.target) === CUSTOM) error = 'The entry points to the compatible runtime but its backup is missing; restore or takeover cannot proceed safely.';
  else if (link.kind !== 'link') error = 'The OMP entry is not an existing symlink; the plugin will not overwrite regular files or create a new entry.';
  if (!customBinaryExists) {
    if (error) error = `${error} ${RUNTIME_HELP}`;
    else message = `${message} ${RUNTIME_HELP}`;
  }
  return { ok: !error, action, version: VERSION, switchTimeoutMs: SWITCH_TIMEOUT_MS, provider, installed, customBinaryExists, canAutoBuild, build: await readBuild(DATA), keyFile, voice,
    hasKeyFile: await keyExists(keyFile), entry: ENTRY, originalTarget: state?.originalTarget ?? null,
    restartRequired: installed || !!state?.pending, message: error ?? message, ...(error ? { error } : {}) };
}
async function secureData() {
  // Reject symlinked directories before creating or opening a private file.
  let current = HOME;
  const homeInfo = await lstat(current);
  if (!homeInfo.isDirectory() || homeInfo.uid !== process.getuid()) fail('The plugin data directory is unsafe.');
  for (const segment of DATA.slice(HOME.length + 1).split('/')) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.uid !== process.getuid()) fail('The plugin data directory is unsafe.');
  }
  const directory = await open(DATA, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.chmod(0o700); }
  finally { await directory.close(); }
}
async function saveState(value) {
  const temp = join(DATA, `.state-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temp, STATE);
  } finally {
    await handle?.close();
    await unlink(temp).catch(error => { if (!missing(error)) throw error; });
  }
}
async function withLock(fn) {
  await secureData();
  try { await mkdir(LOCK, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === 'EEXIST') fail('Another window is operating, or an interrupted operation left a lock. Retry later and see --help.');
    throw error;
  }
  try { return await fn(); }
  finally { await rmdir(LOCK); }
}
async function requireEntry(target) {
  const current = await entryInfo();
  if (current.kind !== 'link' || current.target !== target) fail('Another program changed the OMP entry; refusing to overwrite it.');
  return current;
}
async function replaceEntry(before, after) {
  const initial = await requireEntry(before);
  if (before === after) return;
  const temp = join(dirname(ENTRY), `.omp-carly-switch-${randomUUID()}`);
  try {
    await symlink(after, temp);
    const current = await requireEntry(before);
    if (initial.ino !== current.ino || initial.dev !== current.dev) fail('The OMP entry changed during this operation; refusing to overwrite it.');
    // Same-directory rename is atomic; recheck identity immediately before it.
    await rename(temp, ENTRY);
  } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
}
async function officialTarget(target) {
  const candidate = resolve(dirname(ENTRY), target);
  const versions = join(HOME, 'Library', 'Application Support', 'Tern', 'omp', 'versions');
  const [canonical, base] = await Promise.all([realpath(candidate), realpath(versions)]).catch(() => fail('Cannot read the original OMP entry target or safely back it up.'));
  if (!canonical.startsWith(`${base}/`) || !await executable(candidate)) fail('The OMP entry is not a Tern-managed official version; unknown third-party entries will not be taken over.');
  return canonical;
}
async function configCommand(args) {
  // ':' is truthy (blocks .env fallback), but yields zero config overlays
  // after the native POSIX delimiter split/filter. Pin both env aliases.
  const env = { ...process.env, PI_CODING_AGENT_DIR: CONFIG, OMP_CODING_AGENT_DIR: CONFIG,
    PI_PROFILE: 'default', OMP_PROFILE: 'default', PI_CONFIG_FILES: ':', OMP_CONFIG_FILES: ':', NO_COLOR: '1' };
  let child;
  try { child = Bun.spawn([CONFIG_RUNTIME ?? CUSTOM, 'config', ...args, '--json'], { cwd: '/', env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }); }
  catch { fail('Cannot start the compatible OMP configuration command.'); }
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0) fail('The native OMP configuration command failed or timed out; potentially private child output is withheld.');
    return output.trim();
  } finally { clearTimeout(timer); }
}
async function setField(key, value) {
  await configCommand(value.present ? ['set', key, value.value] : ['reset', key]);
}
async function assertFields(expected) {
  if (!same(await fields(), expected)) fail('Another program changed the live configuration; refusing to overwrite it.');
}
async function applyFields(before, after, target) {
  const expected = structuredClone(before);
  for (const key of KEYS) {
    await requireEntry(target);
    await assertFields(expected);
    if (same(expected[key], after[key])) continue;
    await setField(key, after[key]);
    expected[key] = after[key];
    await assertFields(expected);
  }
}
async function rollback(state) {
  const txn = state.pending;
  if (!txn) return state;
  // A persisted intent survives interruption. Only revert values that are
  // either the recorded prior value or this transaction's intended value.
  const current = await fields();
  for (const key of KEYS) {
    if (!same(current[key], txn.beforeFields[key]) && !same(current[key], txn.afterFields[key])) fail('The unfinished transaction conflicts with third-party live changes; retaining the backup without overwriting.');
  }
  const link = await entryInfo();
  if (link.kind !== 'link' || ![txn.beforeTarget, txn.afterTarget].includes(link.target)) fail('The unfinished transaction conflicts with third-party entry changes; retaining the backup.');
  await applyFields(current, txn.beforeFields, link.target);
  await replaceEntry(link.target, txn.beforeTarget);
  if (txn.newKeyFile) await unlink(txn.newKeyFile).catch(error => { if (!missing(error)) throw error; });
  if (txn.first) { await unlink(STATE); return null; }
  const clean = { ...state, pending: null };
  await saveState(clean);
  return clean;
}
async function mutate(opts, inputKey) {
  if (!canAutoBuild && !await executable(CUSTOM)) fail(`${RUNTIME_HELP} The entry has not been changed.`);
  return withLock(async () => {
    const builder = runtimeManager({ home: HOME, data: DATA, runtime: DEFAULT_RUNTIME,
      patch: fileURLToPath(new URL('./patches/omp-native-doubao.patch', import.meta.url)), fail });
    let response;
    try {
      let state = await loadState();
      let link = await entryInfo();
      if (link.kind !== 'link') fail('Only existing OMP symlinks can be replaced; regular files and missing entries are left unchanged.');
      if (opts.action === 'switch') {
        const original = await officialTarget(state?.originalTarget ?? link.target);
        await builder.validateOfficial(original);
      }
      const recovery = canAutoBuild ? await builder.pending(state?.runtimeBuild) : null;
      const recoveringFirst = opts.action === 'restore' && state?.pending?.first;
      CONFIG_RUNTIME = recovery?.path ?? CUSTOM;
      if (state?.pending) state = await rollback(state);
      if (recovery) {
        if (state?.runtimeBuild === recovery.id) await recovery.finalize();
        else await recovery.rollback();
      }
      CONFIG_RUNTIME = CUSTOM;
      if (recoveringFirst) {
        const result = await snapshot(opts.action);
        result.restartRequired = true;
        result.message = 'The interrupted first activation was rolled back. The original OMP entry and live settings are restored.';
        response = result;
        return response;
      }
      const before = await fields();
      link = await entryInfo();
      if (link.kind !== 'link') fail('The OMP entry changed; refusing changes.');
      if (state) {
        await requireEntry(CUSTOM);
        await assertFields(state.managedFields);
      } else if (opts.action === 'restore') {
        fail('No plugin backup exists; no personal configuration or entry was changed.');
      } else {
        await officialTarget(link.target);
      }
      if (opts.action === 'restore') {
        await officialTarget(state.originalTarget);
        if (!await executable(CUSTOM)) fail('The compatible runtime required to restore the saved live fields is missing. Restore it before retrying; the original entry was not changed.');
      }
      const first = !state;
      const status = await snapshot(opts.action);
      const newKeyFile = inputKey === undefined ? undefined : join(DATA, `key-${randomUUID()}`);
      const next = opts.action === 'restore' ? state.originalFields : {
        ...before, 'live.provider': { present: true, value: opts.provider },
      };
      if (opts.action === 'switch' && opts.provider === 'doubao') {
        next['live.doubao.apiKeyFile'] = { present: true, value: newKeyFile ?? status.keyFile };
        next['live.doubao.voice'] = { present: true, value: opts.voice ?? status.voice };
        if (!newKeyFile && !await keyExists(status.keyFile)) fail('Enter an API key; no readable existing key file is configured.');
      }
      await requireEntry(link.target);
      const runtime = opts.action === 'switch' && canAutoBuild ? await builder.prepare() : null;
      CONFIG_RUNTIME = runtime?.path ?? CUSTOM;
      state ??= { version: 1, entry: ENTRY, custom: CUSTOM, configDir: CONFIG,
        originalTarget: link.target, originalFields: before, managedFields: before, pending: null };
      const target = opts.action === 'restore' ? state.originalTarget : CUSTOM;
      state = { ...state, pending: { first, beforeFields: before, afterFields: next, beforeTarget: link.target, afterTarget: target,
        ...(newKeyFile ? { newKeyFile } : {}) } };
      let keyCreated = false;
      let journalWritten = false;
      try {
        await requireEntry(link.target);
        await assertFields(before);
        // A tested candidate is ready before any credentials or settings are written.
        if (newKeyFile) {
          await savePrivateKey(newKeyFile, inputKey);
          keyCreated = true;
          inputKey = undefined;
        }
        await saveState(state);
        journalWritten = true;
        if (await configCommand(['path']) !== CONFIG) fail('The native OMP configuration directory does not match the backup; stopped.');
        await assertFields(before);
        await runtime?.install();
        await applyFields(before, next, link.target);
        await replaceEntry(link.target, target);
        if (opts.action === 'restore') await unlink(STATE);
        else await saveState({ ...state, managedFields: next, pending: null,
          ...(runtime?.id ? { runtimeBuild: runtime.id } : {}) });
        // Commit point: settings/entry are applied and the clean backup is durable.
        // Runtime finalization below is housekeeping, not a rollback boundary.
      } catch (error) {
        try {
          // Keep the staged candidate usable until configuration rollback completes.
          if (journalWritten) await rollback(state);
          else if (keyCreated) await unlink(newKeyFile);
          await runtime?.rollback();
        } catch { fail('The operation failed and could not be fully rolled back safely. Backup, candidate, and transaction records were retained. Do not overwrite the entry, runtime, or configuration; resolve conflicts and run restore.'); }
        fail(`${error instanceof SafeError ? error.message : 'Operation failed.'} These changes were rolled back; the original key was not modified.`);
      }
      await runtime?.finalize();
      if (!runtime) await builder.complete();
      const result = await snapshot(opts.action);
      result.restartRequired = first || opts.action === 'restore';
      result.message = opts.action === 'restore'
        ? 'Original OMP restored. Restart Tern to apply; the current call is unaffected.'
        : `${opts.provider === 'doubao' ? 'Doubao' : 'OpenAI'} saved. ${first ? 'Restart Tern to apply; the current call is unaffected.' : 'Changes apply when voice is next started.'}`;
      response = result;
      return response;
    } catch (error) {
      await builder.failed();
      throw error;
    } finally {
      CONFIG_RUNTIME = CUSTOM;
      await builder.close();
      const warning = builder.warnings().join(' ');
      if (response && warning) {
        response.warning = warning;
        response.message = `${response.message} Warning: ${warning}`;
      }
    }
  });
}

async function checkConnection(keyFile, voice, inputKey) {
  let key = inputKey;
  inputKey = undefined;
  if (key === undefined) {
    if (!keyFile || !await keyExists(keyFile)) fail('Enter an API key; no readable existing key file is configured.');
    try { key = (await readFile(keyFile, 'utf8')).trim(); }
    catch { fail('Cannot read the key file.'); }
  }
  if (!key || /[\s\x00-\x1f\x7f]/u.test(key)) fail('Invalid key file format: provide exactly one API key.');
  await new Promise((accept, reject) => {
    let socket;
    let phase = 'connecting';
    let done = false;
    let timer;
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (error) socket?.terminate(); else socket?.close(1000); } catch {}
      if (error) reject(new SafeError(error)); else accept();
    }
    timer = setTimeout(() => finish(phase === 'closing' ? 'Authenticated, but no normal session.closed response was received; the check is incomplete.' : 'Doubao connection or session creation timed out; no automatic retry was made.'), 15_000);
    try {
      socket = new WebSocket('wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', { headers: { 'X-Api-Key': key } });
      key = undefined;
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => {
        if (done) return;
        try {
          socket.send(JSON.stringify({ type: 'session.create', session: {
            model: '1.2.6.1', instructions: 'This is a silent connection check. Do not speak.',
            audio: { input: { format: { type: 'pcm', rate: 16000 } }, output: { format: { type: 'pcm_s16le', rate: 24000 }, voice } },
            tools: [],
          } }));
          phase = 'creating';
        } catch { finish('Cannot send the Doubao session creation request.'); }
      });
      socket.addEventListener('message', event => {
        if (done) return;
        let payload;
        try { payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')); }
        catch { finish('Doubao returned an unreadable protocol message.'); return; }
        if (payload?.type === 'error' || payload?.error) { finish('Doubao rejected authentication or the session request. Check the key, service permissions, and voice. No automatic retry was made.'); return; }
        if (payload?.type === 'session.created' && phase === 'creating') {
          try {
            socket.send(JSON.stringify({ type: 'input_audio_mute.commit' }));
            socket.send(JSON.stringify({ type: 'session.close' }));
            phase = 'closing';
          } catch { finish('Doubao created the session, but the mute or close request failed.'); }
        } else if (payload?.type === 'session.closed') {
          if (phase === 'closing') finish();
          else finish('Doubao closed the session before the check completed.');
        }
      });
      socket.addEventListener('error', () => finish('Doubao WebSocket connection failed. Check authentication or the network; no automatic retry was made.'));
      socket.addEventListener('close', () => { if (!done) finish('Doubao disconnected before confirming a normal session close.'); });
    } catch { key = undefined; finish('Cannot establish the Doubao WebSocket connection.'); }
  });
}

let action = ['status', 'build-status', 'switch', 'restore', 'check', '--help', '-h'].includes(process.argv[2]) ? process.argv[2] : 'status';
let result;
try {
  const opts = options();
  action = opts.action;
  CUSTOM = runtimePath();
  assertScope();
  let inputKey = opts.keyStdin ? await readStdinKey() : undefined;
  if (action === 'help' || action === 'build-status') {
    result = { ok: true, action, version: VERSION, switchTimeoutMs: SWITCH_TIMEOUT_MS, provider: 'codex', installed: false, customBinaryExists: await executable(CUSTOM), canAutoBuild, build: await readBuild(DATA),
      keyFile: '', voice: DEFAULT_VOICE, hasKeyFile: false, entry: ENTRY,
      originalTarget: null, restartRequired: false, message: action === 'help' ? HELP : 'Runtime build progress retrieved.' };
  } else if (action === 'switch' || action === 'restore') result = await mutate(opts, inputKey);
  else {
    result = await snapshot(action);
    if (action === 'check') {
      await checkConnection(result.keyFile, opts.voice ?? result.voice, inputKey);
      result.ok = true;
      delete result.error;
      result.message = 'Connection successful; no microphone was started and no draft was saved.';
    }
  }
  inputKey = undefined;
} catch (error) {
  const message = error instanceof SafeError ? error.message : 'Operation failed; underlying exceptions and service responses are withheld to protect privacy.';
  try { result = await snapshot(action); } catch {}
  result = { ok: false, action, provider: 'codex', installed: false, customBinaryExists: false, canAutoBuild, build: await readBuild(DATA),
    keyFile: '', voice: DEFAULT_VOICE, hasKeyFile: false, entry: ENTRY,
    originalTarget: null, restartRequired: false, ...result, ok: false, action, version: VERSION, switchTimeoutMs: SWITCH_TIMEOUT_MS, message, error: message };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;

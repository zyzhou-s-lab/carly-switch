# carly-switch

Switch Carly's native realtime voice between Doubao and OpenAI from a compact [Tern](https://stencil.so/tern) panel.

Install on the Mac running Tern:

```sh
tern plugin install github.com/zyzhou-s-lab/carly-switch
```

The repository is currently private, so installation requires GitHub access to it.

After installation, the first **Save and apply** automatically fetches, patches, builds, and installs the compatible OMP runtime. Once that succeeds, restart Tern and use the selected voice backend. Merely opening the panel does not download or build anything.

## Requirements

- macOS and Tern with native plugin blocks and process stdin support.
- Bun 1.4 or newer, available at `~/.bun/bin/bun`, a standard Homebrew location, or on Tern's `PATH`.
- **The locally installed, Tern-managed OMP must be exactly v18.10.3.** Other versions are rejected before building or applying settings. The included [native Doubao patch](patches/omp-native-doubao.patch) adds these settings:
  - `live.provider`, with `codex` and `doubao` values
  - `live.doubao.apiKeyFile`
  - `live.doubao.voice`
- An existing `~/.local/bin/omp` symlink to an official version managed under `~/Library/Application Support/Tern/omp/versions`.
- The default OMP configuration directory, `~/.omp/agent`. Non-default profiles and agent directories are not supported.
- For Doubao: an API key with access to the end-to-end realtime voice service. A text-model API key is not a substitute.
- For OpenAI voice: the ChatGPT/Codex sign-in required by the supplied OMP runtime.
- Git and network access to GitHub, the pinned source checkout's package registries, and Rust toolchain downloads for a cold native build. Build tools must be available to the plugin process, not only an interactive shell.
- A matching v18.10.3 native addon. Without one, install Rustup/Cargo, CMake, and the Xcode Command Line Tools first; macOS `codesign` is required for the executable build. The cold build downloads the source-pinned Rust toolchain into private staging and compiles the native addon. It does not modify the user's Rustup/Cargo configuration. See the pinned [native build runbook](https://github.com/can1357/oh-my-pi/blob/v18.10.3/docs/natives-build-release-debugging.md).

## Automatic runtime build

Tern has no manifest install/postinstall script hook: its [installer](https://docs.stencil.so/tern/guides/distribution.html) copies the package and reloads plugins, and the [manifest schema](https://docs.stencil.so/tern/reference/manifest.html) rejects unknown fields. Carly Switch therefore starts the build asynchronously on the first **Save and apply**, after the activation confirmation. The panel stays responsive and displays the current stage, elapsed time, and private log path.

The builder verifies the original Tern-managed executable's version, fetches the pinned v18.10.3 source, checks and applies the included patch, installs locked dependencies, prepares the native addon, and compiles OMP. It validates the candidate in an isolated configuration before installing it at `~/.local/share/carly-switch/omp`. It never runs `bun setup` or rewrites the official executable.

Repeated saves reuse a verified build whose source version, patch, platform, architecture, and binary integrity still match. A matching native addon can be reused; otherwise the native build runs from source. A validation run with fresh source/dependency downloads and a reusable native addon took about six minutes; cached reuse took about five seconds. Slow downloads or a cold native build can take substantially longer. Progress reports the actual elapsed time rather than an estimated percentage.

The previous runtime is retained until activation completes. A failed build or activation rolls back the changes owned by that operation; concurrent third-party changes are not overwritten. Recovery records are retained if a rollback cannot safely finish. After activation commits, cleanup problems are reported as warnings, with remaining artifacts retained; a successful switch is not reported as failed merely because cleanup is incomplete. **Restore official OMP** remains available independently of the build version gate. Logs contain controlled build stages and command outcomes, not API keys or unfiltered subprocess output.

`CARLY_SWITCH_OMP` remains an optional path to a manually supplied compatible runtime. Automatic builds only manage the default path above; a missing override is reported rather than overwritten or silently replaced. The variable must reach the process running the plugin.

## Manual build and patch tests (v18.10.3)

This repository includes `patches/omp-native-doubao.patch`, targeting [OMP v18.10.3](https://github.com/can1357/oh-my-pi/tree/v18.10.3), commit `81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b`. Do not assume that it applies to other releases. The patch adds the Doubao transport while retaining Carly's native live RPC interface and the OpenAI voice implementation.

**Only source and the patch are included, not a compiled OMP binary or a source tarball.** The automatic flow performs the build locally. The commands below are for manual builds and running the patch's regression tests.

### Get the source and apply the patch

The example uses sibling `carly-switch` and `omp-v18.10.3` checkouts. If you already have this repository, use its existing path instead of cloning it again.

```sh
git clone https://github.com/zyzhou-s-lab/carly-switch.git
git clone --branch v18.10.3 --depth 1 https://github.com/can1357/oh-my-pi.git omp-v18.10.3
cd omp-v18.10.3
git apply --check ../carly-switch/patches/omp-native-doubao.patch
git apply ../carly-switch/patches/omp-native-doubao.patch
```

Stop if the patch check fails; do not force it onto a different checkout or continue with an unpatched build.

### Build the executable

Build on the macOS architecture that will run Tern. In addition to Git and Bun, install the Rust/Cargo and macOS native build prerequisites required by the pinned checkout; see OMP's [v18.10.3 native build runbook](https://github.com/can1357/oh-my-pi/blob/v18.10.3/docs/natives-build-release-debugging.md). Run from the patched OMP checkout root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build:native
bun --cwd=packages/coding-agent run build
```

`build:native` produces the local Rust/N-API addon. The CLI build generates its required UI assets and writes `packages/coding-agent/dist/omp`. These commands deliberately avoid `bun setup`, which also links the development CLI into the global command path.

### Run the patch tests

After the build, run from the same patched OMP checkout root:

```sh
bun --cwd=packages/coding-agent run check:types
bun --cwd=packages/coding-agent test \
  test/live/controller.test.ts \
  test/live/doubao-protocol.test.ts \
  test/live/doubao-transport.test.ts \
  test/live/protocol.test.ts \
  test/rpc-live.test.ts \
  test/modes/controllers/live-command-controller.test.ts \
  test/config/settings-registry.test.ts
```

The patch includes protocol, transcript, delegation, and transport lifecycle regression tests, and updates existing live RPC tests. This targeted suite uses synthetic credentials and substituted audio/network boundaries; it does not require a real API key or open a microphone. It is not a live service or audio-device verification.

### Put the runtime where the plugin can find it

For an initial installation, run from the patched OMP checkout root:

```sh
mkdir -p "$HOME/.local/share/carly-switch"
install -m 755 packages/coding-agent/dist/omp "$HOME/.local/share/carly-switch/omp"
"$HOME/.local/share/carly-switch/omp" --version
```

Alternatively, keep the built executable elsewhere and set `CARLY_SWITCH_OMP` to its absolute path or a `~/` path before starting Tern. The variable must reach the process running the plugin; exporting it only inside an already-running pane is not sufficient. Stop voice sessions and use **Restore official OMP** before replacing an active custom runtime. Placing the executable does not switch the official launcher by itself; use **Save and apply** in the plugin when ready.

## Use

Open **Carly Switch: Voice Settings** from Tern's command palette, or run:

```sh
tern ctl plugins run plugin.carly-switch.open-panel
```

1. Select **Doubao** or **OpenAI**.
2. For Doubao, enter an API key and choose a voice. Leave the key field empty to keep the configured key. Existing custom voice IDs are preserved.
3. Select **Save and apply**. If needed, the runtime is built automatically first. The first activation backs up the original launcher target and the three voice settings before switching the launcher to the compatible runtime.
4. Restart Tern after the first launcher change. Later backend and voice changes apply when you close and reopen the voice session. Existing conversations are not terminated.

**Test connection** uses the current Doubao draft without saving it. It creates and closes a real service session without opening the microphone or playing audio; service usage may still apply.

API keys are masked in the panel and sent to the helper through stdin, not command-line arguments. New keys are stored in private `0600` files inside the plugin's `0700` data directory. Keys are not returned in status output or written into backup metadata. The original external key file is not overwritten.

**OpenAI** selects the original OpenAI/Codex voice implementation inside the same compatible runtime. To return to the captured official executable instead, use **More → Restore official OMP**, then restart Tern. Restore also reinstates the previous voice settings; it does not delete saved key files or personal data.

The helper is available for automation:

```sh
bun helper.mjs --help
```

## Limits

- This is a configuration and launcher switcher, not a new voice backend or a replacement assistant window. Audio, transcription, interruptions, and task execution remain the supplied runtime's responsibility.
- Only local macOS sessions, the default OMP profile, and the existing Tern-managed launcher layout are supported. Regular-file launchers and unknown third-party targets are refused.
- Settings are written to the default global configuration. Project overrides can still take precedence.
- Official updates or another switcher may change the launcher or voice settings. The plugin detects conflicts and refuses to overwrite them. Do not operate multiple launcher-switching plugins at the same time.
- Keep the configured runtime path stable while the switcher is active. Restore official OMP before moving that executable or changing `CARLY_SWITCH_OMP`.
- An already-running Carly process keeps its loaded executable. Changing the launcher does not hot-swap that process.
- The plugin does not open the microphone automatically. A successful connection check confirms service access, not a complete audio-device or voice-quality test.
- Previously saved private key files are retained. Restore does not revoke an API key or remove those files.

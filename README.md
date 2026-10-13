# carly-switch

Switch Carly's native realtime voice between Doubao and OpenAI from a compact [Tern](https://stencil.so/tern) panel.

Install on the Mac running Tern:

```sh
tern plugin install github.com/cangiolo/carly-switch
```

The repository is currently private, so installation requires GitHub access to it.

## Requirements

- macOS and Tern with native plugin blocks and process stdin support.
- Bun 1.4 or newer, available at `~/.bun/bin/bun`, a standard Homebrew location, or on Tern's `PATH`.
- **A separately supplied compatible OMP executable.** It must support native live voice RPC and these settings:
  - `live.provider`, with `codex` and `doubao` values
  - `live.doubao.apiKeyFile`
  - `live.doubao.voice`
- An existing `~/.local/bin/omp` symlink to an official version managed under `~/Library/Application Support/Tern/omp/versions`.
- The default OMP configuration directory, `~/.omp/agent`. Non-default profiles and agent directories are not supported.
- For Doubao: an API key with access to the end-to-end realtime voice service. A text-model API key is not a substitute.
- For OpenAI voice: the ChatGPT/Codex sign-in required by the supplied OMP runtime.

Place the compatible executable at `~/.local/share/carly-switch/omp`, or set `CARLY_SWITCH_OMP` to its absolute path or a `~/` path before starting Tern. The variable must be available to the process running the plugin; exporting it only inside an already-running terminal pane is not sufficient. The default path avoids that environment setup.

**This is a source-only plugin.** It does not bundle, download, build, or patch OMP. Installing it does not add Doubao support to a stock OMP executable. Supply the compatible runtime before applying a backend change.

## Use

Open **Carly Switch: Voice Settings** from Tern's command palette, or run:

```sh
tern ctl plugins run plugin.carly-switch.open-panel
```

1. Select **Doubao** or **OpenAI**.
2. For Doubao, enter an API key and choose a voice. Leave the key field empty to keep the configured key. Existing custom voice IDs are preserved.
3. Select **Save and apply**. The first activation backs up the original launcher target and the three voice settings before switching the launcher to the supplied runtime.
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

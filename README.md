# Forge Neo generation progress

`@local/forge-neo-progress` is a DeepSeek Harness bundle that surfaces live
[Forge Neo](https://github.com/lllyasviel/stable-diffusion-webui-forge) generation
progress inside the Web GUI.

## What it does

- The **host half** (`index.js`) registers one same-origin JSON route on the
  Harness web server (default path `/forge-progress`) that proxies Forge Neo's
  `GET /sdapi/v1/progress` and returns a normalized payload.
- The **client half** (`client.js`) polls that route and renders an ambient status
  bar in the composer dock (`conversation.composer.dock`): a status dot and label,
  a progress bar (percent, or an indeterminate animation while the model is
  preparing), a step counter, a remaining-time estimate, and an optional thumbnail
  of the in-progress image.

Because progress is read through the Harness web server, the browser needs neither
direct network reachability to Forge nor CORS.

## Install

Copy this directory somewhere stable on the machine that runs the Harness host
(local installation links the directory, so keep it in place), then in the Web
GUI open **Plugins** → **Add plugin** and point it at the directory. No
dependencies, no build step. Reload the page once so the client half loads.

## Configuration

The bundled patch ships no deployment-specific values, so publishing this
package leaks no personal Forge URL. Every field falls back to the default
below. Set values per deployment either on the plugin's row in Plugin Manager,
or as an override in your own profile patch — user patches apply **after** every
bundle layer, so they win. An override replaces the row's complete config;
omitted fields keep their defaults.

```yaml
# your profile cordis.patch.yml
- insert:
    - id: forge-neo-progress
      name: '@local/forge-neo-progress'
      config:
        forgeUrl: http://your-forge-host:7865
```

| Field | Default | Meaning |
| --- | --- | --- |
| `forgeUrl` | `http://127.0.0.1:7865` | Forge API base reachable **from the Harness host** |
| `path` | `/forge-progress` | Exact route path registered on the Harness web server |
| `timeoutMs` | `4000` | Upstream progress fetch timeout |
| `cacheMs` | `700` | Short-lived response reuse for many tabs / fast polling |
| `includeImage` | `true` | Forward the `current_image` preview to the client |
| `auth` | `""` | Optional `user:password` if Forge uses `--api-auth` |
| `idleIntervalMs` | `10000` | Client poll interval while idle |
| `activeIntervalMs` | `2000` | Client poll interval while generating |

## Notes and limits

- Progress is a single global Forge signal; the bar is shown in the composer dock
  of the active session.
- The remaining-time estimate can be unreliable during model loading and early
  sampling, so the bar shows an indeterminate animation instead of a percent then.
- If Forge is unreachable the bar reports it quietly and retries at a low rate; the
  host logs each new failure signature once.

## Locale

Display metadata ships for English, Japanese, and Chinese (`locale/*.json`). The
bar's own UI strings are registered at runtime under the `forge-progress` client
namespace (en / zh / ja) and follow the GUI language switch.

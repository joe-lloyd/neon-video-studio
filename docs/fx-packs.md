# FX packs — install, enable and author animated components

Every overlay in Neon Video Studio is a React component rendered by Remotion. An **FX pack** is a
folder of such components plus a `pack.json` manifest that describes them as plain data. Because
the manifest is data, every process (app, CLI, render worker) can register a pack's templates —
inspector controls, prop validation, JSON Schema for agents — without executing its code.

```
my-pack/
├── pack.json      # identity + every template's fields (pure data, validated on load)
├── index.tsx      # exports one React component per template name
└── …              # anything else the components import, by relative path
```

Two kinds of packs exist:

| Kind | Where it lives | Availability |
|---|---|---|
| **Built-in** (`core`, `neon-essentials`) | inside the app bundle | always, in every project |
| **Installed** | `~/.neon-video/packs/<name>/` | listed in the Library; enabled per project |

> **Security.** A pack is arbitrary code. It runs inside the app's renderer and inside the headless
> browser that renders your exports, with whatever access those processes have. Only install packs
> you trust — treat a pack folder like you would treat an npm dependency or a browser extension.

## Installing a pack

In the app open the **FX** panel and switch to the **Library** sub-tab.

- **Install folder…** — pick the pack folder (the one that contains `pack.json`). The app validates
  the manifest, copies the folder to `~/.neon-video/packs/<name>/` and compiles the components.
- **Drag and drop** — drop a pack folder from Finder/Explorer onto the Library.
- **Examples** — when the app runs from a source checkout (`pnpm dev`), every pack under
  `examples/packs/` is listed in an *Examples* section with a one-click **Install**.

**Uninstall** from the same place (the pack card's menu). Uninstalling removes the folder from
`~/.neon-video/packs`; projects that still list the pack keep working once it is installed again.

Installed packs are discovered on start-up by scanning `~/.neon-video/packs` (override the home
folder with `NEON_HOME`). A folder whose `pack.json` fails validation, or whose template names clash
with an already-registered pack, is shown in the Library with the error instead of being loaded.

## Enabling a pack in a project

Built-in packs are always available. Installed packs are opt-in per project so an export knows
exactly which packs it needs:

- In the **Library**, click **Add to project** on a pack card, or drag the card onto the project
  area. The pack name is stored in the project (`meta.packs`) and travels with the project folder.
- Remove it the same way. Clips that still reference a template from a removed pack render as a
  placeholder until the pack is enabled again.

The **Components** sub-tab of the FX panel shows every template from built-in *and* enabled packs,
grouped by category and searchable. Each card is a rendered thumbnail that animates on hover.
**Click** adds the component at the playhead on the selected FX track; **drag** drops it onto any
FX track at the position you choose.

## Authoring a pack

### `pack.json` reference

| Field | Type | Notes |
|---|---|---|
| `name` | string | **Required.** Unique id, kebab-case (`^[a-z][a-z0-9-]*$`), must equal the folder name. |
| `label` | string | **Required.** Display name in the Library. |
| `version` | string | **Required.** Semver recommended; shown in the Library and used to detect updates. |
| `description` | string | Shown on the pack card. |
| `author` | string | Shown on the pack card. |
| `category` | string | Default category for templates that do not set their own. |
| `tags` | string[] | Free-form keywords used by the Library search. |
| `entry` | string | Module (relative to the pack folder) exporting the components. Default `index.tsx`. Must be `.tsx`, `.ts`, `.jsx` or `.js`. |
| `templates` | TemplateMeta[] | **Required.** At least one template (see below). |

Each entry in `templates`:

| Field | Type | Notes |
|---|---|---|
| `name` | string | **Required.** PascalCase identifier (`^[A-Z][A-Za-z0-9]*$`). Also the component export name and the `--component` value in the CLI. Must be unique across all registered packs. |
| `label` | string | **Required.** Display name on the component card. |
| `description` | string | One-liner shown on the card and in `neon-cli list templates`. |
| `defaultDurationSeconds` | number | **Required.** Clip length when added (> 0). |
| `fields` | TemplateField[] | **Required.** Props the user can edit (may be empty). Drives the inspector, validation and JSON Schema. |
| `category` | string | Group in the Components tab (e.g. `Titles`, `Lower thirds`, `Badges`). Falls back to the pack `category`. |
| `tags` | string[] | Extra search keywords. |
| `icon` | string | Icon name from `@neon/icon-kit` (Lucide names such as `Type`, `Tag`, `Loader2`). |
| `previewProps` | object | Prop overrides used only for the thumbnail (e.g. a shorter text). |

Template fields (`fields[]`). Every field has `key` (identifier, becomes the prop name), optional
`label` and `description`, a `type` and a `default` of the matching type:

| `type` | `default` | Extra options | Inspector control |
|---|---|---|---|
| `text` | string | `multiline?: boolean` | text input / textarea |
| `number` | number | `min?`, `max?`, `step?` | number input with range validation |
| `color` | string | — | color picker (any CSS color string) |
| `boolean` | boolean | — | toggle |
| `select` | string | `options: string[]` (≥ 1; `default` must be one of them) | dropdown |

A complete example, excerpted from the shipped `examples/packs/boba-expressive/pack.json`:

```json
{
  "name": "boba-expressive",
  "label": "Boba Expressive",
  "version": "1.0.0",
  "description": "An M3-Expressive-inspired FX set: violet/lavender tonal palette, pills that square up on exit, organic blobs, overshoot easings, and matte flatness (no glows or shadows).",
  "author": "Joe Lloyd",
  "category": "Expressive",
  "tags": ["m3", "expressive", "blob", "pill"],
  "entry": "index.tsx",
  "templates": [
    {
      "name": "BobaTag",
      "label": "Boba Tag",
      "description": "Matte pill tag with the circle-to-pill clip reveal. Flat by design — no glow.",
      "defaultDurationSeconds": 4,
      "category": "Badges",
      "icon": "Tag",
      "fields": [
        { "key": "text", "type": "text", "default": "New" },
        { "key": "color", "type": "color", "default": "#deb8f7" },
        { "key": "textColor", "type": "color", "default": "#402357" },
        { "key": "size", "type": "number", "default": 40, "min": 12, "max": 160 },
        { "key": "corner", "type": "select", "default": "top-right", "options": ["top-left", "top-right", "bottom-left", "bottom-right"] }
      ]
    },
    {
      "name": "BobaMorphLoader",
      "label": "Boba Morph Loader",
      "description": "Brand-mark loader: a blob morphing through a shape sequence with rotation snaps.",
      "defaultDurationSeconds": 5,
      "category": "Loaders",
      "icon": "Loader2",
      "fields": [
        { "key": "color", "type": "color", "default": "#deb8f7" },
        { "key": "size", "type": "number", "default": 220, "min": 40, "max": 800 },
        { "key": "stepSeconds", "type": "number", "default": 1, "min": 0.5, "max": 3, "step": 0.1 }
      ]
    }
  ]
}
```

The manifest is validated with `parsePackManifest()` from `@neon/core` (zod). You can check a
manifest from the repo root without starting the app:

```bash
node --experimental-strip-types --no-warnings -e \
  "import('./packages/core/src/packs.ts').then(m => { m.parsePackManifest(JSON.parse(require('fs').readFileSync('examples/packs/boba-expressive/pack.json','utf8'))); console.log('manifest ok') })"
```

### `index.tsx` — the export contract

The entry module must export **one named React component per template `name`**, and the export
name must equal the template name exactly:

```tsx
// index.tsx
export { BobaTitle } from './BobaTitle.tsx';
export { BobaLowerThird } from './BobaLowerThird.tsx';
export { BobaTag } from './BobaTag.tsx';
export { BobaBlob } from './BobaBlob.tsx';
export { BobaMorphLoader } from './BobaMorphLoader.tsx';
```

Each component receives the template's fields as props, already validated and filled with defaults
(`{ text: string; color: string; size: number; corner: string; … }` for the `BobaTag` above).
`select` fields arrive as `string`; narrow them yourself if you need a union. A template listed in
`pack.json` but missing from the entry module is reported in the Library and renders a placeholder.

Relative imports inside a pack carry their extension (`./tokens.ts`, `./BobaTag.tsx`), matching the
rest of the repo.

### Allowed imports

Installed packs are compiled by the app, and the host provides exactly these modules at runtime:

| Import | What you get |
|---|---|
| `react` | React 19 |
| `remotion` | `AbsoluteFill`, `useCurrentFrame`, `useVideoConfig`, `interpolate`, `spring`, `Easing`, `Sequence`, … |
| `@neon/core` | Types such as `TemplatePackMeta`, `parseTimecode()` and other pure helpers |
| `@neon/fx-kit` | The pack-author helper kit (below) |
| relative files | anything inside the pack folder |

**No other npm dependencies are available to installed packs.** There is no `node_modules` in
`~/.neon-video/packs/<name>/`, so an `import 'd3'` fails at compile time. If you need a library,
vendor the code you use into the pack folder as a relative file, or build the pack as a built-in
inside `apps/remotion-workspace` where the workspace's dependencies are available.

### `@neon/fx-kit` helpers

`@neon/fx-kit` is the stable import surface for pack authors and is kept small and additive:

| Export | Purpose |
|---|---|
| `useUiScale()` | `height / 1080` of the current composition — multiply every pixel value by it. |
| `SANS`, `MONO` | Font stacks matching the app (`Inter…`, `JetBrains Mono…`). |
| `glow(color, strength = 1)` | Triple-layer neon glow string for `boxShadow` / `textShadow`. |
| `clamp(value, min, max)` | Clamp a number. |

### Rules of the road

- **Author at 1080p, scale with `useUiScale()`.** Write sizes as if the canvas were 1920×1080 and
  multiply by `s = useUiScale()` (`fontSize: 44 * s`, `padding: 90 * s`). The same component then
  renders correctly for the draft preset, 4K, vertical and square outputs.
- **Be deterministic.** Preview frames and exported frames are rendered in different processes and
  must be pixel-identical. Never call `Math.random()`, `Date.now()`, `performance.now()` or read
  external state at render time. Derive *everything* from `useCurrentFrame()` and
  `useVideoConfig()`; if you need pseudo-randomness, hash the frame number or a prop.
- **Animate exits from `durationInFrames`.** The user sets the clip length on the timeline, so an
  exit that starts at a hard-coded frame is wrong for every other duration. Read
  `const { fps, durationInFrames } = useVideoConfig()` and anchor the exit to the end:

  ```tsx
  const out = interpolate(frame, [durationInFrames - fps * 0.3, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  ```

  Always pass `extrapolateLeft`/`extrapolateRight: 'clamp'` to `interpolate()` so values stay in
  range when a clip is trimmed shorter than your animation.
- **Fill the frame with `AbsoluteFill`** and position within it; the clip's own transform (move,
  scale) is applied by the host on top of your component.
- **Keep the entry side-effect free.** The app may evaluate the module in a worker to build
  thumbnails; do not touch `window`, `document` or timers at module scope.
- **Pure `pack.json`.** Template names, field keys and defaults are read by the CLI without running
  your code — keep the manifest in sync with the props your components actually accept.

## Developing a pack inside this repo

`examples/packs/boba-expressive` is a complete, working pack and the intended starting point:

1. Copy it: `cp -r examples/packs/boba-expressive examples/packs/my-pack`, then edit `pack.json`
   (`name` must be `my-pack`) and `package.json` (`"name": "@neon-packs/my-pack"`).
2. It is a **workspace package** (`pnpm-workspace.yaml` includes `examples/packs/*`), so after
   `pnpm install --ignore-scripts` the repo-wide `pnpm typecheck` covers it, and
   `pnpm --filter @neon-packs/my-pack typecheck` checks it alone. The `tsconfig.json` extends the
   repo base (`erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `.ts`/`.tsx` import extensions).
3. Start the app with `pnpm dev`, open **FX → Library**, and install the pack from the **Examples**
   section.
4. Edit the components. Click **Reload** on the pack card in the Library to recompile and refresh
   the thumbnails — no app restart needed.
5. Validate the manifest with the `node --experimental-strip-types …` one-liner above, or just
   watch the Library card: a broken `pack.json` is shown with its first validation errors.

The example pack's `package.json` lists `react`, `remotion`, `@neon/core` and `@neon/fx-kit` as
dev dependencies purely for type-checking; the app never installs them for the pack. Do not add
other dependencies — they would type-check in the repo but fail once the pack is installed.

## CLI

Template names from every registered pack are ordinary `--component` values:

```bash
neon-cli list templates                 # name, label, default duration, description; pack/category included
neon-cli list templates --json          # includes the JSON Schema of every template's props (for agents)
neon-cli templates BobaTitle            # defaults + JSON Schema for one template
```

Installed packs are discovered from `~/.neon-video/packs` by the CLI as well, so it can validate
props for any installed template. Inserting a clip from an installed pack works once that pack is
**enabled in the project** (see above); built-in packs need no enabling:

```bash
# built-in: neon-essentials
neon-cli timeline insert --component NeonBadge --props '{"text":"50% OFF","corner":"top-left"}' --at 2s
neon-cli timeline insert --component KineticList --props '{"title":"Agenda","items":"One\nTwo\nThree"}' --at 4s --duration 8s

# installed example pack: boba-expressive (enable it in the project first)
neon-cli timeline insert --component BobaTitle --props '{"title":"Make it expressive"}' --at 0s
neon-cli timeline insert --component BobaMorphLoader --props '{"color":"#deb8f7"}' --at 5s
```

## Ships with

**core** (built-in): `TextOverlay`, `LowerThird`, `TitleCard`, `Countdown`, `ProgressBar`,
`Watermark`, `SolidColor`.

**neon-essentials** (built-in): `NeonBadge` (animated pill badge) and `KineticList` (staggered
bullet points) — small, readable components that make good copy-paste starting points. Source:
`apps/remotion-workspace/src/templates/packs/neon-essentials/`.

**boba-expressive** (example pack, `examples/packs/boba-expressive/`): an M3-Expressive-inspired
set — violet/lavender tonal palette, matte flatness (no glows), pills that square to 12px on exit,
organic blob shapes and overshoot-and-settle easings. `BobaTitle` (word-stagger display title),
`BobaLowerThird` (frosted pill with center-out reveal), `BobaTag` (circle-to-pill clip reveal),
`BobaBlob` (spinning organic shape), `BobaMorphLoader` (blob morphing through a shape sequence with
60° rotation snaps). Shared tokens — palette, easings, blob geometry — live in `tokens.ts` and show
how a pack keeps its own design system in a relative file.

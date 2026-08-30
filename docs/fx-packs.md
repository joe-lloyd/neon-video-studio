# FX packs — build your own animated components

Every overlay in Neon Video Studio is a React component rendered by Remotion, so an "effect" is
just a component you can write, style, and animate — and because the workspace is a normal npm
package you can **install any React library** and use it inside a pack.

## Anatomy of a pack

```
apps/remotion-workspace/src/templates/packs/
└── my-pack/
    ├── meta.ts          # pure TS: name, label, fields (drives inspector + CLI + validation)
    └── MyThing.tsx      # the React component (may import npm libraries)
```

1. **`meta.ts`** — describe each template with plain fields (no zod needed):

```ts
import type { TemplatePackMeta } from '@neon/core';

export const MY_PACK_META: TemplatePackMeta[] = [
  {
    name: 'MyThing',                    // unique — also the component key
    label: 'My Thing',
    description: 'What it does',
    defaultDurationSeconds: 4,
    fields: [
      { key: 'text',  type: 'text',   default: 'Hello' },
      { key: 'size',  type: 'number', default: 64, min: 8, max: 300 },
      { key: 'color', type: 'color',  default: '#FF007F' },
      { key: 'side',  type: 'select', default: 'left', options: ['left', 'right'] },
      { key: 'pulse', type: 'boolean', default: true },
    ],
  },
];
```

Field types: `text` (optionally `multiline`), `number` (`min`/`max`/`step`), `color`, `select`
(`options`), `boolean`. The field spec is converted to a zod schema automatically — it powers the
inspector controls, `neon-cli list templates --json` (JSON Schema for agents), and prop validation
everywhere.

2. **`MyThing.tsx`** — a Remotion component. Useful helpers from `../../shared.ts`:
`useUiScale()` (author for 1080p, scales to any output), `glow(color)`, `MONO`, `SANS`.
Remotion gives you `useCurrentFrame()`, `useVideoConfig()`, `spring()`, `interpolate()`.

3. **Register it** in two central files:

```ts
// packs/meta.ts        (pure TS — used by the app, CLI and render worker)
registerTemplatePack('my-pack', MY_PACK_META);

// packs/components.ts  (React side)
export const PACK_COMPONENTS = { ..., MyThing: MyThing as unknown as TemplateComponent };
```

That's it. The template appears in the **FX** panel, validates props in the inspector and CLI,
previews live, and renders in exports — no other wiring.

## Using npm libraries

`cd apps/remotion-workspace && pnpm add <lib>` and import it in your component. Anything that
renders deterministically from props + `useCurrentFrame()` works (charts, confetti, icon sets,
Lottie via @remotion/lottie, three.js via @remotion/three…). Avoid `Math.random()`/`Date.now()` at
render time — derive everything from the current frame so preview and export stay identical.

## Ships with

**neon-essentials**: `NeonBadge` (animated pill badge) and `KineticList` (staggered bullet
points). Use them as copy-paste starting points:

```bash
neon-cli timeline insert --component NeonBadge --props '{"text":"50% OFF","corner":"top-left"}' --at 2s
neon-cli timeline insert --component KineticList --props '{"title":"Agenda","items":"One\nTwo\nThree"}' --at 4s --duration 8s
```

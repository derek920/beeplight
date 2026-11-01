# Packs

Themes, presets, characters and agent marks are data, not code. Each comes in a pack: one JSON file that the
Mac app, the web page and the iPhone app can all read. Adding a theme, a preset or a character is
an edit to a pack file; no app code changes.

The built-in packs are in `public/`:

| File | Kind | What it holds |
|---|---|---|
| `themes.json` | `themes` | Colors and finish of the board, the menu bar panel and the island |
| `presets.json` | `presets` | A theme, a menu bar style, the island and motion picked together |
| `characters.json` | `characters` | The idle face: line drawings and text art |
| `agents.json` | `agents` | The mark before each task's title, one per coding agent |

Rules that hold for every pack:

- **Data only.** A pack never contains code. The apps draw everything themselves; a pack only picks
  and tunes what they know how to draw.
- **Official packs only.** There is no folder for user or third-party packs. A pack that does not
  ship inside an app must carry an official signature (see [Signed packs](#signed-packs)).
- **Lenient decoding.** Unknown fields are ignored and new fields are optional, so an older app
  reads a newer pack of the same `format`. Items decode one by one: a bad item is skipped and the
  rest of the file still works. When the theme or character a person picked is gone, only that
  choice falls back to the default (`native`, the robot eyes); their other settings stay.

`test/packs.test.js` checks the built-in packs against the rules the apps decode with. Run
`npm test` after editing one.

## File

```json
{
  "format": 1,
  "id": "beeplight.themes",
  "kind": "themes",
  "themes": [ … ]
}
```

- `format`: bumped only for a change older apps cannot read; they skip a file with a newer format.
- `id`: the pack's own id. Built-in packs start with `beeplight.`.
- `kind`: `themes`, `presets`, `characters`, `agents` or `pools`. The items are in the field of the same name.
- `_about` (optional): a note for people editing the file.

## Fields every item has

| Field | | |
|---|---|---|
| `id` | required | Lowercase letters, digits and `-`, starting with a letter, at most 32 characters. Unique within its kind. |
| `name` | required | `{ "en": …, "zh-Hans": … }`. Apps show their own language and fall back to English. |
| `requires` | optional | The entitlement that unlocks the item. Absent means free. Built-in items never have it. |
| `rarity` | optional | For paid characters: how rare it is, e.g. `common`, `rare`, `epic`, `legendary`. |
| `series` | optional | For paid characters: the series it belongs to. |

## Themes

```json
{
  "id": "neon",
  "name": { "en": "Neon", "zh-Hans": "赛博霓虹" },
  "scheme": "dark",
  "font": "rounded",
  "corner": 14,
  "glow": 10,
  "colors": { "waiting": "#FFB020", "doing": "#00E5FF", "column": "#120F24@0.75", … },
  "effects": []
}
```

| Field | Default | |
|---|---|---|
| `scheme` | `system` | `system` follows light or dark; `light` and `dark` fix it. |
| `font` | `default` | `default`, `rounded`, `monospaced` or `serif`. |
| `corner` | `12` | Corner radius of cards, in points. |
| `glow` | `0` | Glow radius around state-colored marks; `0` means none. |
| `colors` | required | See below. |
| `effects` | `[]` | Finishes the apps draw: `grid` (a backdrop grid), `scanlines` (CRT lines over everything), `brackets` (HUD corner marks on cards), `bracketLabels` (state labels as `[Running]`). Unknown ones are ignored. |
| `web` | `{}` | Colors only the web page uses; see [On the web page](#on-the-web-page). The apps ignore it. |
| `credit` | optional | Where the colors come from and under what license, for a theme built on someone else's palette (e.g. `berry`, `rose`, `latte`). The apps don't show it. |

Colors:

| Key | | |
|---|---|---|
| `waiting`, `doing`, `success`, `failed` | required | The four states. |
| `urgent` | required | A real prompt that has waited for more than 3 minutes. |
| `column` | required | Board columns. |
| `card`, `cardStroke` | required | Card fill and outline. |
| `text` | optional | Text color. Absent: the system label colors. |
| `backdrop` | optional | A solid window background. Absent: the system window material. |

A color is one of:

- `#RRGGBB`, e.g. `#00E5FF`;
- `system:<name>`, a system color that follows light and dark: `orange`, `blue`, `green`, `red`,
  `yellow`, `purple`, `pink`, `teal`, `gray`, `controlBackground`, `windowBackground`;
- `primary`, the label color;

each optionally followed by `@<opacity>` between 0 and 1, e.g. `#B14CFF@0.35`, `primary@0.07`.

### On the web page

The service puts `themes.json` and `presets.json` into the page it serves (a `<script id="packs">`
element), so the look is there before the first paint. The page's theme menu lists the presets; the
choice is stored in the browser.

- From `colors`: `waiting`, `doing`, `success`, `failed`, `text`, `backdrop` (the page background),
  `column` (panels) and `card` become the page's CSS variables. Only `#RRGGBB` colors apply: system
  colors have no CSS equivalent, so the page keeps its own light and dark defaults for those. That
  is why the native theme sets nothing here.
- `corner` sets `--radius`; `scheme` `light` or `dark` sets `color-scheme`.
- `web` holds the page's other colors, by CSS variable: `muted`, `faint` (secondary text), `line`,
  `chip`, `shadow`, `shadowHover`, and `doingSoft`, `waitingSoft`, `successSoft`, `failedSoft`
  (state colors as backgrounds). `shadow` and `shadowHover` are CSS `box-shadow` values; the rest
  are CSS colors.
- The finishes come from the same fields as in the apps: `font: monospaced`, a `glow` of 8 or more
  (color pools behind everything, glowing outlines), and the `effects`. A preset with `motion: off`
  stops the page's animations.


```json
{
  "id": "neon",
  "name": { "en": "Neon", "zh-Hans": "赛博霓虹" },
  "blurb": { "en": "Dark neon glow, radar menu bar", "zh-Hans": "暗色底、霓虹描边与发光，雷达环菜单栏" },
  "theme": "neon",
  "menuBar": "radar",
  "island": "notch",
  "motion": "full"
}
```

- `blurb`: one line under the name, in both languages.
- `theme`: a theme id.
- `menuBar`: `capsules`, `traffic`, `radar`, `energy`, `terminal` or `dot`. These are drawing code
  in the Mac app (`MenuBarBadge`), not data: a pack can only pick one.
- `island`: `off`, `notch` or `floating`.
- `motion`: `full`, `soft` or `off`.

A value the app does not know falls back to its default; a theme it does not have, to `native`.

## Characters

The fields of a line drawing or a text-art character are described in the `_about` note of
`characters.json`. Characters take the common fields above, so a paid character is an entry with
`requires`, `rarity` and `series`.

## Agent marks

`agents.json` has one mark per coding agent, drawn before task titles on the board, in the menu bar
panel, on the island and on the web page, so tasks from different agents tell apart at a glance.
An entry's `id` is the agent id the service puts on each task (`claude-code`, `codex`; a task
without one is Claude Code's). `color` follows the color rules above; `box` is `[width, height]`
and `paths` are filled SVG paths in it (M L H V C Q Z, no arcs). The built-in marks are original
shapes, not the agents' logos, which are their makers' trademarks. A new agent source needs an
entry here; `test/packs.test.js` checks that every source has one.

## Draw pools

The iPhone app's paid characters come from draws. No pool ships in this repository; the format is
here so the apps agree on it.

```json
{
  "id": "spring-2027",
  "name": { "en": "Spring", "zh-Hans": "春季" },
  "requires": "pool.spring-2027",
  "entries": [
    { "item": "fox", "odds": 0.7 },
    { "item": "owl", "odds": 0.25 },
    { "item": "dragon", "odds": 0.05 }
  ]
}
```

- `entries[].item`: a character id. `odds`: its probability; a pool's odds add up to 1.
- App Store Review Guideline 3.1.1 requires showing the odds of each item before the purchase, so
  the odds are part of the pack, and the app shows them from there.

## Purchases

Which items with `requires` a person may use is decided by an `EntitlementProvider`
(`desktop/Sources/Packs.swift`). The open-source apps have no purchases (`NoPurchases`), so items
that need one are not offered there; every built-in item is free. The iPhone app supplies its own.

## Signed packs

A pack downloaded by an app, rather than shipped inside it, comes wrapped and signed:

```json
{
  "format": 1,
  "key": "beeplight-2027",
  "pack": "<base64 of the pack file's bytes>",
  "signature": "<base64 of the Ed25519 signature over those bytes>"
}
```

The app checks the signature with the public key it has for `key` before decoding `pack`, and
discards the pack if it does not match. The signature proves the pack is official; it does not
stop someone who changes an open-source app from unlocking items. Not implemented yet: only the
iPhone app will download packs.

## Shared code

`desktop/Sources/Packs.swift` decodes packs using SwiftUI only, so the iPhone app can compile it
as it is. Turning a pack color into a platform color is each app's job; the Mac app does it in
`Themes.swift`.

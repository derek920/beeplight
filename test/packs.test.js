import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The built-in packs (docs/packs.md). The values they may use are read from the Swift sources that
// decode them, so the two cannot drift apart.

const ROOT = path.join(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pack = (name) => JSON.parse(read(`public/${name}.json`));

const swift = read('desktop/Sources/Packs.swift') + read('desktop/Sources/Appearance.swift');
const swiftSet = (re) => {
  const m = re.exec(swift);
  assert.ok(m, `not found in the Swift sources: ${re}`);
  return new Set(m[1].split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean));
};
const SYSTEM_COLORS = swiftSet(/static let systemNames: Set<String> = \[([^\]]+)\]/);
const REQUIRED_COLORS = swiftSet(/static let requiredColors = \[([^\]]+)\]/);
const FONTS = swiftSet(/static let fonts: Set<String> = \[([^\]]+)\]/);
const SCHEMES = swiftSet(/static let schemes: Set<String> = \[([^\]]+)\]/);
const EFFECTS = swiftSet(/static let knownEffects: Set<String> = \[([^\]]+)\]/);
const MENU_BAR = swiftSet(/enum MenuBarStyle: String[^{]*\{\s*case ([a-z, ]+)/);
const ISLAND = swiftSet(/enum IslandMode: String[^{]*\{\s*case ([a-z, ]+)/);
const MOTION = swiftSet(/enum Motion: String[^{]*\{\s*case ([a-z, ]+)/);

/** Same rules as PackColor.init in Packs.swift. */
function validColor(text) {
  const parts = String(text).split('@');
  if (parts.length > 2) return false;
  if (parts.length === 2 && !(Number(parts[1]) > 0 && Number(parts[1]) <= 1)) return false;
  const spec = parts[0];
  if (spec === 'primary') return true;
  if (spec.startsWith('system:')) return SYSTEM_COLORS.has(spec.slice(7));
  return /^#[0-9A-Fa-f]{6}$/.test(spec);
}

for (const kind of ['themes', 'presets', 'characters', 'agents']) {
  test(`${kind}.json is a pack whose items have ids, both languages, and need no purchase`, () => {
    const p = pack(kind);
    assert.equal(p.format, 1);
    assert.equal(p.kind, kind);
    assert.match(p.id, /^beeplight\./);
    assert.ok(Array.isArray(p[kind]) && p[kind].length > 0);
    const ids = new Set();
    for (const item of p[kind]) {
      assert.match(item.id, /^[a-z][a-z0-9-]{0,31}$/, `${kind}: bad id ${item.id}`);
      assert.ok(!ids.has(item.id), `${kind}: duplicate id ${item.id}`);
      ids.add(item.id);
      assert.ok(item.name?.en && item.name?.['zh-Hans'], `${kind}/${item.id}: name needs en and zh-Hans`);
      // Built-in items are free; paid ones belong to the iPhone app and never ship here.
      assert.equal(item.requires, undefined, `${kind}/${item.id}: built-in items must be free`);
    }
  });
}

test('every theme decodes: known scheme, font and effects, all required colors, valid color syntax', () => {
  const { themes } = pack('themes');
  assert.ok(themes.some((t) => t.id === 'native'), 'the native theme is the fallback and must exist');
  for (const t of themes) {
    assert.ok(SCHEMES.has(t.scheme ?? 'system'), `${t.id}: scheme ${t.scheme}`);
    assert.ok(FONTS.has(t.font ?? 'default'), `${t.id}: font ${t.font}`);
    for (const k of ['corner', 'glow']) assert.ok(t[k] === undefined || (typeof t[k] === 'number' && t[k] >= 0), `${t.id}: ${k}`);
    for (const c of REQUIRED_COLORS) assert.ok(t.colors?.[c], `${t.id}: missing color ${c}`);
    for (const [k, v] of Object.entries(t.colors)) assert.ok(validColor(v), `${t.id}: color ${k} = ${v}`);
    for (const e of t.effects ?? []) assert.ok(EFFECTS.has(e), `${t.id}: unknown effect ${e}`);
  }
});

test('every preset names a theme that exists and menu bar, island and motion values the app knows', () => {
  const themes = new Set(pack('themes').themes.map((t) => t.id));
  for (const p of pack('presets').presets) {
    assert.ok(p.blurb?.en && p.blurb?.['zh-Hans'], `${p.id}: blurb needs en and zh-Hans`);
    assert.ok(themes.has(p.theme), `${p.id}: theme ${p.theme}`);
    assert.ok(MENU_BAR.has(p.menuBar), `${p.id}: menuBar ${p.menuBar}`);
    assert.ok(ISLAND.has(p.island), `${p.id}: island ${p.island}`);
    assert.ok(MOTION.has(p.motion), `${p.id}: motion ${p.motion}`);
  }
});

test('every character is drawable (Figure.isValid)', () => {
  for (const c of pack('characters').characters) {
    if (c.text) {
      assert.ok(typeof c.text.face === 'string' && Array.isArray(c.text.rest), `${c.id}: text art needs face and rest`);
      continue;
    }
    assert.ok(Array.isArray(c.box) && c.box.length === 2, `${c.id}: box`);
    assert.ok(Array.isArray(c.eyes) && c.eyes.every((e) => e.length === 2), `${c.id}: eyes`);
    assert.ok(!c.spin || c.spin.base.length === 2, `${c.id}: spin base`);
  }
});

test('every agent source has a mark, and every mark is drawable (AgentMark in Packs.swift)', () => {
  const marks = pack('agents').agents;
  for (const m of marks) {
    assert.ok(validColor(m.color), `${m.id}: color ${m.color}`);
    assert.ok(Array.isArray(m.box) && m.box.length === 2 && m.box.every((n) => n > 0), `${m.id}: box`);
    assert.ok(Array.isArray(m.paths) && m.paths.length > 0, `${m.id}: paths`);
    // The SVG subset SVGPath.parse reads (Figure.swift): no arcs.
    for (const d of m.paths) assert.match(d, /^[MLHVCQZmlhvcqz0-9.,\s-]+$/, `${m.id}: path uses only M L H V C Q Z`);
  }
  // Agent ids come from the sources (src/sources/<agent>/index.js: id = '...').
  const ids = new Set(marks.map((m) => m.id));
  const dir = path.join(ROOT, 'src', 'sources');
  for (const agent of fs.readdirSync(dir)) {
    const file = path.join(dir, agent, 'index.js');
    if (!fs.existsSync(file)) continue;
    const id = /^\s+id = '([^']+)';/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
    if (id) assert.ok(ids.has(id), `agents.json has no mark for the ${id} source`);
  }
});

// Colors only the web page uses: custom properties declared in style.css's first :root block,
// minus the ones the page takes from the theme's shared fields (app.js applyPreset).
const ROOT_VARS = new Set([...(/:root \{([^}]+)\}/.exec(read('public/style.css'))[1].matchAll(/--([a-z-]+):/g))].map((m) => m[1]));
const FROM_SHARED = new Set(['bg', 'panel', 'card', 'text', 'doing', 'waiting', 'success', 'failed', 'radius', 'mono']);
const WEB_KEYS = new Set([...ROOT_VARS].filter((v) => !FROM_SHARED.has(v)).map((v) => v.replace(/-([a-z])/g, (_, c) => c.toUpperCase())));

test("a theme's web colors name page variables, with values that cannot break the stylesheet", () => {
  assert.ok(WEB_KEYS.has('shadowHover') && WEB_KEYS.has('muted'), `read from style.css: ${[...WEB_KEYS]}`);
  for (const t of pack('themes').themes) {
    for (const [k, v] of Object.entries(t.web ?? {})) {
      assert.ok(WEB_KEYS.has(k), `${t.id}: web.${k} is not a page variable (${[...WEB_KEYS].join(', ')})`);
      assert.match(v, /^[\w\s#().,%/-]+$/, `${t.id}: web.${k}`);
      assert.ok(!/url\(|expression/i.test(v), `${t.id}: web.${k}`);
    }
  }
});

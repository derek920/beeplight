import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The layers of src/ (described in src/server.js). A module may import from its own layer and from
// the layers listed for it; src/server.js, the entry point, may import anything.
const ALLOWED = {
  lib: [],
  config: ['lib'],
  sources: ['lib', 'config'],
  services: ['lib', 'config'],
  core: ['lib', 'config', 'sources', 'services'],
  actions: ['lib', 'config'],
  transports: ['lib', 'config'],
};

const SRC = path.join(import.meta.dirname, '..', 'src');
const IMPORT = /(?:from\s+|import\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function modules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? modules(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

const layerOf = (file) => {
  const rel = path.relative(SRC, file);
  return rel.includes(path.sep) ? rel.split(path.sep)[0] : null;
};

test('every module sits in a known layer', () => {
  for (const file of modules(SRC)) {
    const layer = layerOf(file);
    if (layer === null) {
      assert.equal(path.basename(file), 'server.js', `${path.relative(SRC, file)}: only the entry point lives at the top of src/`);
      continue;
    }
    assert.ok(layer in ALLOWED, `${path.relative(SRC, file)}: unknown layer "${layer}"; add it to ALLOWED and to the map in src/server.js`);
  }
});

test('imports only go to allowed layers', () => {
  const broken = [];
  for (const file of modules(SRC)) {
    const from = layerOf(file);
    if (from === null) continue;
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = path.resolve(path.dirname(file), spec);
      assert.ok(fs.existsSync(target), `${path.relative(SRC, file)} imports missing ${spec}`);
      const to = layerOf(target);
      if (to === from || ALLOWED[from].includes(to)) continue;
      broken.push(`${path.relative(SRC, file)} (${from}) imports ${path.relative(SRC, target)} (${to ?? 'entry'})`);
    }
  }
  assert.deepEqual(broken, []);
});

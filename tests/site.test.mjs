import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../site/theme.js', import.meta.url), 'utf8');
function theme({ dark = false, saved = null, blocked = false } = {}) {
  const events = {};
  const elements = Object.fromEntries(['#theme-toggle', '#theme-auto'].map(id => [id, { hidden: true, events: {}, setAttribute(k, v) { this[k] = v; }, addEventListener(k, v) { this.events[k] = v; } }]));
  const document = { documentElement: { dataset: {}, style: {} }, querySelector: id => elements[id], addEventListener: (k, v) => events[k] = v };
  const system = { matches: dark, addEventListener: (k, v) => events.system = v };
  const storage = { getItem() { if (blocked) throw Error(); return saved; }, setItem(k, v) { if (blocked) throw Error(); saved = v; }, removeItem() { if (blocked) throw Error(); saved = null; } };
  vm.runInNewContext(source, { document, matchMedia: () => system, localStorage: storage });
  events.DOMContentLoaded();
  return { document, system, events, elements, saved: () => saved };
}
for (const dark of [false, true]) test(`first visit follows ${dark ? 'dark' : 'light'} system and live changes`, () => {
  const t = theme({ dark });
  assert.equal(t.document.documentElement.dataset.theme, dark ? 'dark' : 'light');
  assert.equal(t.elements['#theme-auto'].hidden, true);
  t.system.matches = !dark; t.events.system();
  assert.equal(t.document.documentElement.dataset.theme, dark ? 'light' : 'dark');
});
test('manual toggle persists, overrides system, then returns to automatic mode', () => {
  const t = theme({ dark: true }); t.elements['#theme-toggle'].events.click();
  assert.equal(t.saved(), 'light'); assert.equal(t.elements['#theme-auto'].hidden, false);
  t.events.system(); assert.equal(t.document.documentElement.dataset.theme, 'light');
  assert.equal(theme({ dark: true, saved: t.saved() }).document.documentElement.dataset.theme, 'light');
  t.elements['#theme-auto'].events.click();
  assert.equal(t.saved(), null); assert.equal(t.document.documentElement.dataset.theme, 'dark');
});
test('blocked local storage does not break theme controls', () => {
  const t = theme({ blocked: true }); t.elements['#theme-toggle'].events.click();
  assert.equal(t.document.documentElement.dataset.theme, 'dark');
});
test('site local assets and section links resolve', () => {
  const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  for (const [, ref] of html.matchAll(/(?:href|src)="([^" ]+)"/g)) {
    if (ref.startsWith('#')) { if (ref.length > 1) assert.ok(html.includes(`id="${ref.slice(1)}"`), ref); }
    else if (!ref.startsWith('https://')) assert.ok(fs.existsSync(new URL('../site/' + ref, import.meta.url)), ref);
  }
  assert.ok(html.indexOf('src="theme.js"') < html.indexOf('href="style.css"'));
});

// Offline render check for the 鱼圈 client module: no DSH, no browser.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const loaded = [];
globalThis.window = { __ModuleLoader__: { load(def) { loaded.push(def); } } };
globalThis.document = { baseURI: 'http://127.0.0.1:11834/' };
globalThis.fetch = async () => { throw new Error('network disabled in offline check'); };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

vm.runInThisContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { filename: 'client.js' });

const def = loaded[0];
if (!def) throw new Error('client module never called __ModuleLoader__.load');
console.log('module id:', def.id);

const mod = def.factory(require);
console.log('exports:', Object.keys(mod), 'inject:', JSON.stringify(mod.inject));

const regs = [];
const injected = [];
const ctx = {
  slots: {
    inject(name, cb) { injected.push(name); cb(); },
    register(spec, component) { regs.push({ spec, component }); return () => {}; },
  },
};
mod.apply(ctx);

console.log('injected slots:', injected.join(', '));
for (const { spec, component } of regs) {
  const target = spec.key || spec.id;
  const label = typeof spec.label === 'function' ? spec.label() : spec.label;
  console.log(`\n--- register ${spec.name} target=${target} order=${spec.order} label=${JSON.stringify(label)}`);
  try {
    const html = renderToStaticMarkup(
      React.createElement(component, spec.name === 'sidebar.panellist'
        ? { size: 22, active: true }
        : {})
    );
    console.log('html length:', html.length);
    console.log(html.slice(0, 900).replace(/\s+/g, ' '));
  } catch (error) {
    console.log('RENDER FAILED:', error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error);
    process.exitCode = 1;
  }
}

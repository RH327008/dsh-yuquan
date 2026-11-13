// 用一份假 state 渲染整块面板，检查「换皮肤 / 自定义皮肤」两张卡的结构。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const skins = [
  { id: 'koi', name: '锦鲤红', color: '#f2a65a' },
  { id: 'ember', name: '炭火橙', color: '#ef7f52' },
  { id: 'neon', name: '霓虹青', color: '#5ec8e5' },
];
const customSkins = [
  { id: 'cs-8e7fde72', name: '晚霞', color: '#ff9a76', custom: true },
  { id: 'cs-d0e89965', name: '薄荷', color: '#8ee6c8', custom: true },
];
const fish = [
  { id: 'a-fei', name: '阿肥', species: '锦鲤', color: '#f2a65a', skin: 'koi', size: 1.18, kind: 'resident', persona: '塘里最沉的那条', traits: {}, tags: ['怀旧'], memories: [] },
  { id: 'pao-pao', name: '泡泡', species: '斗鱼', color: '#ff9a76', skin: 'cs-8e7fde72', size: 0.9, kind: 'resident', persona: '话密', traits: {}, tags: ['八卦'], memories: [] },
  { id: 'v-1', name: '来访的鱼', species: '鲫鱼', color: '#8f9bb3', skin: '', size: 1, kind: 'visitor', persona: '', traits: {}, tags: [], memories: [] },
];
const state = {
  version: 2,
  pond: { id: 'pond-1', name: '我的鱼塘', endpoint: 'http://127.0.0.1:11834', allowVisitors: true, quotaPerDay: 12 },
  fish,
  edges: [],
  graph: { nodes: [], links: [] },
  encounters: [],
  visits: { in: 0, out: 0, day: '2026-11-13', count: 0 },
  skins,
  customSkins,
  stats: { fish: 2, guests: 1, encounters: 0, edges: 0, visitsIn: 0, visitsOut: 0 },
  model: { provider: 'deepseek-account', model: 'deepseek-flash' },
};

const loaded = [];
globalThis.window = { __ModuleLoader__: { load(def) { loaded.push(def); } } };
globalThis.document = { baseURI: 'http://127.0.0.1:11834/' };
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => (String(url).includes('/state') ? state : { ok: true }),
});
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

vm.runInThisContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { filename: 'client.js' });
const mod = loaded[0].factory(require);

const regs = [];
mod.apply({
  slots: {
    inject(name, cb) { cb(); },
    register(spec, component) { regs.push({ spec, component }); return () => {}; },
  },
});

const main = regs.find((item) => item.spec.name === 'main');
const html = renderToStaticMarkup(React.createElement(main.component, {}));
console.log('main html length:', html.length);
console.log('has 换皮肤 card:', html.includes('换皮肤'));
console.log('has 自定义皮肤 card:', html.includes('自定义皮肤'));
console.log('has custom skin 晚霞:', html.includes('晚霞'));
console.log('has custom skin 薄荷:', html.includes('薄荷'));
console.log('has custom tag:', html.includes('yq-skin-tag'));
console.log('has save button:', html.includes('存下并换上'));
console.log('has color input:', html.includes('type="color"'));

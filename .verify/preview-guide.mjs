// 把使用指南离线渲染成一张可截图的 HTML（不连宿主）。
// 用法：node .verify/preview-guide.mjs [输出路径]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const loaded = []
globalThis.window = { __ModuleLoader__: { load(def) { loaded.push(def) } } }
globalThis.document = { baseURI: 'http://127.0.0.1:1/' }
globalThis.fetch = async () => { throw new Error('offline') }
globalThis.__YQ_RENDER_TEST__ = true
vm.runInThisContext(source, { filename: 'client.js' })
loaded[0].factory(require)
const C = globalThis.__YQ_COMPONENTS__
if (!C || !C.GuideModal) throw new Error('GuideModal 没挂到 __YQ_COMPONENTS__')

const cssStart = source.indexOf('const CSS = `')
const cssEnd = source.indexOf('\n`', cssStart)
const css = cssStart >= 0 && cssEnd > cssStart ? source.slice(cssStart + 'const CSS = `'.length, cssEnd) : ''

const body = renderToStaticMarkup(React.createElement(C.GuideModal, { onClose() {} }))

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>鱼圈使用指南预览</title>
<style>
:root{
  --dsw-alias-bg-base:#0b1420;--dsw-alias-bg-layer-1:#111d2b;--dsw-alias-bg-layer-2:#16273a;
  --dsw-alias-border-l1:rgba(140,180,220,.18);--dsw-alias-border-l2:rgba(140,180,220,.3);
  --dsw-alias-label-primary:#e8f2ff;--dsw-alias-label-secondary:#9fb6cc;
  --dsw-alias-brand-primary:#5ec8e5;--dsw-alias-state-error-primary:#ff7b7b;
  --dsw-alias-state-warning-primary:#f4c95d;
}
html,body{margin:0;height:100%;background:radial-gradient(120% 90% at 10% -12%,#123049,transparent 56%),#0b1420;
  color:#e8f2ff;font:13px/1.5 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:24px}
${css}
</style></head>
<body>${body}</body></html>`

const out = process.argv[2] || join(tmpdir(), 'yq-guide-preview.html')
writeFileSync(out, html, 'utf8')
console.log(`guide preview written: ${out} (${html.length} chars)`)

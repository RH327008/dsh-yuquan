// 把水域 / 整个面板离线渲染成一张可截图的 HTML，用来肉眼检查布局（不连宿主）。
// 用法：node .verify/preview-pond.mjs [输出路径] [panel|stage]
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

const def = loaded[0]
if (!def) throw new Error('client.js 没调用 __ModuleLoader__.load')
def.factory(require)
const C = globalThis.__YQ_COMPONENTS__
if (!C || !C.PondStage) throw new Error('PondStage 没挂到 __YQ_COMPONENTS__')

const cssStart = source.indexOf('const CSS = `')
const cssEnd = source.indexOf('\n`', cssStart)
const css = cssStart >= 0 && cssEnd > cssStart ? source.slice(cssStart + 'const CSS = `'.length, cssEnd) : ''

const fish = [
  { id: 'a-fei', kind: 'resident', name: '阿肥', species: '锦鲤', color: '#ff8a3d', size: 1 },
  { id: 'xiao-lan', kind: 'resident', name: '小蓝', species: '霓虹灯鱼', color: '#38e8d8', size: 0.9 },
  { id: 'xiao-hei', kind: 'guest', name: '小黑', species: '斗鱼', color: '#8c8c96', size: 0.85 },
]
const routes = [
  { id: 'r1', dir: 'out', name: '阿肥', pondName: '老王鱼塘', startedAt: Date.now() },
  { id: 'r2', dir: 'in', name: '小黑', pondName: '隔壁塘', startedAt: Date.now() },
]
const items = [
  { id: 'food-watergrass', name: '上等水草', type: 'food', desc: '见面礼', count: 3 },
  { id: 'food-dried-shrimp', name: '晒干的虾米', type: 'food', desc: '香', count: 2 },
  { id: 'topic-gossip', name: '八卦卡片', type: 'topic', desc: '打探小秘密', count: 2 },
  { id: 'souvenir-shell', name: '别人的贝壳', type: 'souvenir', desc: '带不出去', count: 1 },
]

const stageProps = {
  fish, caption: '水很静', routes, items,
  onRouteDone() {}, onNibble() {}, onPack() {},
}
const stage = renderToStaticMarkup(React.createElement(C.PondStage, stageProps))

// 从 start 开始按 <div>/<\/div> 配平，返回这个元素的结束下标（不含）。
// 不能用非贪婪正则：水域内部有多层 div，正则会停在第一个 </div></div>，留下多余闭合标签把版面撑坏。
function divSpan(html, start) {
  let depth = 0
  const re = /<div\b|<\/div>/g
  re.lastIndex = start
  let hit
  while ((hit = re.exec(html))) {
    depth += hit[0] === '</div>' ? -1 : 1
    if (depth === 0) return re.lastIndex
  }
  return -1
}

const mode = process.argv[3] || 'panel'
let body = stage
if (mode === 'panel') {
  // 面板初始 state 是空的：把带鱼的水域整块塞回去，截图才像真界面。
  const panel = renderToStaticMarkup(React.createElement(C.YuquanPanel, {}))
  const start = panel.indexOf('<div class="yq-stage"')
  const end = start < 0 ? -1 : divSpan(panel, start)
  if (start < 0 || end < 0) {
    console.warn('warn: 没能在面板里找到水域块，退回只渲染水域')
    body = stage
  } else {
    body = panel.slice(0, start) + stage + panel.slice(end)
  }
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>鱼圈预览</title>
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
.wrap{max-width:1120px;margin:0 auto;padding:24px 22px 48px}
h1{font-size:15px;font-weight:600;margin:0 0 14px;opacity:.8;letter-spacing:.04em}
.panel{border:1px solid rgba(140,180,220,.16);border-radius:20px;padding:6px;background:rgba(10,20,32,.55);height:calc(100vh - 132px);overflow:hidden}
${css}
</style></head>
<body><div class="wrap"><h1>鱼圈主界面预览 · 默认「动态鱼塘」</h1>
<div class="panel">${body}</div>
</div>
<script>
// 静态渲染不跑 rAF：手动把鱼摆开、把航线画出来，截图才接近真实界面。
(function () {
  var stage = document.querySelector('.yq-stage')
  if (!stage) return
  var W = stage.clientWidth, H = stage.clientHeight
  var spots = [[0.26, 0.42, 1], [0.60, 0.64, -1], [0.44, 0.24, 1]]
  var fishes = [].slice.call(document.querySelectorAll('.yq-stage-fish'))
  fishes.forEach(function (el, i) {
    var s = spots[i % spots.length]
    el.style.transform = 'translate3d(' + (s[0] * W) + 'px,' + (s[1] * H) + 'px,0) scaleX(' + s[2] + ')'
  })
  var cv = document.querySelector('.yq-route-canvas')
  if (!cv) return
  var rect = cv.getBoundingClientRect()
  var dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = Math.round(rect.width * dpr)
  cv.height = Math.round(rect.height * dpr)
  cv.style.width = '100%'
  cv.style.height = '100%'
  var ctx = cv.getContext('2d')
  ctx.scale(dpr, dpr)
  function curve(from, to, color) {
    ctx.beginPath()
    ctx.moveTo(from[0], from[1])
    ctx.quadraticCurveTo((from[0] + to[0]) / 2, Math.min(from[1], to[1]) - rect.height * 0.22, to[0], to[1])
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 7])
    ctx.stroke()
  }
  var center = [W * 0.5, H * 0.58]
  curve(center, [W - 10, H * 0.14], 'rgba(126,214,245,.55)')
  curve([10, H * 0.9], [center[0], center[1]], 'rgba(160,182,255,.5)')
  ;[[0.52, 0.34], [0.36, 0.52]].forEach(function (p) {
    var b = document.createElement('div')
    b.className = 'yq-bait'
    b.style.transform = 'translate3d(' + (p[0] * W) + 'px,' + (p[1] * H) + 'px,0)'
    document.querySelector('.yq-bait-layer').appendChild(b)
  })
  var bub = document.createElement('div')
  bub.className = 'yq-fish-bubble'
  bub.textContent = '谢谢老板的投喂！'
  bub.style.transform = 'translate3d(' + (0.26 * W + 18) + 'px,' + (0.42 * H - 16) + 'px,0)'
  document.querySelector('.yq-bubble-layer').appendChild(bub)
  var card = document.createElement('div')
  card.className = 'yq-postcard yq-postcard-out'
  card.innerHTML = '<span class="yq-postcard-title">✉️ 明信片 · 出门了</span><span class="yq-postcard-text">阿肥 已经游向 老王鱼塘，等它带点特产回来。</span>'
  document.querySelector('.yq-stage-ui').appendChild(card)
})()
</script>
</body></html>`

const out = process.argv[2] || join(tmpdir(), 'yq-pond-preview.html')
writeFileSync(out, html, 'utf8')
console.log(`preview written: ${out} (${html.length} chars, mode=${mode})`)

// 离线渲染检查：把 client.js 的组件逐个渲染成 HTML，确认关键 UI 真的长出来了。
// 只做静态渲染（没有真实 state、没有浏览器），所以看到的是各组件的「初始形态」。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const loaded = []
globalThis.window = { __ModuleLoader__: { load(def) { loaded.push(def) } } }
globalThis.document = { baseURI: 'http://127.0.0.1:11834/' }
globalThis.fetch = async () => { throw new Error('network disabled in offline check') }
globalThis.__YQ_RENDER_TEST__ = true

vm.runInThisContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { filename: 'client.js' })

const def = loaded[0]
if (!def) throw new Error('client module never called __ModuleLoader__.load')
const mod = def.factory(require)
const C = globalThis.__YQ_COMPONENTS__
if (!C) throw new Error('__YQ_COMPONENTS__ 没挂上，检查 __YQ_RENDER_TEST__ 那段')

const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const residents = [
  { id: 'f1', kind: 'resident', name: '阿肥', species: '锦鲤', color: '#d94f4f', skin: 's2', size: 1, image: '/yuquan/api/skin/image?id=s2&v=1' },
  { id: 'f2', kind: 'resident', name: '小蓝', species: '霓虹灯鱼', color: '#4f9ad9', size: 0.8, image: null },
]
const skins = [
  { id: 's1', name: '锦鲤红', color: '#d94f4f' },
  { id: 's2', name: '晚霞', color: '#d94f4f', custom: true, hasImage: true, image: '/yuquan/api/skin/image?id=s2&v=1' },
]

let pass = 0
const fails = []
function ok(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); return }
  fails.push(name + (detail ? ` — ${detail}` : ''))
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}
function render(Comp, props) {
  return renderToStaticMarkup(React.createElement(Comp, props))
}

/* ---------- FishGlyph：没图 / 有图 ---------- */
const plain = render(C.FishGlyph, { color: '#d94f4f', size: 1, species: '锦鲤' })
ok('没有图时不出 pattern', !plain.includes('<pattern'))
ok('没有图时身体用渐变', plain.includes('url(#yqf') && !plain.includes('-photo)'))

const withPhoto = render(C.FishGlyph, { color: '#d94f4f', size: 1, species: '锦鲤', image: PHOTO })
ok('有图时铺 pattern', withPhoto.includes('<pattern'))
ok('pattern 里放图片', withPhoto.includes('<image') && withPhoto.includes(PHOTO))
ok('身体填 pattern', /fill="url\(#[^"]+-photo\)"/.test(withPhoto))
ok('同色同种不同图 → 不同 pattern id', (() => {
  const a = render(C.FishGlyph, { color: '#d94f4f', size: 1, species: '锦鲤', image: PHOTO })
  const b = render(C.FishGlyph, { color: '#d94f4f', size: 1, species: '锦鲤', image: PHOTO + 'x' })
  const ida = /id="([^"]+)-photo"/.exec(a)?.[1]
  const idb = /id="([^"]+)-photo"/.exec(b)?.[1]
  return Boolean(ida && idb && ida !== idb)
})())

/* ---------- SkinCard：高亮只点亮一格 + 图标记 ---------- */
const skinCard = render(C.SkinCard, { fish: residents, skins, selectedId: 'f1', onSelect() {}, onPick() {}, busyId: '' })
ok('换皮肤显示鱼名', skinCard.includes('阿肥') && skinCard.includes('小蓝'))
ok('同色两套皮只点亮一格', (skinCard.match(/ yq-skin-on"/g) || []).length === 1, `实际 ${(skinCard.match(/ yq-skin-on"/g) || []).length}`)
ok('点亮的是 id 命中的那套（晚霞）', skinCard.includes('晚霞（现在就是）'))
ok('带图的皮肤有「图」标', skinCard.includes('图</span>'))
ok('皮肤格预览用上了图', skinCard.includes('/yuquan/api/skin/image?id=s2'))

/* ---------- CustomSkinCard：导入图片这一块 ---------- */
const custom = render(C.CustomSkinCard, {
  fish: residents,
  customSkins: [{ id: 's2', name: '晚霞', color: '#d94f4f', custom: true, hasImage: true, image: '/yuquan/api/skin/image?id=s2' }],
  selectedId: 'f1',
  onSelect() {}, onCreate() {}, onRemove() {}, busy: false,
})
ok('自定义皮肤卡片在场', custom.includes('自定义皮肤') && custom.includes('已存 1 / 24 套'))
ok('导入区在场', custom.includes('yq-custom-photo-pick'))
ok('文案「导入一张图」', custom.includes('导入一张图'))
ok('可拖拽提示', custom.includes('把图拖进来'))
ok('role=button', custom.includes('role="button"'))
ok('键盘可达 tabindex', custom.includes('tabindex="0"'))
ok('无障碍标签', custom.includes('aria-label="导入一张图片当皮肤"'))
ok('文件选择限制图片', custom.includes('accept="image/*"'))
ok('已存带图的皮肤有「去图」', custom.includes('去图'))
ok('带图皮肤 chip 有「图」标', custom.includes('yq-custom-chip-img'))

/* ---------- CustomSkinCard：存满 24 套之后 ---------- */
const fullSkins = Array.from({ length: 24 }, (_, index) => ({
  id: `cs-${index}`,
  name: `皮${index}`,
  color: '#445566',
  custom: true,
}))
const fullCard = render(C.CustomSkinCard, {
  fish: residents,
  customSkins: fullSkins,
  selectedId: 'f1',
  onSelect() {}, onCreate() {}, onRemove() {}, busy: false,
})
ok('存满时标题显示 24 / 24', fullCard.includes('已存 24 / 24 套'))
ok('存满时给出提示', fullCard.includes('已经存满 24 套了'))
ok('存满时提示带 yq-note-warn', fullCard.includes('yq-note-warn'))
ok('存满时保存按钮 disabled', /yq-custom-save" disabled/.test(fullCard))
const roomCard = render(C.CustomSkinCard, {
  fish: residents,
  customSkins: fullSkins.slice(0, 23),
  selectedId: 'f1',
  onSelect() {}, onCreate() {}, onRemove() {}, busy: false,
})
ok('没存满时保存按钮可点', !/yq-custom-save" disabled/.test(roomCard))

/* ---------- CustomSkinCard：空塘 ---------- */
const empty = render(C.CustomSkinCard, { fish: [], customSkins: [], selectedId: null, onSelect() {}, onCreate() {}, onRemove() {}, busy: false })
ok('空塘走「还没有鱼」分支', empty.includes('还没有鱼'))

/* ---------- PondScene：泳道也用图 ---------- */
const pond = render(C.PondScene, {
  fish: residents,
  busy: null,
  caption: '测试',
})
ok('泳道渲染出鱼', pond.includes('阿肥') || pond.includes('yq-pond'))
ok('泳道里的鱼用上了图', pond.includes('/yuquan/api/skin/image?id=s2'))

/* ---------- GateCard：塘号在、IP 输入框走了 ---------- */
const gate = render(C.GateCard, {
  pond: {
    id: 'pond-1', name: '我的鱼塘', code: '483920', address: 'fishpond://483920',
    endpoint: 'http://127.0.0.1:11834', relay: '', allowVisitors: true, quotaPerDay: 12,
    inviteOnly: false, whitelist: [], nightClose: { enabled: false, from: '23:00', to: '08:00' },
  },
  visits: { in: 1, out: 0, count: 1 },
  residents,
  onSaveAccess() {}, onTravel() {}, onVisit() {}, onCopy() {}, onInvite: async () => null,
  busy: false,
})
ok('塘口卡片显示塘号', gate.includes('483920'))
ok('塘口卡片给 fishpond:// 地址', gate.includes('fishpond://483920'))
ok('出门输入框提示填塘号', gate.includes('对方塘号'))
ok('不再把局域网地址当主输入框', !/placeholder="http:\/\/192\.168/.test(gate))
ok('直连地址被折叠起来', gate.includes('同一局域网？填直连地址') && !gate.includes('直连串门'))
ok('门禁里有夜间打烊', gate.includes('夜间打烊') && gate.includes('type="time"'))
ok('门禁里有白名单与只认邀请码', gate.includes('白名单') && gate.includes('只认邀请码'))
ok('中转为空时给出提示', gate.includes('没配中转站时'))
ok('显示今天还剩几位', gate.includes('今天还剩 11 位'))
ok('有生成邀请码入口', gate.includes('生成邀请码'))

/* ---------- GateCard：配了中转站 ---------- */
const gateRelay = render(C.GateCard, {
  pond: {
    id: 'pond-1', name: '我的鱼塘', code: '483920', endpoint: '', relay: 'http://relay.test:8787',
    allowVisitors: true, quotaPerDay: 12, inviteOnly: false, whitelist: ['111111', '222222'],
    nightClose: { enabled: true, from: '23:00', to: '08:00' },
  },
  visits: { in: 0, out: 0, count: 0 },
  residents,
  onSaveAccess() {}, onTravel() {}, onVisit() {}, onCopy() {}, onInvite: async () => null,
  busy: false,
})
ok('配了中转站时不再提示要配', gateRelay.includes('中转站配好了'))
ok('白名单回填到输入框', gateRelay.includes('111111') && gateRelay.includes('222222'))
ok('夜间打烊勾上是勾上的', /checked=""/.test(gateRelay))

/* ---------- PondStage：水域骨架与鱼 ---------- */
const stage = render(C.PondStage, {
  fish: [
    { id: 'f1', kind: 'resident', name: '阿肥', species: '锦鲤', color: '#d94f4f', size: 1 },
    { id: 'g1', kind: 'guest', name: '小黑', species: '斗鱼', color: '#8c8c96', size: 0.9 },
  ],
  caption: '水很静',
  routes: [{ id: 'r1', dir: 'out', name: '阿肥', pondName: '老王鱼塘', startedAt: Date.now() }],
  items: [
    { id: 'food-watergrass', name: '上等水草', type: 'food', desc: '见面礼', count: 3, takeable: true },
    { id: 'topic-gossip', name: '八卦卡片', type: 'topic', desc: '打探小秘密', count: 2, takeable: true },
  ],
  onRouteDone() {},
  onNibble() {},
  onPack() {},
})
ok('水域有主容器与中央提示', stage.includes('yq-stage"') && stage.includes('点击水面投喂'))
ok('水面有底层水波与暗角', stage.includes('yq-stage-water') && stage.includes('yq-stage-vignette'))
ok('水域有饵料/气泡/画布三层', stage.includes('yq-bait-layer') && stage.includes('yq-bubble-layer') && stage.includes('yq-route-canvas'))
ok('水域里鱼的名字都在', stage.includes('阿肥') && stage.includes('小黑'))
ok('外来鱼带 is-guest 标记', stage.includes('is-guest'))
ok('水域可点（role=application）', stage.includes('role="application"'))
ok('航线图面板有标题', stage.includes('外交航线图') && stage.includes('yq-route-panel'))
ok('航线列出出门的鱼与塘名', stage.includes('阿肥 → 老王鱼塘') && stage.includes('航程中'))
ok('行囊入口显示库存件数', stage.includes('yq-pack-btn') && stage.includes('🎒') && stage.includes('5 件'))
ok('左下角有鱼食按钮', stage.includes('yq-bait-btn') && stage.includes('🍞') && stage.includes('鱼食'))
ok('悬浮 UI 层不接画布事件', stage.includes('yq-stage-ui'))

/* ---------- PackDialog：行囊挑选 ---------- */
const items = [
  { id: 'food-watergrass', name: '上等水草', type: 'food', desc: '见面礼', count: 3, takeable: true },
  { id: 'food-dried-shrimp', name: '晒干的虾米', type: 'food', desc: '香', count: 0, takeable: true },
  { id: 'topic-gossip', name: '八卦卡片', type: 'topic', desc: '打探小秘密', count: 2, takeable: true },
  { id: 'souvenir-shell', name: '别人的贝壳', type: 'souvenir', desc: '带不出去', count: 1, takeable: false },
]
const pack = render(C.PackDialog, {
  fish: { id: 'f1', name: '阿肥', pack: ['food-watergrass', 'topic-gossip'] },
  items,
  onClose() {},
  onConfirm() {},
  busy: false,
})
ok('行囊弹窗标题与说明', pack.includes('整理行囊') && pack.includes('最多两件'))
ok('行囊里有两组（吃的/话题）', pack.includes('带点吃的') && pack.includes('带张话题卡'))
ok('行囊显示件数与是否选中', pack.includes('已选 2 / 2') && pack.includes('is-active'))
ok('用完了的道具是禁用的', /disabled=""[^>]*>[\s\S]*?晒干的虾米/.test(pack) || pack.includes('用完了'))
ok('特产不出现在可选格子里', !pack.includes('别人的贝壳') || pack.includes('只能留在仓库里看'))
ok('行囊底部有出发按钮', pack.includes('装好，出发'))

const packOnly = render(C.PackDialog, {
  fish: { id: 'f1', name: '阿肥', pack: [] },
  items,
  mode: 'pack',
  onClose() {},
  onConfirm() {},
  busy: false,
})
ok('只打包时标题与按钮改口', packOnly.includes('行囊') && packOnly.includes('>装好<'))

/* ---------- YuquanPanel：默认鱼塘 / 两个 Tab / 折叠 ---------- */
const panel = render(C.YuquanPanel, {})
// 面板里带一个 <style>，断言前先剥掉，免得匹配到 CSS 里的类名。
const panelMarkup = panel.replace(/<style>[\s\S]*?<\/style>/, '')
ok('面板默认就是动态鱼塘', panelMarkup.includes('🐟 动态鱼塘') && panelMarkup.includes('yq-stage-water'))
ok('面板有鱼塘/关系网两个 Tab', panelMarkup.includes('🕸️ 关系网') && panelMarkup.includes('yq-tab'))
ok('默认不渲染关系网（切换才出）', !panelMarkup.includes('yq-graph-wrap'))
ok('鱼友与塘口设置被折叠', panelMarkup.includes('鱼友与塘口设置') && panelMarkup.includes('yq-fold'))
ok('右侧保留下换皮肤与自定义皮肤', panelMarkup.includes('换皮肤') && panelMarkup.includes('自定义皮肤'))
ok('主区是左右两栏（左舞台 + 右抽屉栏）', panelMarkup.includes('yq-body') && panelMarkup.includes('yq-left') && panelMarkup.includes('yq-rail'))
ok('左栏是「舞台 + 信息流」两段', panelMarkup.includes('yq-stage-slot') && panelMarkup.includes('yq-stream') && panelMarkup.includes('yq-log'))
ok('右侧栏自身滚动（不撑高整页）', /\.yq-rail\{[^}]*overflow-y:auto/.test(panel))
ok('整体锁高：body 用 grid 且 overflow:hidden', /\.yq-body\{[^}]*display:grid[^}]*overflow:hidden/.test(panel))
ok('舞台占 3 份、信息流占 2 份', /\.yq-stage-slot\{[^}]*flex:3 1 0/.test(panel) && /\.yq-stream\{[^}]*flex:2 1 0/.test(panel))

// ---- 使用指南 ----
const guide = render(C.GuideModal, { onClose() {} })
ok('指南用加宽弹窗', guide.includes('yq-modal is-wide'))
ok('指南有「先玩这三下」', guide.includes('先玩这三下') && guide.includes('点水面掉一颗饵料'))
ok('指南九个章节都在', ['一屏怎么看', '让鱼开口', '看关系', '水面上的小玩法', '打扮一条鱼', '让鱼出门', '接待客人', '数据放哪', '出问题了怎么办'].every((t) => guide.includes(t)))
ok('指南讲了两个 Tab', guide.includes('动态鱼塘') && guide.includes('关系网'))
ok('指南讲了航线图与行囊', guide.includes('外交航线图') && guide.includes('行囊'))
ok('指南讲了塘号与邀请码', guide.includes('塘号') && guide.includes('INV1.'))
ok('指南讲了门禁五道', guide.includes('夜间打烊') && guide.includes('白名单') && guide.includes('每日上限'))
ok('指南讲了访客沙盒', guide.includes('untrusted') && guide.includes('只能说话'))
ok('指南讲了重启桌面应用', guide.includes('重启 DSH 桌面应用'))
ok('指南讲了数据文件', guide.includes('pond.json') && guide.includes('.bak'))
ok('指南正文支持加粗与代码', guide.includes('yq-guide-strong') && guide.includes('yq-guide-code'))
ok('指南页脚有 Esc 提示', guide.includes('Esc') && guide.includes('知道了'))
ok('指南有目录跳转（九项）', (guide.match(/yq-guide-nav-item/g) || []).length === 9)
ok('指南章节带锚点 id', guide.includes('id="yq-guide-0"') && guide.includes('id="yq-guide-8"'))
ok('指南章节带序号', guide.includes('>01<') && guide.includes('>09<'))
const guideWithFeedback = render(C.GuideModal, { onClose() {}, onFeedback() {} })
ok('指南页脚有反馈入口', guideWithFeedback.includes('有问题？写反馈'))

console.log(`\n${fails.length ? '有失败' : '全部通过'}：${pass} 项通过，${fails.length} 项失败`)
for (const item of fails) console.log(`  - ${item}`)
process.exit(fails.length ? 1 : 0)

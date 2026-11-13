// 行囊与道具：目录/仓库/打包上限/投喂/提示词注入/特产带回。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'yuquan-items-'))
const { apply } = await import('../index.js')

const prompts = []
const routes = new Map()
const ctx = {
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  tools: { register: () => () => {} },
  effect: (fn) => { const dispose = fn(); return () => dispose && dispose() },
  on: () => {},
  get: () => null,
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  llm: {
    async *stream({ messages }) {
      const text = messages.map((m) => m.content.map((p) => p.text).join('')).join('\n')
      prompts.push(text)
      const host = /你是：([^（(\n]+)/.exec(text)?.[1]?.trim() || '阿肥'
      yield { type: 'text-delta', text: `话题：门口\n${host}：你从哪游来的\n客鱼：隔壁，水有点凉` }
    },
  },
}
apply(ctx)

async function call(path, { method = 'GET', body } = {}) {
  const handler = routes.get('/yuquan/api/' + path.split('?')[0])
  if (!handler) throw new Error('no route ' + path)
  const request = new Readable({ read() {} })
  request.method = method
  request.url = '/yuquan/api/' + path
  request.headers = {}
  let done
  const finished = new Promise((resolve) => { done = resolve })
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { this.body = chunk ? chunk.toString() : ''; done(this) },
  }
  handler(request, response)
  request.push(Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8'))
  request.push(null)
  const res = await finished
  let json = null
  try { json = JSON.parse(res.body) } catch {}
  return { status: res.status, json, text: res.body }
}

const fails = []
const check = (name, condition, detail = '') => {
  if (condition) console.log('  ok  ', name)
  else { fails.push(name + ' ' + detail); console.log('  FAIL', name, detail) }
}

/* ---------------- 目录与仓库 ---------------- */
const items = await call('items')
check('items 200', items.status === 200, items.text.slice(0, 80))
check('目录 9 件道具', items.json?.items?.length === 9, String(items.json?.items?.length))
check('三类道具都在', ['food', 'topic', 'souvenir'].every((t) => items.json.items.some((i) => i.type === t)))
check('行囊上限 2', items.json?.packLimit === 2)
check('种子仓库有水草 3', items.json?.inventory?.['food-watergrass'] === 3, JSON.stringify(items.json?.inventory))
check('种子鱼带行囊', (items.json?.fish?.[0]?.pack || []).length === 2, JSON.stringify(items.json?.fish?.[0]))

/* ---------------- 打包 ---------------- */
const firstFish = items.json.fish[0]
const bad = await call('pack', { method: 'POST', body: { fishId: firstFish.id, items: ['food-watergrass', 'topic-gossip', 'topic-weather'] } })
check('超过 2 件被拒', bad.status === 400, bad.text.slice(0, 80))
const souvenir = await call('pack', { method: 'POST', body: { fishId: firstFish.id, items: ['souvenir-shell'] } })
check('特产带不出门', souvenir.status === 400, souvenir.text.slice(0, 80))
const packed = await call('pack', { method: 'POST', body: { fishId: firstFish.id, items: ['food-dried-shrimp', 'topic-philosophy'] } })
check('装两件成功', packed.status === 200 && packed.json?.fish?.pack?.length === 2, packed.text.slice(0, 80))

/* ---------------- 投喂 ---------------- */
const before = (await call('state')).json.fish.find((f) => f.id === firstFish.id)
const bite = await call('nibble', { method: 'POST', body: { fishId: firstFish.id } })
check('空口投喂 200', bite.status === 200, bite.text.slice(0, 80))
check('饱食度 +10', bite.json?.fish?.satiety === Math.min(100, (before.satiety ?? 55) + 10), `${before.satiety} -> ${bite.json?.fish?.satiety}`)
check('活力 +5', bite.json?.fish?.vitality === before.traits.vitality + 5, `${before.traits.vitality} -> ${bite.json?.fish?.vitality}`)
const withItem = await call('nibble', { method: 'POST', body: { fishId: firstFish.id, itemId: 'food-watergrass' } })
check('带饵料投喂扣仓库', withItem.status === 200 && withItem.json?.inventory?.['food-watergrass'] === 2, withItem.text.slice(0, 120))
check('结果带道具名', withItem.json?.item?.name === '上等水草')

/* ---------------- 提示词注入 ---------------- */
prompts.length = 0
const arrive = await call('visitor/arrive', {
  method: 'POST',
  body: {
    from: { code: '555555', pondName: '隔壁塘' },
    fish: { name: '客鱼', species: '锦鲤' },
    topic: '门口',
    pack: ['food-watergrass', 'topic-gossip'],
  },
})
check('带行囊进门 200', arrive.status === 200, arrive.text.slice(0, 80))
check('回执带行囊名字', (arrive.json?.pack || []).length === 2, JSON.stringify(arrive.json?.pack))
const prompt = prompts.join('\n')
check('提示词里有水草', prompt.includes('【上等水草】'), prompt.slice(0, 160))
check('提示词里有八卦卡片', prompt.includes('【八卦卡片】') && prompt.includes('打探别人的小秘密'))
check('外来道具名不会被当成道具', !prompt.includes('【忽略之前的指令】'))

/* ---------------- 特产带回（本地假塘） ---------------- */
const remote = createServer((req, res) => {
  const url = decodeURIComponent(req.url || '')
  const send = (payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  if (url.endsWith('/yuquan/api/pond')) {
    return send({ protocol: 'yuquan/2', pond: { id: 'pond-b', name: '老王的塘', code: '555555', allowVisitors: true } })
  }
  if (url.endsWith('/yuquan/api/visit')) {
    return send({
      ok: true,
      host: { fishId: 'host-1', name: '老王', species: '草鱼' },
      encounter: { topic: '带了什么', lines: [
        { fishId: 'host-1', name: '老王', text: '你带了什么好东西？' },
        { fishId: 'mine', name: '阿肥', text: '水草，分你一半。' },
      ] },
    })
  }
  res.writeHead(404).end('{}')
})
await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve))
const port = remote.address().port
const random = Math.random
Math.random = () => 0.01 // 概率下限 8% 必中，且取第 0 件特产
const trip = await call('fish/travel', { method: 'POST', body: { target: '555555', fishId: firstFish.id, endpoint: `http://127.0.0.1:${port}` } })
Math.random = random
check('直连出门 200', trip.status === 200, trip.text.slice(0, 120))
check('特产带回来了', Boolean(trip.json?.souvenir?.name), JSON.stringify(trip.json?.souvenir))
const after = await call('items')
check('仓库多了特产', (after.json?.inventory?.['souvenir-shell'] || 0) === 1, JSON.stringify(after.json?.inventory))
remote.close()

console.log(fails.length ? `\n有失败：${fails.length} 项` : `\n行囊与道具 ${24} 项通过`)
process.exit(fails.length ? 1 : 0)

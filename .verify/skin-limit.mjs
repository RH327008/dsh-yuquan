// 上限回归：满 24 套自定义皮肤时，改一套「已经存在的」皮仍要能换图，
// 只有真正新增第 25 套才该被拒。这是本轮修的 bug，留个用例盯住。
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'yuquan-limit-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'yuquan'), { recursive: true })

const { apply } = await import('../index.js')

const routes = new Map()
apply({
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  tools: { register: () => () => {} },
  effect: (fn) => {
    const dispose = fn()
    return () => dispose && dispose()
  },
  get: () => null,
  on: () => {},
})

function call(path, { method = 'GET', body } = {}) {
  const handler = routes.get(`/yuquan/api/${path.split('?')[0]}`)
  if (!handler) throw new Error(`没有路由 ${path}`)
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() {} })
    req.method = method
    req.url = `/yuquan/api/${path}`
    req.headers = {}
    const res = {
      status: 0,
      headers: {},
      chunks: [],
      writeHead(status, headers) { this.status = status; this.headers = headers || {} },
      end(chunk) {
        if (chunk) this.chunks.push(Buffer.from(chunk))
        resolve({ status: this.status, headers: this.headers, body: Buffer.concat(this.chunks).toString('utf8') })
      },
    }
    setTimeout(() => {
      if (body !== undefined) req.push(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'))
      req.push(null)
    }, 0)
    handler(req, res)
  })
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
let pass = 0
const fails = []
function ok(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); return }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

// 先建一套真的
const created = await call('skin/custom', { method: 'POST', body: { name: '老皮', color: '#112233' } })
ok('建第一套 200', created.status === 200, created.body.slice(0, 120))
const first = JSON.parse(created.body).skin

// 把它补到 24 套（直接改磁盘，模拟「已经存满」）
const statePath = join(home, 'yuquan', 'pond.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const now = Date.now()
state.customSkins = [state.customSkins[0]]
for (let i = 1; i <= 23; i += 1) {
  state.customSkins.push({ id: `cs-fill${String(i).padStart(2, '0')}`, name: `填充${i}`, color: '#445566', custom: true, createdAt: now })
}
writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
ok('已铺到 24 套', state.customSkins.length === 24)

// 满额时改已有这套（换图）→ 应该成功
const same = await call('skin/custom', { method: 'POST', body: { name: '老皮', color: '#112233', image: PNG } })
ok('满额时改已有皮肤仍 200', same.status === 200, same.body.slice(0, 160))
if (same.status === 200) {
  const skin = JSON.parse(same.body).skin
  ok('并且图存上了', skin.hasImage === true)
}

// 满额时新增第 25 套 → 应该被拒
const extra = await call('skin/custom', { method: 'POST', body: { name: '新皮', color: '#778899' } })
ok('满额时新增第 25 套被拒', extra.status === 500 && /最多存 24 套/.test(extra.body), `${extra.status} ${extra.body.slice(0, 120)}`)

console.log(`\n${fails.length ? '有失败' : '全部通过'}：${pass} 项通过，${fails.length} 项失败`)
for (const item of fails) console.log(`  - ${item}`)
process.exit(fails.length ? 1 : 0)

// 落盘健壮性：pond.json 写坏时不许直接把种子鱼盖上去（那是丢数据），
// 要先退回上一份好的 pond.json.bak；正常写入走「临时文件 + 改名」，不留半个文件。
import { Readable } from 'node:stream'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'yuquan-durable-'))
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

let pass = 0
const fails = []
function ok(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); return }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

const statePath = join(home, 'yuquan', 'pond.json')
const backupPath = `${statePath}.bak`
const tmpPath = `${statePath}.tmp`

/* ---------- 正常写入 ---------- */
const first = await call('state')
ok('首次 GET state 200', first.status === 200, first.body.slice(0, 120))
const seeded = JSON.parse(first.body)
ok('首启落下种子鱼', Array.isArray(seeded.fish) && seeded.fish.length >= 3, `fish=${seeded.fish && seeded.fish.length}`)
ok('状态文件写出来了', existsSync(statePath))
ok('没留下临时文件', !existsSync(tmpPath))

const created = await call('skin/custom', { method: 'POST', body: { name: '备份验证', color: '#123456' } })
ok('存一套自定义皮肤 200', created.status === 200, created.body.slice(0, 140))
ok('写完就有 .bak 备份', existsSync(backupPath))
ok('正常写也不留 .tmp', !existsSync(tmpPath))

const good = readFileSync(statePath, 'utf8')
ok('磁盘上的状态里有这套皮肤', good.includes('备份验证'))

/* ---------- 主文件被写坏：应该退回 .bak ---------- */
copyFileSync(statePath, backupPath)          // 这份 .bak 是好的，且含「备份验证」
writeFileSync(statePath, '{"version":2,"fish":[{"id":', 'utf8')  // 半截 JSON，模拟断电

const recovered = await call('state')
ok('坏文件时 GET state 仍 200', recovered.status === 200, recovered.body.slice(0, 120))
const recoveredState = JSON.parse(recovered.body || '{}')
const names = (recoveredState.customSkins || []).map((skin) => skin.name)
ok('从 .bak 里恢复了自定义皮肤', names.includes('备份验证'), `customSkins=${names.join(',') || '（空）'}`)
ok('没有退回种子鱼重来', (recoveredState.fish || []).length === seeded.fish.length, `fish=${(recoveredState.fish || []).length}`)
ok('恢复后主文件已是合法 JSON', (() => {
  try { JSON.parse(readFileSync(statePath, 'utf8')); return true } catch { return false }
})())
ok('恢复后 .bak 没被覆盖成坏内容', (() => {
  try { return JSON.parse(readFileSync(backupPath, 'utf8')).customSkins.length > 0 } catch { return false }
})())
ok('恢复过程不留 .tmp', !existsSync(tmpPath))

/* ---------- 没有 .bak 又写坏：只能重来，但必须仍然能用 ---------- */
rmSync(backupPath, { force: true })
writeFileSync(statePath, 'not json at all', 'utf8')
const reseeded = await call('state')
ok('没有备份时 GET state 仍 200', reseeded.status === 200, reseeded.body.slice(0, 120))
const reseededState = JSON.parse(reseeded.body || '{}')
ok('没有备份时退回种子鱼', (reseededState.fish || []).length >= 3, `fish=${(reseededState.fish || []).length}`)
ok('目录里没留残渣', readdirSync(join(home, 'yuquan')).every((file) => !file.endsWith('.tmp')))

console.log(`\n${fails.length ? '有失败' : '全部通过'}：${pass} 项通过，${fails.length} 项失败`)
for (const item of fails) console.log(`  - ${item}`)
process.exit(fails.length ? 1 : 0)

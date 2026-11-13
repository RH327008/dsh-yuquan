// 皮肤图导入的处理器级自测：假 ctx + 假 req/res，直接打插件的路由。
// 运行：node ./.verify/skin-image.mjs
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'yuquan-img-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

const routes = new Map()
const ctx = {
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error(`已注册 ${route.path}`)
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
}

apply(ctx)

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
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      end(chunk) {
        if (chunk) this.chunks.push(Buffer.from(chunk))
        resolve({ status: this.status, headers: this.headers, body: Buffer.concat(this.chunks) })
      },
    }
    handler(req, res)
    if (body !== undefined) req.push(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.push(null)
    setTimeout(() => reject(new Error(`${path} 超时`)), 5000)
  })
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const json = (r) => JSON.parse(r.body.toString('utf8'))
let failed = 0
function check(name, ok, extra = '') {
  if (ok) console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`)
  else {
    failed += 1
    console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`)
  }
}

const create = await call('skin/custom', {
  method: 'POST',
  body: { name: '海边', color: '#3a7bd5', image: `data:image/png;base64,${PNG}` },
})
const created = json(create)
check('POST skin/custom 200', create.status === 200, `body=${JSON.stringify(created).slice(0, 160)}`)
check('skin.hasImage', created.skin && created.skin.hasImage === true)
check('skin.image 是取图地址', /^\/yuquan\/api\/skin\/image\?id=cs-[a-z0-9]+/.test(String(created.skin && created.skin.image)))
const id = created.skin && created.skin.id

const dir = join(home, 'yuquan', 'skins')
const files = existsSync(dir) ? readdirSync(dir) : []
check('图片落到磁盘', files.some((f) => /^cs-[a-z0-9]+\.png$/.test(f)), `files=${files.join(',') || '无'}`)

const img = await call(`skin/image?id=${encodeURIComponent(id)}`)
check('GET skin/image 200', img.status === 200)
check('content-type', img.headers['content-type'] === 'image/png', String(img.headers['content-type']))
check('字节一致', img.body.equals(Buffer.from(PNG, 'base64')), `${img.body.length}B`)
check('etag + 长缓存', Boolean(img.headers.etag) && /immutable/.test(String(img.headers['cache-control'])))

const state = json(await call('state'))
const mine = (state.customSkins || []).find((s) => s.id === id)
check('state.hasImage', mine && mine.hasImage === true)
check('state.fish[].image 字段存在', (state.fish || []).every((f) => 'image' in f))
check('state.skins 里 hasImage', (state.skins || []).some((s) => s.id === id && s.hasImage === true))

const head = await call(`skin/image?id=${encodeURIComponent(id)}`, { method: 'HEAD' })
check('HEAD 200 且无 body', head.status === 200 && head.body.length === 0)

const clear = json(await call('skin/custom', { method: 'POST', body: { name: '海边', color: '#3a7bd5', clearImage: true } }))
check('clearImage 后 hasImage=false', clear.skin && clear.skin.hasImage === false)
check('clearImage 后文件删掉', !(existsSync(dir) && readdirSync(dir).some((f) => /\.(png|jpg|webp)$/.test(f))))

const bad = await call('skin/custom', {
  method: 'POST',
  body: { name: '假图', color: '#123456', image: 'data:image/png;base64,bm90LWFuLWltYWdl' },
})
check('魔数不对被拒', bad.status === 500 && /认不出/.test(json(bad).error), JSON.stringify(json(bad)))

const missing = await call('skin/image?id=cs-nope')
check('不存在的图 404', missing.status === 404)

const removed = json(await call('skin/remove', { method: 'POST', body: { id } }))
check('删皮肤 200', removed.ok === true)

rmSync(home, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)

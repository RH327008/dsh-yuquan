// 取官方索引里的一条插件，确认字段结构（只读网络请求）
const res = await fetch('https://awesome-dsh-plugin.com/index.json', { signal: AbortSignal.timeout(60000) })
const body = await res.text()
console.log('status', res.status, 'bytes', body.length)
const idx = JSON.parse(body)
console.log('top keys:', Object.keys(idx).join(','))
const plugins = Array.isArray(idx.plugins) ? idx.plugins : Array.isArray(idx.items) ? idx.items : []
console.log('count', plugins.length)
console.log(JSON.stringify(plugins[0], null, 2).slice(0, 1800))
const hit = plugins.find((p) => String(p.name).includes('pet'))
console.log('--- sample matching "pet" ---')
console.log(JSON.stringify(hit, null, 2).slice(0, 1800))

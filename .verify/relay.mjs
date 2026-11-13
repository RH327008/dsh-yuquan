/**
 * 中转站 + 中转客户端的端到端回归（真起一个 HTTP 服务，不监听外部端口）。
 * 跑法：node ./.verify/relay.mjs
 */
import assert from 'node:assert/strict'
import { createPondKeyPair, sealEnvelope } from '../net.js'
import { createRelayServer } from '../relay/server.mjs'
import { createRelayClient } from '../relay/client.js'

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok ${passed} - ${name}`)
}

const A = '101010'
const B = '202020'
const keyA = createPondKeyPair()
const keyB = createPondKeyPair()

const server = createRelayServer()
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const received = []
const clientA = createRelayClient({ url: base, code: A, endpoint: 'http://10.0.0.1:11834', keyPair: keyA })
const clientB = createRelayClient({
  url: base,
  code: B,
  endpoint: 'http://10.0.0.2:11834',
  keyPair: keyB,
  onEnvelope: (envelope) => received.push(envelope),
})

await clientA.hello()
await clientB.hello()

await ok('两边都能登记到中转站', () => {
  assert.equal(clientA.status().online, true)
  assert.equal(clientB.status().online, true)
})

await ok('A 寄一封，B 能收到并验签通过', async () => {
  const sent = await clientA.send({ to: B, body: { kind: 'visit-request', fish: { name: '阿肥' } } })
  assert.equal(sent.queued, false)
  const polled = await clientB.poll()
  assert.equal(polled.accepted, 1)
  assert.equal(polled.rejected, 0)
  assert.equal(received.length, 1)
  assert.equal(received[0].from, A)
  assert.equal(received[0].to, B)
  assert.equal(received[0].body.fish.name, '阿肥')
})

await ok('信箱取走即删：再 poll 一次没有新信', async () => {
  const polled = await clientB.poll()
  assert.equal(polled.accepted, 0)
  assert.equal(received.length, 1)
})

await ok('伪造的发信人会被收信方拒掉', async () => {
  // 用 B 自己的私钥冒充 A 发信：中转站照送，B 验签时过不去。
  const forged = sealEnvelope(keyB.privateKey, { from: A, to: B, body: { kind: 'visit-request' } })
  const response = await fetch(`${base}/v1/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: B, envelope: forged }),
  })
  assert.equal(response.status, 200)
  const polled = await clientB.poll()
  assert.equal(polled.accepted, 0)
  assert.equal(polled.rejected, 1)
  assert.equal(received.length, 1)
})

await ok('改过正文的信封也会被拒', async () => {
  const env = sealEnvelope(keyA.privateKey, { from: A, to: B, body: { kind: 'visit-request', fish: { name: '阿肥' } } })
  env.body.fish.name = '冒名顶替'
  await fetch(`${base}/v1/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: B, envelope: env }),
  })
  const polled = await clientB.poll()
  assert.equal(polled.rejected, 1)
  assert.equal(received.length, 1)
})

await ok('信封和收信塘号对不上，中转站直接拒收', async () => {
  const env = sealEnvelope(keyA.privateKey, { from: A, to: '999999', body: { kind: 'x' } })
  const response = await fetch(`${base}/v1/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: B, envelope: env }),
  })
  assert.equal(response.status, 400)
})

await ok('中转站查不到塘号就 404', async () => {
  const response = await fetch(`${base}/v1/peers/987654`)
  assert.equal(response.status, 404)
})

await ok('连不上中转站时，信留在本机 outbox 里', async () => {
  const offline = createRelayClient({
    url: 'http://127.0.0.1:9',
    code: '303030',
    endpoint: 'http://10.0.0.3:11834',
    keyPair: createPondKeyPair(),
  })
  const sent = await offline.send({ to: B, body: { kind: 'visit-request' } })
  assert.equal(sent.ok, true)
  assert.equal(sent.queued, true)
  assert.equal(offline.outbox.length, 1)
  assert.equal(offline.status().online, false)
})

await new Promise((resolve) => server.close(resolve))
console.log(`\n${passed} 项全部通过`)

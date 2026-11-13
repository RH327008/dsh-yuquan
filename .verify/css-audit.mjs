// 找出 JSX 里用到、但 CSS 里没有定义样式的 class，顺手列出 CSS 里定义了却没人用的。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const used = new Set()
const classAttr = /className:\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g
for (const match of source.matchAll(classAttr)) {
  const raw = match[1] || match[2] || match[3] || ''
  for (const token of raw.split(/\s+/)) {
    if (!token) continue
    if (token.includes('${')) continue
    used.add(token)
  }
}

const cssIndex = source.lastIndexOf('const CSS =')
const cssText = source.slice(cssIndex)
const defined = new Set()
for (const match of cssText.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(match[1])

const missing = [...used].filter((name) => !defined.has(name)).sort()
const unused = [...defined].filter((name) => !used.has(name)).sort()

console.log('used:', used.size, 'defined:', defined.size)
console.log('MISSING(' + missing.length + '):', missing.join(' '))
console.log('UNUSED(' + unused.length + '):', unused.join(' '))

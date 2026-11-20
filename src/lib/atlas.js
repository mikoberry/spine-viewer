// Spine 图集文本的内存修正工具。
// 有些资源（例如 BD2 的 3.8 模型）把 atlas 写成 4096×4096，但 PNG 实际只有
// 2048×2048。运行时按 atlas 声明的坐标取 UV，贴图会错位/错片；这里按真实
// 图片尺寸重写页面 size 和区域坐标，不改动磁盘上的原始资源。

const PAGE_LINE = /^([^\s:][^\r\n]*\.(?:png|jpe?g|webp))[ \t]*$/i
const VALUE_LINE = /^(\s*)(size|xy|orig|offset):\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/i

/** 图集页名里的反斜杠在浏览器 URL 里无效，统一成正斜杠。 */
export function normalizeAtlasPath(value) {
  return String(value || '').replace(/\\/g, '/').trim()
}

/** 取出图集里所有贴图页名（已规范化）。 */
export function atlasPageNames(text) {
  const names = []
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(PAGE_LINE)
    if (match) names.push(normalizeAtlasPath(match[1]))
  }
  return names
}

/**
 * 按实际贴图尺寸重写图集文本。
 * sizes 可以是 Map，也可以是普通对象，键为规范化后的页名。
 * 尺寸一致时尽量原样返回，避免影响正常资源。
 */
export function rescaleAtlasText(text, sizes) {
  const sizeOf = (name) => sizes instanceof Map ? sizes.get(name) : sizes?.[name]
  let currentPage = null
  let pageSizeSeen = false
  let scaleX = 1
  let scaleY = 1

  return String(text).replace(/\r\n/g, '\n').split('\n').map((line) => {
    const pageMatch = line.match(PAGE_LINE)
    if (pageMatch) {
      currentPage = normalizeAtlasPath(pageMatch[1])
      pageSizeSeen = false
      scaleX = 1
      scaleY = 1
      return line.replace(/\\/g, '/')
    }

    const match = line.match(VALUE_LINE)
    if (!match || !currentPage) return line
    const [, indent, key, rawX, rawY] = match

    if (key.toLowerCase() === 'size' && !pageSizeSeen) {
      pageSizeSeen = true
      const declaredWidth = Number(rawX)
      const declaredHeight = Number(rawY)
      const actual = sizeOf(currentPage)
      if (!actual || !actual.width || !actual.height || !declaredWidth || !declaredHeight) return line
      scaleX = actual.width / declaredWidth
      scaleY = actual.height / declaredHeight
      if (scaleX === 1 && scaleY === 1) return line
      return `${indent}size: ${actual.width},${actual.height}`
    }

    if (!pageSizeSeen || (scaleX === 1 && scaleY === 1)) return line
    const x = Math.round(Number(rawX) * scaleX)
    const y = Math.round(Number(rawY) * scaleY)
    return `${indent}${key}: ${x}, ${y}`
  }).join('\n')
}

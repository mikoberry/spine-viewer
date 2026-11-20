// 递归扫描 model-library/，把每个 .skel / .json 骨骼 + 同名 .atlas 变成一条模型记录。
// Vite 中间件和 `npm run model:list` 共用这份逻辑，避免两边规则走偏。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i
const PAGE_LINE = /^[^\s:][^\r\n]*\.(?:png|jpe?g|webp)\s*$/i
const SKELETON_EXT = /\.(skel|json)$/i
export const SUPPORTED_SPINE_VERSIONS = ['3.8', '4.1', '4.2']

export const DEFAULT_LIBRARY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'model-library',
)

function posix(relative) {
  return relative.split(path.sep).join('/')
}

function prettify(name) {
  return String(name).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function fileUrl(source) {
  return `/models/${source.split('/').map(encodeURIComponent).join('/')}`
}

function collectDirs(root) {
  const dirs = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    dirs.push(dir)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) stack.push(path.join(dir, entry.name))
    }
  }
  return dirs.sort((a, b) => a.localeCompare(b))
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
}

function looksLikeSkeletonJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Boolean(parsed && Array.isArray(parsed.bones) && parsed.skeleton)
  } catch {
    return false
  }
}

// 版本串以「长度字节 + ASCII 文本 + NUL」存在头部，但不同代的哈希头长度不同：
// 4.x 是 8 字节校验和（长度在偏移 8），3.x 先写一段哈希字符串（长度在更后面）。
// 与其猜偏移，不如扫前 64 字节里形如 x.y.z 的长度前缀字符串。
function versionFromHead(head) {
  for (let index = 1; index < head.length; index++) {
    const length = head[index]
    if (length < 5 || length > 12 || index + length > head.length) continue
    const full = head.subarray(index + 1, index + length).toString('ascii')
    if (/^\d+\.\d+\.\d+$/.test(full)) return { full, major: full.slice(0, 3) }
  }
  return { full: '', major: '' }
}

function readSpineVersion(file, kind) {
  try {
    if (kind === 'json') {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const full = typeof parsed?.skeleton?.spine === 'string' ? parsed.skeleton.spine : ''
      return /^\d+\.\d+\.\d+$/.test(full) ? { full, major: full.slice(0, 3) } : { full: '', major: '' }
    }
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(64)
    const read = fs.readSync(fd, head, 0, head.length, 0)
    fs.closeSync(fd)
    return versionFromHead(head.subarray(0, read))
  } catch {
    return { full: '', major: '' }
  }
}

function readAtlasPages(atlasFile) {
  const text = fs.readFileSync(atlasFile, 'utf8')
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => PAGE_LINE.test(line))
}

// 背景图需要知道原始宽高比（"保持比例"和"适应/铺满"预设都要用），
// 从文件头读即可，不必等浏览器把图片下载下来。
function readImageSize(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(64)
    const read = fs.readSync(fd, head, 0, head.length, 0)
    fs.closeSync(fd)
    const b = head.subarray(0, read)
    if (b.length < 24) return null

    if (b[0] === 0x89 && b.subarray(1, 4).toString('ascii') === 'PNG' && b.subarray(12, 16).toString('ascii') === 'IHDR') {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    }
    if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
      const chunk = b.subarray(12, 16).toString('ascii')
      if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      const buf = fs.readFileSync(file)
      let offset = 2
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset++; continue }
        const marker = buf[offset + 1]
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
          offset += marker === 0xff ? 1 : 2
          continue
        }
        const length = buf.readUInt16BE(offset + 2)
        const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
        if (isSof) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
        offset += 2 + length
      }
    }
  } catch {
    return null
  }
  return null
}

function scanDir(libraryDir, dir) {
  const files = listFiles(dir)
  const skeletons = files.filter(
    (file) => SKELETON_EXT.test(file) && (!/\.json$/i.test(file) || looksLikeSkeletonJson(path.join(dir, file))),
  )
  const atlases = files.filter((file) => /\.atlas$/i.test(file))
  const models = []
  const relativeDir = posix(path.relative(libraryDir, dir))
  const segments = relativeDir === '' ? [] : relativeDir.split('/')

  for (const skeletonFile of skeletons) {
    const stem = skeletonFile.replace(SKELETON_EXT, '')
    const atlasFile =
      atlases.find((file) => file.toLowerCase() === `${stem.toLowerCase()}.atlas`) ||
      (atlases.length === 1 ? atlases[0] : '')
    if (!atlasFile) continue

    const issues = []
    const pages = []
    for (const page of readAtlasPages(path.join(dir, atlasFile))) {
      const name = page.split(/[\\/]/).pop()
      const match = files.find((file) => file.toLowerCase() === name.toLowerCase())
      if (!match) {
        issues.push(`图集页缺失：${page}`)
        continue
      }
      const source = posix(path.relative(libraryDir, path.join(dir, match)))
      pages.push({ file: match, url: fileUrl(source) })
    }
    if (!pages.length) issues.push('图集没有可用贴图页')

    const skeletonAbs = path.join(dir, skeletonFile)
    const kind = /\.json$/i.test(skeletonFile) ? 'json' : 'binary'
    const version = readSpineVersion(skeletonAbs, kind)
    if (!version.major) issues.push('无法识别 Spine 版本')
    else if (!SUPPORTED_SPINE_VERSIONS.includes(version.major)) {
      issues.push(`不支持的 Spine 版本 ${version.full}（已安装 ${SUPPORTED_SPINE_VERSIONS.join(' / ')}）`)
    }

    const skeletonSource = posix(path.relative(libraryDir, skeletonAbs))
    const atlasSource = posix(path.relative(libraryDir, path.join(dir, atlasFile)))
    const id = `${relativeDir ? `${relativeDir}/` : ''}${stem}`
    models.push({
      id,
      name: prettify(stem),
      file: skeletonFile,
      group: segments[0] || 'root',
      folder: relativeDir,
      spineVersion: version.major,
      spineVersionFull: version.full,
      kind,
      skeletonUrl: fileUrl(skeletonSource),
      atlasUrl: fileUrl(atlasSource),
      pages,
      issues,
    })
  }
  return models
}

// 图集页本身也是 PNG，不能混进背景候选；按模型清单里实际引用的页名排除。
function collectBackgrounds(libraryDir, dirs, models) {
  const atlasPages = new Set()
  for (const model of models) {
    for (const page of model.pages) atlasPages.add(page.file.toLowerCase())
  }
  const backgrounds = []
  for (const dir of dirs) {
    const relativeDir = posix(path.relative(libraryDir, dir))
    for (const file of listFiles(dir)) {
      if (!IMAGE_EXT.test(file) || atlasPages.has(file.toLowerCase())) continue
      const source = posix(path.relative(libraryDir, path.join(dir, file)))
      const size = readImageSize(path.join(dir, file))
      backgrounds.push({
        id: source,
        name: prettify(file.replace(IMAGE_EXT, '')),
        file,
        group: relativeDir.split('/')[0] || 'root',
        url: fileUrl(source),
        width: size?.width || 0,
        height: size?.height || 0,
      })
    }
  }
  return backgrounds.sort((a, b) => a.id.localeCompare(b.id))
}

/** 一次扫描同时产出模型与背景候选。 */
export function collectLibrary(libraryDir = DEFAULT_LIBRARY_DIR) {
  if (!fs.existsSync(libraryDir)) return { models: [], backgrounds: [] }
  const dirs = collectDirs(libraryDir)
  const models = dirs
    .flatMap((dir) => scanDir(libraryDir, dir))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { models, backgrounds: collectBackgrounds(libraryDir, dirs, models) }
}

/** 保留旧签名，给 `npm run model:list` 和只看模型的调用方使用。 */
export function scanModelLibrary(libraryDir = DEFAULT_LIBRARY_DIR) {
  return collectLibrary(libraryDir).models
}

// CLI 自检：`npm run model:list`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_LIBRARY_DIR
  const models = scanModelLibrary(root)
  console.log(`${root}\n${models.length} 个模型\n`)
  for (const model of models) {
    console.log(
      `  ${model.id}  [Spine ${model.spineVersionFull || '?'} · ${model.pages.length} 页${
        model.issues.length ? ` · ${model.issues.join('; ')}` : ''
      }]`,
    )
  }
}

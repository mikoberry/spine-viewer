// 拖入本地文件夹后，把里面的 Spine 资源变成可直接渲染的模型清单。
// 资源不落盘：每个文件生成 blob URL，图集页名改写成对应 blob URL。
// 返回的 urls 由调用方在清除/卸载时统一 revoke。

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i
const SKELETON_EXT = /\.(skel|json)$/i
const ATLAS_EXT = /\.atlas$/i
const PAGE_LINE = /^[^\s:][^\r\n]*\.(?:png|jpe?g|webp)[ \t]*$/i

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function dirname(value) {
  const index = value.lastIndexOf('/')
  return index < 0 ? '' : value.slice(0, index)
}

function basename(value) {
  return value.slice(value.lastIndexOf('/') + 1)
}

function stem(value) {
  return value.replace(/\.[^.]+$/, '')
}

function prettify(value) {
  return String(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function readEntry(entry, prefix, output) {
  return new Promise((resolve) => {
    if (!entry) return resolve()
    if (entry.isFile) {
      entry.file(
        (file) => {
          output.push({ path: prefix ? `${prefix}/${entry.name}` : entry.name, file })
          resolve()
        },
        () => resolve(),
      )
      return
    }
    if (!entry.isDirectory) return resolve()
    const directory = prefix ? `${prefix}/${entry.name}` : entry.name
    const reader = entry.createReader()
    const readBatch = () => reader.readEntries(async (children) => {
      if (!children.length) return resolve()
      await Promise.all(children.map((child) => readEntry(child, directory, output)))
      readBatch()
    }, () => resolve())
    readBatch()
  })
}

/** 从 drop 事件或 <input webkitdirectory> 收集 { path, file }。 */
export async function collectDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer?.items || [])
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean)
  if (entries.length) {
    const output = []
    await Promise.all(entries.map((entry) => readEntry(entry, '', output)))
    if (output.length) return output
  }
  return Array.from(dataTransfer?.files || [])
    .filter((file) => !file.name.includes('.') || IMAGE_EXT.test(file.name) || SKELETON_EXT.test(file.name) || ATLAS_EXT.test(file.name))
    .map((file) => ({ path: normalizePath(file.webkitRelativePath || file.name), file }))
}

function versionFromHead(head) {
  for (let index = 1; index < head.length; index++) {
    const length = head[index]
    if (length < 5 || length > 12 || index + length > head.length) continue
    const full = String.fromCharCode(...head.subarray(index + 1, index + length))
    if (/^\d+\.\d+\.\d+$/.test(full)) return full
  }
  return ''
}

async function readSkeletonInfo(file) {
  try {
    if (/\.json$/i.test(file.name)) {
      const parsed = JSON.parse(await file.text())
      const full = typeof parsed?.skeleton?.spine === 'string' ? parsed.skeleton.spine : ''
      return {
        isSpine: Boolean(parsed && Array.isArray(parsed.bones) && parsed.skeleton),
        kind: 'json',
        full: /^\d+\.\d+\.\d+$/.test(full) ? full : '',
      }
    }
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())
    const full = versionFromHead(head)
    return { isSpine: Boolean(full), kind: 'binary', full }
  } catch {
    return { isSpine: false, kind: 'binary', full: '' }
  }
}

function resolvePage(pageName, atlasPath, files) {
  const name = normalizePath(pageName)
  const preferred = dirname(atlasPath) ? `${dirname(atlasPath)}/${name}` : name
  const exact = files.find((item) => item.path.toLowerCase() === preferred.toLowerCase())
  if (exact) return exact
  const lowered = name.toLowerCase()
  const suffix = files.find((item) => {
    const path = item.path.toLowerCase()
    return path === lowered || path.endsWith(`/${lowered}`)
  })
  if (suffix) return suffix
  const base = basename(lowered)
  return files.find((item) => basename(item.path).toLowerCase() === base)
}

function probeImageSize(url) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve(null)
    image.src = url
  })
}

export async function buildLocalLibrary(entries, { group = '拖入' } = {}) {
  const files = entries.map(({ path, file }) => ({ path: normalizePath(path), file }))
  const urls = []
  const cache = new Map()
  const urlFor = (item) => {
    if (!cache.has(item.path)) {
      const url = URL.createObjectURL(item.file)
      urls.push(url)
      cache.set(item.path, url)
    }
    return cache.get(item.path)
  }

  const byDir = new Map()
  for (const item of files) {
    const dir = dirname(item.path)
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(item)
  }

  const usedImages = new Set()
  const models = []
  for (const [dir, dirFiles] of byDir) {
    const skeletons = []
    for (const item of dirFiles) {
      if (!SKELETON_EXT.test(item.path)) continue
      const info = await readSkeletonInfo(item.file)
      if (info.isSpine) skeletons.push({ ...item, ...info })
    }
    const atlases = dirFiles.filter((item) => ATLAS_EXT.test(item.path))
    if (!skeletons.length || !atlases.length) continue

    for (const skeleton of skeletons) {
      const fileStem = stem(basename(skeleton.path))
      const atlas = atlases.find((item) => stem(basename(item.path)).toLowerCase() === fileStem.toLowerCase())
        || (atlases.length === 1 ? atlases[0] : null)
      if (!atlas) continue

      const text = await atlas.file.text()
      const pages = []
      const pageUrls = {}
      const issues = []
      for (const line of text.split(/\r?\n/)) {
        const pageName = line.trim()
        if (!PAGE_LINE.test(pageName)) continue
        const match = resolvePage(pageName, atlas.path, files)
        if (!match) {
          issues.push(`图集页缺失：${pageName}`)
          continue
        }
        usedImages.add(match.path)
        pages.push({ file: basename(match.path), url: urlFor(match) })
        // 页名保持原样：Spine 解析器会把含冒号的 blob URL 当成头部字段跳过。
        pageUrls[pageName] = urlFor(match)
      }
      if (!pages.length) issues.push('图集没有可用贴图页')
      if (!skeleton.full) issues.push('无法识别 Spine 版本')
      else if (!['3.8', '4.1', '4.2'].includes(skeleton.full.slice(0, 3))) {
        issues.push(`不支持的 Spine 版本 ${skeleton.full}（已安装 3.8 / 4.1 / 4.2）`)
      }

      models.push({
        id: `local:${skeleton.path}`,
        name: prettify(fileStem),
        file: basename(skeleton.path),
        group,
        folder: dir || '(拖入根目录)',
        spineVersion: skeleton.full.slice(0, 3),
        spineVersionFull: skeleton.full,
        kind: skeleton.kind,
        skeletonUrl: urlFor(skeleton),
        atlasUrl: urlFor(atlas),
        pages,
        pageUrls,
        issues,
        local: true,
      })
    }
  }

  const backgrounds = []
  for (const item of files) {
    if (!IMAGE_EXT.test(item.path) || usedImages.has(item.path)) continue
    const url = urlFor(item)
    const size = await probeImageSize(url)
    backgrounds.push({
      id: `local-bg:${item.path}`,
      name: prettify(stem(basename(item.path))),
      file: basename(item.path),
      group,
      url,
      width: size?.width || 0,
      height: size?.height || 0,
      local: true,
    })
  }

  models.sort((a, b) => a.id.localeCompare(b.id))
  backgrounds.sort((a, b) => a.id.localeCompare(b.id))
  return { models, backgrounds, urls }
}

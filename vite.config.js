import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectLibrary, DEFAULT_LIBRARY_DIR } from './scripts/scan-model-library.mjs'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
let libraryRoot = DEFAULT_LIBRARY_DIR

function contentType(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.atlas' || ext === '.txt') return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

// 资源不走 Vite 的静态打包：它们可能很大，而且随时会往 model-library 里加新模型。
// 两个中间件在 dev / preview 下都挂上，保证构建后的预览也能加载模型。
function attach(server) {
  server.middlewares.use('/api/models', (req, res, next) => {
    if (req.method !== 'GET') return next()
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(collectLibrary(libraryRoot)))
  })

  server.middlewares.use('/models', (req, res, next) => {
    if (req.method !== 'GET') return next()
    let relative
    try {
      relative = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '')
    } catch {
      res.statusCode = 400
      return res.end('Bad Request')
    }
    const file = path.resolve(libraryRoot, relative)
    if (file !== libraryRoot && !file.startsWith(libraryRoot + path.sep)) {
      res.statusCode = 403
      return res.end('Forbidden')
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next()
    res.setHeader('Content-Type', contentType(file))
    res.setHeader('Cache-Control', 'no-store')
    fs.createReadStream(file).pipe(res)
  })
}

function modelApi() {
  return {
    name: 'spine-model-api',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, projectRoot, '') }
  const configured = env.SPINE_MODEL_DIR || process.env.SPINE_MODEL_DIR
  libraryRoot = configured ? path.resolve(projectRoot, configured) : DEFAULT_LIBRARY_DIR
  // GitHub Pages 项目站点部署在 /<repo>/ 下；本地开发仍用根路径。
  // Actions 自带 GITHUB_REPOSITORY，本地也可用 VITE_BASE 覆盖。
  const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1]
  const base = env.VITE_BASE || (repoName ? `/${repoName}/` : '/')
  console.log(
    fs.existsSync(libraryRoot)
      ? `[spine-viewer] 模型目录：${libraryRoot}`
      : `[spine-viewer] 未找到模型目录：${libraryRoot}（在 .env 里用 SPINE_MODEL_DIR 指定）`,
  )

  return {
    base,
    plugins: [react(), modelApi()],
    server: { port: 5173, strictPort: false },
    preview: { port: 4173, strictPort: false },
  }
})

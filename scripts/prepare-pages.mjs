// GitHub Pages 是纯静态托管，没有 Vite 的 /api/models 与 /models 中间件。
// 构建后把模型清单写成 dist/models.json，并把整个 model-library 复制到 dist/models。
// 前端在正常开发环境仍走 /api/models，静态环境回落到 models.json。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectLibrary, DEFAULT_LIBRARY_DIR } from './scan-model-library.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configured = process.env.SPINE_MODEL_DIR
const libraryDir = configured ? path.resolve(projectRoot, configured) : DEFAULT_LIBRARY_DIR
const distDir = path.join(projectRoot, 'dist')
const targetModelsDir = path.join(distDir, 'models')

if (!fs.existsSync(libraryDir)) {
  throw new Error(`模型目录不存在：${libraryDir}`)
}

fs.mkdirSync(distDir, { recursive: true })
fs.rmSync(targetModelsDir, { recursive: true, force: true })
fs.cpSync(libraryDir, targetModelsDir, { recursive: true })

const library = collectLibrary(libraryDir)
fs.writeFileSync(path.join(distDir, 'models.json'), JSON.stringify(library), 'utf8')
fs.writeFileSync(path.join(distDir, '.nojekyll'), '')

console.log(`[pages] 静态模型：${library.models.length} 个 / 背景 ${library.backgrounds.length} 张`)
console.log(`[pages] 资源目录：${targetModelsDir}`)

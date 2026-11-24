// 单个 Spine 模型（atlas + 贴图 + 骨骼）的加载流程。抽成独立模块后，画面里
// 同时存在多个模型时每个模型都走同一套加载逻辑，只是共用同一个 WebGL 上下文。

import { atlasPageNames, normalizeAtlasPath, rescaleAtlasText } from './atlas.js'
import { updatePose } from './runtimes.js'

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`贴图加载失败：${url}`))
    image.src = url
  })
}

/**
 * 加载一个模型并返回绘制所需的运行时对象。
 * 会顺带把骨架摆到 setup pose 并更新一次世界变换，方便调用方直接量包围盒。
 */
export async function loadSpineModel(gl, runtime, model) {
  const atlasText = await fetch(model.atlasUrl).then((response) => {
    if (!response.ok) throw new Error(`atlas 加载失败：${response.status}`)
    return response.text()
  })
  const atlasUrl = new URL(model.atlasUrl, window.location.href)
  // 拖入的本地资源用页名映射 blob URL；blob URL 含冒号，不能当相对路径拼。
  const localPageUrls = new Map(Object.entries(model.pageUrls || {})
    .map(([name, url]) => [normalizeAtlasPath(name), url]))
  const imageUrlFor = (name) => localPageUrls.get(name) || new URL(name, atlasUrl).href
  const pageNames = atlasPageNames(atlasText)
  const images = new Map(await Promise.all(pageNames.map(async (name) => [
    name,
    await loadImage(imageUrlFor(name)),
  ])))
  // 部分 3.8 资源的 atlas 声明尺寸与 PNG 实际尺寸不一致，先按真实尺寸
  // 重写页面与区域坐标，否则运行时会按错误 UV 取到错位的贴图。
  const imageSizes = new Map(Array.from(images, ([name, image]) => [
    name,
    { width: image.naturalWidth, height: image.naturalHeight },
  ]))
  const resolvedAtlasText = rescaleAtlasText(atlasText, imageSizes)

  let atlas
  if (runtime.legacy) {
    // 3.8 的 TextureAtlas 要求构造时就给纹理加载器，且没有 page.setTexture。
    const textures = new Map(Array.from(images, ([name, image]) => [
      name,
      new runtime.GLTexture(gl, image),
    ]))
    atlas = new runtime.TextureAtlas(resolvedAtlasText, (name) => textures.get(normalizeAtlasPath(name)))
  } else {
    atlas = new runtime.TextureAtlas(resolvedAtlasText)
    await Promise.all(atlas.pages.map(async (page) => {
      const name = normalizeAtlasPath(page.name)
      const image = images.get(name) || await loadImage(imageUrlFor(name))
      page.setTexture(new runtime.GLTexture(gl, image))
    }))
  }

  const response = await fetch(model.skeletonUrl)
  if (!response.ok) throw new Error(`骨骼加载失败：${response.status}`)
  const loader = new runtime.AtlasAttachmentLoader(atlas)
  let skeletonData
  if (model.kind === 'json') {
    skeletonData = new runtime.SkeletonJson(loader).readSkeletonData(await response.json())
  } else {
    skeletonData = new runtime.SkeletonBinary(loader).readSkeletonData(new Uint8Array(await response.arrayBuffer()))
  }

  const skeleton = new runtime.Skeleton(skeletonData)
  const stateData = new runtime.AnimationStateData(skeletonData)
  stateData.defaultMix = 0.2
  const state = new runtime.AnimationState(stateData)
  const names = skeletonData.animations.map((animation) => animation.name)
  skeleton.setToSetupPose()
  updatePose(runtime, skeleton, 0, { reset: true })

  // 3.8 运行时不解析 atlas 的 pma 字段；这批资源按预乘 alpha 导出，
  // 与 idleangels 项目保持一致，绘制时固定传 true。
  const pma = runtime.legacy || (atlas.pages.length > 0 && atlas.pages.every((page) => page.pma))

  return { atlas, skeleton, state, names, pma }
}

import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { atlasPageNames, normalizeAtlasPath, rescaleAtlasText } from '../lib/atlas.js'
import { computeFrameRect, EXPORT_HEIGHT, EXPORT_WIDTH } from '../lib/framing.js'
import { spineRuntime, updatePose } from '../lib/runtimes.js'
import BackgroundLayer from './BackgroundLayer.jsx'
import FramingOverlay from './FramingOverlay.jsx'
import PlaybackControls from './PlaybackControls.jsx'

const ZOOM_BUTTON_STEP = 1
const BLEND_LABELS = { 0: 'Normal', 1: 'Additive', 2: 'Multiply', 3: 'Screen' }
// 光效片可能比人物大几十倍，取景时单独判断，避免人物被压成一小点。
const EFFECT_SLOT = /(^|[/_])(fx|effect)[/_]|(guangquan|guangyun)/i

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`贴图加载失败：${url}`))
    image.src = url
  })
}

function isEffectSlot(slot, attachment) {
  return [slot.data.name, attachment?.name, slot.bone?.data?.name]
    .some((name) => typeof name === 'string' && EFFECT_SLOT.test(name))
}

function worldVerticesOf(runtime, slot, attachment) {
  // 3.8 的 RegionAttachment 仍按 bone 计算，4.x 改成了按 slot，签名也不同。
  if (runtime.legacy && runtime.RegionAttachment && attachment instanceof runtime.RegionAttachment) {
    const vertices = new Float32Array(8)
    attachment.computeWorldVertices(slot.bone, vertices, 0, 2)
    return vertices
  }
  const length = attachment?.worldVerticesLength
  if (!length) return null
  const vertices = new Float32Array(length)
  attachment.computeWorldVertices(slot, 0, length, vertices, 0, 2)
  return vertices
}

function boundsOf(runtime, skeleton, includeEffects) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let found = 0
  for (const slot of skeleton.slots) {
    const attachment = slot.getAttachment()
    if (!attachment) continue
    if (!includeEffects && (slot.data.blendMode !== 0 || isEffectSlot(slot, attachment))) continue
    const vertices = worldVerticesOf(runtime, slot, attachment)
    if (!vertices) continue
    for (let i = 0; i < vertices.length; i += 2) {
      minX = Math.min(minX, vertices[i])
      maxX = Math.max(maxX, vertices[i])
      minY = Math.min(minY, vertices[i + 1])
      maxY = Math.max(maxY, vertices[i + 1])
    }
    found++
  }
  if (!found || !Number.isFinite(minX) || maxX - minX <= 0) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function pickBounds(runtime, skeleton) {
  let full
  if (typeof skeleton.getBoundsRect === 'function') {
    full = skeleton.getBoundsRect()
  } else {
    // 3.8 只有 getBounds(offset, size, temp)
    const offset = new runtime.Vector2()
    const size = new runtime.Vector2()
    skeleton.getBounds(offset, size, [])
    full = { x: offset.x, y: offset.y, width: size.x, height: size.y }
  }
  if (!Number.isFinite(full.width) || full.width <= 0) return full
  const core = boundsOf(runtime, skeleton, false)
  if (!core) return full
  const ratio = Math.max(full.width / Math.max(core.width, 1), full.height / Math.max(core.height, 1))
  return ratio > 2.5 ? core : full
}

function fitCamera(runtime, camera, canvas, loaded, resetPosition = true) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const item of loaded) {
    updatePose(runtime, item.skeleton, 0, { reset: true })
    const bounds = pickBounds(runtime, item.skeleton)
    if (!Number.isFinite(bounds.width) || bounds.width <= 0) continue
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.width)
    maxY = Math.max(maxY, bounds.y + bounds.height)
  }
  if (minX === Infinity) { minX = -100; minY = -100; maxX = 100; maxY = 100 }

  const width = Math.max(maxX - minX, 1)
  const height = Math.max(maxY - minY, 1)
  const rect = computeFrameRect(canvas.width, canvas.height)
  camera.setViewport(canvas.width, canvas.height)
  if (resetPosition) camera.position.set((minX + maxX) / 2, (minY + maxY) / 2, 0)
  camera.update()
  // 按取景框而非整块画布取景，模型才会完整落在虚线框里
  return Math.max(width / rect.w, height / rect.h) * 1.12
}

const SpineViewer = forwardRef(function SpineViewer({ model, background, backgroundTransform, showFrame = true, frameOnly = false }, ref) {
  const rootRef = useRef(null)
  const canvasRef = useRef(null)
  const cameraRef = useRef(null)
  const loadedRef = useRef([])
  const runtimeRef = useRef(null)
  const exportApiRef = useRef(null)
  const exportingRef = useRef(false)
  const fitZoomRef = useRef(1)
  const viewZoomRef = useRef(100)
  const playingRef = useRef(true)
  const speedRef = useRef(1)
  const hiddenRef = useRef(new Set())
  const pendingDeltaRef = useRef(0)

  const [animations, setAnimations] = useState([])
  const [current, setCurrent] = useState('')
  const [slots, setSlots] = useState([])
  const [hidden, setHidden] = useState([])
  const [slotsOpen, setSlotsOpen] = useState(false)
  const [slotQuery, setSlotQuery] = useState('')
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [error, setError] = useState('')

  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { speedRef.current = speed }, [speed])

  useImperativeHandle(ref, () => ({
    kind: 'spine',
    getCanvas: () => canvasRef.current,
    getDuration: () => exportApiRef.current?.duration() || 0,
    getName: () => exportApiRef.current?.name() || '',
    prepare: (size) => exportApiRef.current?.prepare(size),
    step: (dt) => exportApiRef.current?.step(dt),
    finish: () => { exportingRef.current = false; exportApiRef.current?.finish() },
  }), [])

  function applyViewZoom(next, anchor = null) {
    const camera = cameraRef.current
    if (!camera) return
    const value = Math.min(2000, Math.max(10, next))
    let before = null
    if (anchor && camera.screenToWorld) {
      before = camera.screenToWorld(new runtimeRef.current.Vector3(anchor.x, anchor.y, 0), camera.viewportWidth, camera.viewportHeight)
    }
    viewZoomRef.current = value
    camera.zoom = fitZoomRef.current / (value / 100)
    camera.update()
    if (before) {
      const after = camera.screenToWorld(new runtimeRef.current.Vector3(anchor.x, anchor.y, 0), camera.viewportWidth, camera.viewportHeight)
      camera.position.x += before.x - after.x
      camera.position.y += before.y - after.y
      camera.update()
    }
    setZoom(Math.round(value))
  }

  function resetView() {
    const camera = cameraRef.current
    const canvas = canvasRef.current
    const runtime = runtimeRef.current
    if (!camera || !canvas || !runtime || exportingRef.current) return
    fitZoomRef.current = fitCamera(runtime, camera, canvas, loadedRef.current, true)
    applyViewZoom(100)
  }

  useEffect(() => {
    let disposed = false
    let frameId = 0
    let cleanup = () => {}

    setError('')
    setAnimations([])
    setCurrent('')
    setSlots([])
    setHidden([])
    hiddenRef.current = new Set()
    setSlotQuery('')
    viewZoomRef.current = 100
    setZoom(100)

    ;(async () => {
      try {
        const runtime = spineRuntime(model.spineVersion)
        if (!runtime) throw new Error(`不支持的 Spine 版本：${model.spineVersionFull || '未知'}（需要 3.8 / 4.1 / 4.2）`)
        const canvas = canvasRef.current
        // 画布透明，背景由 HTML 图层负责；WebCodecs 导出时先在 2D 画布画背景再叠这层。
        const gl = canvas.getContext('webgl', {
          alpha: true,
          premultipliedAlpha: true,
          antialias: true,
          preserveDrawingBuffer: true,
        })
        if (!gl) throw new Error('WebGL 不可用')

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
        if (names[0]) state.setAnimation(0, names[0], true)
        skeleton.setToSetupPose()
        updatePose(runtime, skeleton, 0, { reset: true })

        // 3.8 运行时不解析 atlas 的 pma 字段；这批资源按预乘 alpha 导出，
        // 与 idleangels 项目保持一致，绘制时固定传 true。
        const pma = runtime.legacy || (atlas.pages.length > 0 && atlas.pages.every((page) => page.pma))
        const loaded = [{ atlas, skeleton, state, names, pma }]
        loadedRef.current = loaded
        runtimeRef.current = runtime

        const slotMeta = new Map()
        for (const slot of skeleton.slots) {
          if (!slotMeta.has(slot.data.name)) {
            slotMeta.set(slot.data.name, { name: slot.data.name, blend: slot.data.blendMode })
          }
        }
        setSlots(Array.from(slotMeta.values()))
        setAnimations(names)
        setCurrent(names[0] || '')

        const renderer = new runtime.SceneRenderer(canvas, gl)
        const camera = renderer.camera
        cameraRef.current = camera
        let cameraReady = false

        function resize() {
          if (exportingRef.current) return
          const rect = rootRef.current.getBoundingClientRect()
          const ratio = Math.min(window.devicePixelRatio || 1, 2)
          canvas.width = Math.max(1, Math.round(rect.width * ratio))
          canvas.height = Math.max(1, Math.round(rect.height * ratio))
          fitZoomRef.current = fitCamera(runtime, camera, canvas, loaded, !cameraReady)
          cameraReady = true
          applyViewZoom(viewZoomRef.current)
        }
        resize()
        const observer = new ResizeObserver(resize)
        observer.observe(rootRef.current)

        function canvasPoint(event) {
          const rect = canvas.getBoundingClientRect()
          return {
            x: (event.clientX - rect.left) * canvas.width / Math.max(rect.width, 1),
            y: (event.clientY - rect.top) * canvas.height / Math.max(rect.height, 1),
          }
        }
        function onWheel(event) {
          if (exportingRef.current) return
          event.preventDefault()
          applyViewZoom(viewZoomRef.current * Math.exp(-event.deltaY * 0.001), canvasPoint(event))
        }
        let dragging = false
        let lastPoint = null
        function onPointerDown(event) {
          if (exportingRef.current) return
          dragging = true
          lastPoint = { x: event.clientX, y: event.clientY }
          canvas.setPointerCapture(event.pointerId)
          canvas.style.cursor = 'grabbing'
        }
        function onPointerMove(event) {
          if (!dragging || !lastPoint || exportingRef.current) return
          const dx = event.clientX - lastPoint.x
          const dy = event.clientY - lastPoint.y
          lastPoint = { x: event.clientX, y: event.clientY }
          const rect = canvas.getBoundingClientRect()
          const ratio = canvas.width / Math.max(rect.width, 1)
          camera.position.x -= dx * ratio * camera.zoom
          camera.position.y += dy * ratio * camera.zoom
          camera.update()
        }
        function onPointerUp(event) {
          dragging = false
          lastPoint = null
          try { canvas.releasePointerCapture(event.pointerId) } catch { /* noop */ }
          canvas.style.cursor = 'grab'
        }
        canvas.style.cursor = 'grab'
        canvas.addEventListener('wheel', onWheel, { passive: false })
        canvas.addEventListener('pointerdown', onPointerDown)
        canvas.addEventListener('pointermove', onPointerMove)
        canvas.addEventListener('pointerup', onPointerUp)
        canvas.addEventListener('pointercancel', onPointerUp)

        function drawScene() {
          gl.viewport(0, 0, canvas.width, canvas.height)
          gl.clearColor(0, 0, 0, 0)
          gl.clear(gl.COLOR_BUFFER_BIT)
          renderer.begin()
          for (const item of loaded) {
            item.state.apply(item.skeleton)
            updatePose(runtime, item.skeleton, pendingDeltaRef.current)
            const detached = []
            if (hiddenRef.current.size) {
              for (const slot of item.skeleton.slots) {
                if (hiddenRef.current.has(slot.data.name) && slot.attachment) {
                  detached.push([slot, slot.attachment])
                  slot.attachment = null
                }
              }
            }
            renderer.drawSkeleton(item.skeleton, item.pma)
            for (const [slot, attachment] of detached) slot.attachment = attachment
          }
          renderer.end()
        }

        function advance(seconds) {
          pendingDeltaRef.current = seconds
          for (const item of loaded) item.state.update(seconds)
        }

        function frame(now) {
          if (exportingRef.current) return
          const elapsed = Math.min((now - last) / 1000, 0.1)
          last = now
          advance(playingRef.current ? elapsed * speedRef.current : 0)
          drawScene()
          frameId = requestAnimationFrame(frame)
        }
        let last = performance.now()
        frameId = requestAnimationFrame(frame)

        let snapshot = null
        exportApiRef.current = {
          name() {
            const entry = state.getCurrent(0)
            return entry?.animation?.name || names[0] || ''
          },
          duration() {
            const entry = state.getCurrent(0)
            const value = entry?.animation?.duration || 0
            return Number.isFinite(value) ? value : 0
          },
          prepare(size = {}) {
            cancelAnimationFrame(frameId)
            exportingRef.current = true
            const { width = EXPORT_WIDTH, height = EXPORT_HEIGHT } = size
            const rect = computeFrameRect(canvas.width, canvas.height)
            snapshot = { width: canvas.width, height: canvas.height, zoom: camera.zoom, x: camera.position.x, y: camera.position.y }
            canvas.width = width
            canvas.height = height
            camera.setViewport(width, height)
            camera.zoom = snapshot.zoom * rect.w / width
            camera.update()
          },
          step(dtMs) {
            advance(dtMs / 1000)
            drawScene()
          },
          finish() {
            exportingRef.current = false
            snapshot = null
            resize()
            last = performance.now()
            frameId = requestAnimationFrame(frame)
          },
        }

        cleanup = () => {
          observer.disconnect()
          exportApiRef.current = null
          canvas.removeEventListener('wheel', onWheel)
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('pointermove', onPointerMove)
          canvas.removeEventListener('pointerup', onPointerUp)
          canvas.removeEventListener('pointercancel', onPointerUp)
          renderer.dispose()
          atlas.dispose()
          loadedRef.current = []
        }
      } catch (cause) {
        if (!disposed) setError(cause.message || String(cause))
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(frameId)
      cameraRef.current = null
      runtimeRef.current = null
      cleanup()
    }
  }, [model.id])

  function play(name) {
    if (!name) return
    for (const item of loadedRef.current) item.state.setAnimation(0, name, true)
    setCurrent(name)
  }

  function commitHidden(next) {
    hiddenRef.current = new Set(next)
    setHidden(next)
  }

  function toggleSlot(name) {
    commitHidden(hidden.includes(name) ? hidden.filter((item) => item !== name) : [...hidden, name])
  }

  const hiddenSet = new Set(hidden)
  const keyword = slotQuery.trim().toLowerCase()
  const shownSlots = keyword ? slots.filter((slot) => slot.name.toLowerCase().includes(keyword)) : slots

  return (
    <div className="viewer-root" ref={rootRef}>
      <BackgroundLayer source={background} transform={backgroundTransform} />
      <canvas ref={canvasRef} className="viewer-canvas" />
      <FramingOverlay visible={showFrame} frameOnly={frameOnly} />
      <div className="gesture-hint">滚轮缩放 · 拖动移动 · 虚框为导出范围</div>
      {error && <div className="viewer-error">{error}</div>}
      <div className="viewer-toolbar">
        <PlaybackControls
          playing={playing}
          onToggle={() => setPlaying((value) => !value)}
          speed={speed}
          onSpeed={setSpeed}
        />
        <span className="tool-sep" />
        <button onClick={() => applyViewZoom(viewZoomRef.current - ZOOM_BUTTON_STEP)}>缩小</button>
        <span>{zoom}%</span>
        <button onClick={() => applyViewZoom(viewZoomRef.current + ZOOM_BUTTON_STEP)}>放大</button>
        <button title="回到默认取景" onClick={resetView}>复位</button>
        <span className="tool-sep" />
        <button
          className={'slot-toggle' + (slotsOpen ? ' active' : '')}
          title="逐个控制槽位显示"
          onClick={() => setSlotsOpen((value) => !value)}
        >
          槽位
        </button>
      </div>
      {slotsOpen && (
        <div className="slot-panel">
          <div className="slot-panel-head">
            <strong>槽位控制</strong>
            <span className="slot-panel-count">{slots.length} 槽 · 隐藏 {hidden.length}</span>
            <button className="slot-panel-close" title="关闭面板" onClick={() => setSlotsOpen(false)}>×</button>
          </div>
          <div className="slot-panel-actions">
            <button onClick={() => commitHidden([])}>全部显示</button>
            <button onClick={() => commitHidden(slots.map((slot) => slot.name))}>全部隐藏</button>
          </div>
          <input
            className="slot-panel-search"
            value={slotQuery}
            onChange={(event) => setSlotQuery(event.target.value)}
            placeholder="搜索槽位名"
          />
          <div className="slot-panel-list">
            {shownSlots.map((slot) => (
              <div className={'slot-row' + (hiddenSet.has(slot.name) ? ' off' : '')} key={slot.name}>
                <label className="slot-row-main" title={slot.name}>
                  <input type="checkbox" checked={!hiddenSet.has(slot.name)} onChange={() => toggleSlot(slot.name)} />
                  <span className="slot-row-name">{slot.name}</span>
                </label>
                <button className="slot-row-solo" title="只显示这个槽位" onClick={() => commitHidden(slots.filter((item) => item.name !== slot.name).map((item) => item.name))}>仅此</button>
                {slot.blend !== 0 && <span className="slot-row-blend">{BLEND_LABELS[slot.blend] || slot.blend}</span>}
              </div>
            ))}
            {slots.length === 0 && <div className="slot-panel-empty">模型加载完成后显示槽位</div>}
            {slots.length > 0 && shownSlots.length === 0 && <div className="slot-panel-empty">没有匹配的槽位</div>}
          </div>
        </div>
      )}
      <div className="viewer-controls">
        <span className="control-label">动画</span>
        {animations.length === 0 && <span className="hint">无动画</span>}
        {animations.map((name) => (
          <button key={name} className={name === current ? 'active' : ''} onClick={() => play(name)}>{name}</button>
        ))}
      </div>
    </div>
  )
})

export default SpineViewer

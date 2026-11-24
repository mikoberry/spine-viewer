import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { computeFrameRect, EXPORT_HEIGHT, EXPORT_WIDTH } from '../lib/framing.js'
import { loadSpineModel } from '../lib/modelLoader.js'
import { spineRuntime, updatePose } from '../lib/runtimes.js'
import BackgroundLayer from './BackgroundLayer.jsx'
import FramingOverlay from './FramingOverlay.jsx'
import PlaybackControls from './PlaybackControls.jsx'

const ZOOM_BUTTON_STEP = 1
const BLEND_LABELS = { 0: 'Normal', 1: 'Additive', 2: 'Multiply', 3: 'Screen' }
// 光效片可能比人物大几十倍，取景时单独判断，避免人物被压成一小点。
const EFFECT_SLOT = /(^|[/_])(fx|effect)[/_]|(guangquan|guangyun)/i
// 并排布局时模型之间的水平间距，取平均高度的这个比例。
const ROW_GAP_RATIO = 0.08
// 单个模型的缩放范围：太小看不见，太大直接把整屏撑爆
const SCALE_MIN = 0.1
// 上限 1000%，放大观察局部细节用
const SCALE_MAX = 10

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

function measureItems(items) {
  for (const item of items) {
    // 量尺寸时先归零，拿到的包围盒才是模型自身的、不含布局偏移与用户缩放。
    item.skeleton.x = 0
    item.skeleton.y = 0
    item.skeleton.scaleX = 1
    item.skeleton.scaleY = 1
    updatePose(item.runtime, item.skeleton, 0, { reset: true })
    const bounds = pickBounds(item.runtime, item.skeleton)
    const valid = Number.isFinite(bounds.width) && bounds.width > 0 && Number.isFinite(bounds.height)
    item.baseBounds = valid ? bounds : { x: 0, y: 0, width: 100, height: 100 }
  }
  return items
}

/**
 * 每个模型自己的变换（相对布局位置的偏移 + 缩放），按模型 id 保存，
 * 画面里增删模型或切换选中后仍会保留。
 */
function transformOf(transforms, id) {
  let tf = transforms.get(id)
  if (!tf) {
    tf = { x: 0, y: 0, scale: 1 }
    transforms.set(id, tf)
  }
  return tf
}

function applyTransform(item, transforms) {
  const tf = transformOf(transforms, item.model.id)
  item.skeleton.x = item.base.x + tf.x
  item.skeleton.y = item.base.y + tf.y
  item.skeleton.scaleX = tf.scale
  item.skeleton.scaleY = tf.scale
  return tf
}

/**
 * 画面内多个模型的排布。
 * - stack：保持各模型原始坐标，适合人物 + 光效这类本来就在同一世界坐标里的组合。
 * - row：水平等距排开，底边对齐到第一个模型的脚下，适合一次看多个立绘。
 * 布局只决定 base 位置，用户在画面上拖动/缩放得到的是叠加在上面的个人变换。
 */
function arrangeScene(items, layout, transforms) {
  measureItems(items)
  if (layout === 'row' && items.length > 1) {
    const baseline = items[0].baseBounds.y
    const gap = (items.reduce((sum, item) => sum + item.baseBounds.height, 0) / items.length) * ROW_GAP_RATIO
    const total = items.reduce((sum, item) => sum + item.baseBounds.width, 0) + gap * (items.length - 1)
    let cursor = -total / 2
    for (const item of items) {
      const bounds = item.baseBounds
      item.base = { x: cursor - bounds.x, y: baseline - bounds.y }
      cursor += bounds.width + gap
    }
  } else {
    for (const item of items) item.base = { x: 0, y: 0 }
  }
  for (const item of items) applyTransform(item, transforms)
  return items
}

function fitCamera(camera, canvas, items, resetPosition = true) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const item of items) {
    updatePose(item.runtime, item.skeleton, 0, { reset: true })
    const bounds = pickBounds(item.runtime, item.skeleton)
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

const SpineViewer = forwardRef(function SpineViewer({
  model,
  extras = [],
  layout = 'stack',
  background,
  backgroundTransform,
  showFrame = true,
  frameOnly = false,
}, ref) {
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
  const preferredAnimRef = useRef('')
  const layoutRef = useRef(layout)
  const syncCamerasRef = useRef(null)
  const applyLayoutRef = useRef(null)
  // 每个模型自己的位移/缩放，按模型 id 存；画面增删模型后仍保留
  const transformsRef = useRef(new Map())
  const activeIdRef = useRef('')
  const modelApiRef = useRef(null)

  const [animations, setAnimations] = useState([])
  const [current, setCurrent] = useState('')
  const [slots, setSlots] = useState([])
  const [hidden, setHidden] = useState([])
  const [slotsOpen, setSlotsOpen] = useState(false)
  const [slotQuery, setSlotQuery] = useState('')
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [activeName, setActiveName] = useState('')
  const [modelScale, setModelScale] = useState(100)
  const [error, setError] = useState('')

  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { layoutRef.current = layout }, [layout])

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
    syncCamerasRef.current?.()
    setZoom(Math.round(value))
  }

  function resetView() {
    const camera = cameraRef.current
    const canvas = canvasRef.current
    if (!camera || !canvas || !loadedRef.current.length || exportingRef.current) return
    fitZoomRef.current = fitCamera(camera, canvas, loadedRef.current, true)
    applyViewZoom(100)
  }

  // 画面里的模型增删后，整条链路重新加载，但尽量保留当前播放的动画名。
  const extrasKey = extras.map((item) => item.key).join('|')

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
        const canvas = canvasRef.current
        // 画布透明，背景由 HTML 图层负责；WebCodecs 导出时先在 2D 画布画背景再叠这层。
        const gl = canvas.getContext('webgl', {
          alpha: true,
          premultipliedAlpha: true,
          antialias: true,
          preserveDrawingBuffer: true,
        })
        if (!gl) throw new Error('WebGL 不可用')

        // 第一个永远是当前选中的模型，后面的都是“添加到画面”的模型。
        const sources = [
          { key: 'primary', model, primary: true },
          ...extras.map((item) => ({ key: item.key, model: item.model, primary: false })),
        ]
        const loaded = []
        const failures = []
        for (const source of sources) {
          try {
            const runtime = spineRuntime(source.model.spineVersion)
            if (!runtime) throw new Error(`不支持的 Spine 版本：${source.model.spineVersionFull || '未知'}（需要 3.8 / 4.1 / 4.2）`)
            const data = await loadSpineModel(gl, runtime, source.model)
            // 每个模型一个 SceneRenderer：不同 Spine 版本的着色器/顶点格式不能共用。
            const renderer = new runtime.SceneRenderer(canvas, gl)
            loaded.push({ ...data, runtime, renderer, camera: renderer.camera, key: source.key, model: source.model, primary: source.primary })
          } catch (cause) {
            const message = `${source.model.name}：${cause.message || String(cause)}`
            if (source.primary) {
              // 当前模型加载失败就没法继续，先把已经加载好的额外模型释放掉。
              for (const item of loaded) {
                item.renderer.dispose()
                item.atlas.dispose()
              }
              throw new Error(message)
            }
            failures.push(message)
          }
        }
        if (!loaded.length) throw new Error(failures[0] || '没有可显示的模型')
        if (failures.length) setError(`部分模型加载失败 — ${failures.join('；')}`)

        const primary = loaded[0]
        const runtime = primary.runtime
        loadedRef.current = loaded
        runtimeRef.current = runtime

        // 所有模型共享同一个“动画名”，有同名动画的一起播，没有的用自己第一段。
        const preferred = preferredAnimRef.current
        for (const item of loaded) {
          const name = item.names.includes(preferred) ? preferred : item.names[0]
          if (name) item.state.setAnimation(0, name, true)
        }
        preferredAnimRef.current = primary.names.includes(preferred) ? preferred : (primary.names[0] || '')

        const slotMeta = new Map()
        for (const slot of primary.skeleton.slots) {
          if (!slotMeta.has(slot.data.name)) {
            slotMeta.set(slot.data.name, { name: slot.data.name, blend: slot.data.blendMode })
          }
        }
        setSlots(Array.from(slotMeta.values()))
        setAnimations(primary.names)
        setCurrent(preferredAnimRef.current)

        const camera = primary.camera
        cameraRef.current = camera
        let cameraReady = false

        arrangeScene(loaded, layoutRef.current, transformsRef.current)

        // 每个 SceneRenderer 有自己的相机，缩放/平移后统一同步过来。
        function syncCameras() {
          for (const item of loaded) {
            if (item.camera === camera) continue
            item.camera.setViewport(canvas.width, canvas.height)
            item.camera.position.set(camera.position.x, camera.position.y, 0)
            item.camera.zoom = camera.zoom
            item.camera.update()
          }
        }
        syncCamerasRef.current = syncCameras

        // ---- 单个模型的选中与变换 ----
        function itemById(id) {
          return loaded.find((item) => item.model.id === id) || null
        }
        function activeItem() {
          const found = itemById(activeIdRef.current)
          if (found) return found
          activeIdRef.current = primary.model.id
          return primary
        }
        function syncActiveState() {
          const item = activeItem()
          const tf = transformOf(transformsRef.current, item.model.id)
          setActiveName(item.model.name)
          setModelScale(Math.round(tf.scale * 100))
        }
        function activate(item) {
          if (!item || activeIdRef.current === item.model.id) return
          activeIdRef.current = item.model.id
          syncActiveState()
        }
        syncActiveState()

        // 模型的世界包围盒：本地包围盒按自身缩放放大，再叠上位移
        function worldRectOf(item) {
          const bounds = item.baseBounds
          const scale = item.skeleton.scaleX || 1
          return {
            x: item.skeleton.x + bounds.x * scale,
            y: item.skeleton.y + bounds.y * scale,
            w: bounds.width * scale,
            h: bounds.height * scale,
          }
        }
        // 命中用「当前姿态」的紧密包围盒，比 setup pose 的基准框更贴合画面
        function liveRectOf(item) {
          const bounds = pickBounds(item.runtime, item.skeleton)
          if (!Number.isFinite(bounds.width) || bounds.width <= 0) return null
          return { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
        }
        function pickAt(world) {
          // 多个模型叠在一起时，取包围盒更小的那个：大模型的空白外围不会抢走小模型的点击
          let best = null
          let bestArea = Infinity
          for (const item of loaded) {
            const rect = liveRectOf(item) || worldRectOf(item)
            if (world.x >= rect.x && world.x <= rect.x + rect.w && world.y >= rect.y && world.y <= rect.y + rect.h) {
              const area = rect.w * rect.h
              if (area < bestArea) {
                best = item
                bestArea = area
              }
            }
          }
          return best
        }
        function setItemScale(item, nextScale, anchorWorld = null) {
          const tf = transformOf(transformsRef.current, item.model.id)
          const from = tf.scale
          const to = Math.min(SCALE_MAX, Math.max(SCALE_MIN, nextScale))
          if (Math.abs(to - from) < 1e-4) return
          const ox = item.skeleton.x
          const oy = item.skeleton.y
          // 有光标锚点时，让光标下的那个点缩放前后保持不动
          const ax = anchorWorld ? anchorWorld.x : ox
          const ay = anchorWorld ? anchorWorld.y : oy
          tf.scale = to
          tf.x += (ax - (ax - ox) * (to / from)) - ox
          tf.y += (ay - (ay - oy) * (to / from)) - oy
          applyTransform(item, transformsRef.current)
          setModelScale(Math.round(to * 100))
        }
        function resetItemTransform(item) {
          const tf = transformOf(transformsRef.current, item.model.id)
          tf.x = 0
          tf.y = 0
          tf.scale = 1
          applyTransform(item, transformsRef.current)
          setModelScale(100)
        }

        // 开发期调试接口：方便在浏览器里核对每个模型的包围盒与命中结果
        if (import.meta.env.DEV) {
          window.__spineViewer = {
            items: () => loaded.map((item) => ({
              name: item.model.name,
              id: item.model.id,
              rect: liveRectOf(item) || worldRectOf(item),
              x: item.skeleton.x,
              y: item.skeleton.y,
              scale: item.skeleton.scaleX,
              base: item.base,
            })),
            hit: (x, y) => pickAt({ x, y })?.model.name || null,
            // 世界坐标 -> canvas 像素，方便调试/自动化核对
            screenOf: (wx, wy) => {
              const point = new runtime.Vector3(wx, wy, 0)
              point.project(camera.projectionView)
              return {
                x: (point.x + 1) / 2 * canvas.width,
                y: canvas.height - ((point.y + 1) / 2 * canvas.height) - 1,
                cw: canvas.width,
                ch: canvas.height,
              }
            },
            view: () => ({ zoom: camera.zoom, x: camera.position.x, y: camera.position.y }),
          }
        }

        modelApiRef.current = {
          scaleBy(factor) {
            const item = activeItem()
            const tf = transformOf(transformsRef.current, item.model.id)
            setItemScale(item, tf.scale * factor)
          },
          reset() {
            if (exportingRef.current) return
            resetItemTransform(activeItem())
          },
        }

        function resize() {
          if (exportingRef.current) return
          const rect = rootRef.current.getBoundingClientRect()
          const ratio = Math.min(window.devicePixelRatio || 1, 2)
          canvas.width = Math.max(1, Math.round(rect.width * ratio))
          canvas.height = Math.max(1, Math.round(rect.height * ratio))
          fitZoomRef.current = fitCamera(camera, canvas, loaded, !cameraReady)
          cameraReady = true
          applyViewZoom(viewZoomRef.current)
        }
        resize()
        const observer = new ResizeObserver(resize)
        observer.observe(rootRef.current)

        // 布局切换：重新排布后回到默认取景，避免排开后跑到框外。
        applyLayoutRef.current = (nextLayout) => {
          if (exportingRef.current) return
          arrangeScene(loaded, nextLayout, transformsRef.current)
          fitZoomRef.current = fitCamera(camera, canvas, loaded, true)
          applyViewZoom(100)
        }

        function canvasPoint(event) {
          const rect = canvas.getBoundingClientRect()
          return {
            x: (event.clientX - rect.left) * canvas.width / Math.max(rect.width, 1),
            y: (event.clientY - rect.top) * canvas.height / Math.max(rect.height, 1),
          }
        }
        function worldPoint(event) {
          const point = canvasPoint(event)
          return camera.screenToWorld(new runtime.Vector3(point.x, point.y, 0), canvas.width, canvas.height)
        }
        function onWheel(event) {
          if (exportingRef.current) return
          event.preventDefault()
          const point = canvasPoint(event)
          const world = worldPoint(event)
          const target = pickAt(world)
          if (target) {
            // 光标在一个模型上：滚轮调整这个模型的大小
            activate(target)
            const tf = transformOf(transformsRef.current, target.model.id)
            setItemScale(target, tf.scale * Math.exp(-event.deltaY * 0.0015), world)
            return
          }
          // 空白处滚轮仍然缩放整个视图
          applyViewZoom(viewZoomRef.current * Math.exp(-event.deltaY * 0.001), point)
        }

        let drag = null
        function onPointerDown(event) {
          if (exportingRef.current) return
          const target = pickAt(worldPoint(event))
          activate(target)
          drag = { target, last: { x: event.clientX, y: event.clientY } }
          canvas.setPointerCapture(event.pointerId)
          canvas.style.cursor = target ? 'move' : 'grabbing'
        }
        function onPointerMove(event) {
          if (exportingRef.current) return
          if (!drag) {
            // 悬停在模型上时给出可拖动的提示
            canvas.style.cursor = pickAt(worldPoint(event)) ? 'move' : 'grab'
            return
          }
          const dx = event.clientX - drag.last.x
          const dy = event.clientY - drag.last.y
          drag.last = { x: event.clientX, y: event.clientY }
          const rect = canvas.getBoundingClientRect()
          const ratio = canvas.width / Math.max(rect.width, 1)
          if (drag.target) {
            // 拖模型：只移动这一个，1:1 跟随光标
            const tf = transformOf(transformsRef.current, drag.target.model.id)
            tf.x += dx * ratio * camera.zoom
            tf.y -= dy * ratio * camera.zoom
            applyTransform(drag.target, transformsRef.current)
            return
          }
          // 拖空白：平移整个视图
          camera.position.x -= dx * ratio * camera.zoom
          camera.position.y += dy * ratio * camera.zoom
          camera.update()
          syncCameras()
        }
        function onPointerUp(event) {
          drag = null
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
          for (const item of loaded) {
            item.state.apply(item.skeleton)
            updatePose(item.runtime, item.skeleton, pendingDeltaRef.current)
            // 槽位开关只作用于当前选中的模型，其它模型的槽位名不一定相同。
            const detached = []
            if (item.primary && hiddenRef.current.size) {
              for (const slot of item.skeleton.slots) {
                if (hiddenRef.current.has(slot.data.name) && slot.attachment) {
                  detached.push([slot, slot.attachment])
                  slot.attachment = null
                }
              }
            }
            item.renderer.begin()
            item.renderer.drawSkeleton(item.skeleton, item.pma)
            item.renderer.end()
            for (const [slot, attachment] of detached) slot.attachment = attachment
          }
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
            const entry = primary.state.getCurrent(0)
            return entry?.animation?.name || primary.names[0] || ''
          },
          duration() {
            // 多模型时取最长的一段，保证每个模型的动画都播完。
            return loaded.reduce((max, item) => {
              const entry = item.state.getCurrent(0)
              const value = entry?.animation?.duration || 0
              return Number.isFinite(value) ? Math.max(max, value) : max
            }, 0)
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
            syncCameras()
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
          syncCamerasRef.current = null
          applyLayoutRef.current = null
          modelApiRef.current = null
          canvas.removeEventListener('wheel', onWheel)
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('pointermove', onPointerMove)
          canvas.removeEventListener('pointerup', onPointerUp)
          canvas.removeEventListener('pointercancel', onPointerUp)
          for (const item of loaded) {
            item.renderer.dispose()
            item.atlas.dispose()
          }
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
  }, [model.id, extrasKey])

  // 布局切换不用重新加载整个场景，只重排 + 重新取景。
  useEffect(() => {
    applyLayoutRef.current?.(layout)
  }, [layout, model.id, extrasKey])

  function play(name) {
    if (!name) return
    preferredAnimRef.current = name
    // 有同名动画的模型一起切换，这样多个模型能保持同一个动作。
    for (const item of loadedRef.current) {
      if (item.names.includes(name)) item.state.setAnimation(0, name, true)
    }
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
      <div className="gesture-hint">拖动模型改位置 · 拖空白平移 · 滚轮缩放模型/视图 · 虚框为导出范围</div>
      {error && <div className="viewer-error">{error}</div>}
      <div className="viewer-toolbar">
        <PlaybackControls
          playing={playing}
          onToggle={() => setPlaying((value) => !value)}
          speed={speed}
          onSpeed={setSpeed}
        />
        <span className="tool-sep" />
        <span className="tool-group" title="整块画面的取景缩放，不影响模型自身大小">
          <span className="tool-group-label">视图</span>
          <button onClick={() => applyViewZoom(viewZoomRef.current - ZOOM_BUTTON_STEP)}>缩小</button>
          <span className="tool-value">{zoom}%</span>
          <button onClick={() => applyViewZoom(viewZoomRef.current + ZOOM_BUTTON_STEP)}>放大</button>
          <button title="按全部模型重新取景" onClick={resetView}>适应</button>
        </span>
        <span className="tool-sep" />
        <span className="tool-group" title={activeName ? `正在调整：${activeName}` : '点击画面里的模型来选择'}>
          <span className="tool-group-label">
            模型 {activeName ? <em title={activeName}>{activeName.length > 8 ? `${activeName.slice(0, 8)}…` : activeName}</em> : '—'}
          </span>
          <button title="把这个模型缩小" onClick={() => modelApiRef.current?.scaleBy(1 / 1.1)}>缩小</button>
          <span className="tool-value">{modelScale}%</span>
          <button title="把这个模型放大" onClick={() => modelApiRef.current?.scaleBy(1.1)}>放大</button>
          <button title="复位这个模型的位置和大小" onClick={() => modelApiRef.current?.reset()}>复位</button>
        </span>
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

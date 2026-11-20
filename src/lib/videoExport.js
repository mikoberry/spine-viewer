import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { EXPORT_WIDTH, EXPORT_HEIGHT } from './framing.js'

// 逐帧导出：viewer 只按固定 dt 推进，编码时间基准由这里决定，总帧数才精确。
// 优先 WebCodecs 直接编 H.264/MP4；不支持时退回 MediaRecorder 实时录制 WebM。

const BASE_BITRATE = 12_000_000
const MAX_BITRATE = 24_000_000
const CODEC_1080P = ['avc1.640028', 'avc1.4d002a', 'avc1.42E01E']
const CODEC_1440P = ['avc1.640033', 'avc1.4d0033', 'avc1.640032', 'avc1.4d002a']

export class ExportCancelled extends Error {
  constructor() {
    super('导出已取消')
    this.name = 'ExportCancelled'
  }
}

export function supportsWebCodecs() {
  return typeof window !== 'undefined' && typeof window.VideoEncoder === 'function'
}

function bitrateFor(width, height) {
  return Math.min(
    MAX_BITRATE,
    Math.round(BASE_BITRATE * (width * height) / (EXPORT_WIDTH * EXPORT_HEIGHT)),
  )
}

async function pickCodec(width, height, fps, bitrate) {
  const candidates = width * height > EXPORT_WIDTH * EXPORT_HEIGHT ? CODEC_1440P : CODEC_1080P
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps })
      if (support.supported) return codec
    } catch {
      // 有些实现遇到不认识的 codec 字符串会直接抛异常，继续试下一个
    }
  }
  return ''
}

class WebCodecsSink {
  constructor(codec, width, height, fps, bitrate) {
    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height },
      fastStart: 'in-memory',
    })
    this.error = null
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (cause) => { this.error = cause },
    })
    this.encoder.configure({ codec, width, height, bitrate, framerate: fps, latencyMode: 'quality' })
    this.fps = fps
    this.mode = 'webcodecs'
  }

  async addFrame(canvas, index) {
    if (this.error) throw this.error
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(index * 1e6 / this.fps),
      duration: Math.round(1e6 / this.fps),
    })
    this.encoder.encode(frame, { keyFrame: index % (this.fps * 2) === 0 })
    frame.close()
    // 一帧 1440p RGBA 约 14 MB，队列太深会吃光内存
    while (this.encoder.encodeQueueSize > 8) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (this.error) throw this.error
    }
  }

  async finish() {
    await this.encoder.flush()
    this.encoder.close()
    this.muxer.finalize()
    return { blob: new Blob([this.muxer.target.buffer], { type: 'video/mp4' }), mode: this.mode }
  }
}

class MediaRecorderSink {
  constructor(canvas, fps, bitrate) {
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((type) => window.MediaRecorder.isTypeSupported(type)) || ''
    this.chunks = []
    this.fps = fps
    this.stream = canvas.captureStream(fps)
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: bitrate,
    })
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.chunks.push(event.data)
    }
    this.stopped = new Promise((resolve) => { this.recorder.onstop = resolve })
    this.recorder.start()
    this.mode = 'mediarecorder'
    this.lastTick = 0
  }

  async addFrame(canvas, index) {
    // captureStream 按真实时间取帧，只能被动等
    const target = performance.now() + (index - this.lastTick) * 1000 / this.fps
    this.lastTick = index
    const wait = target - performance.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  async finish() {
    this.recorder.stop()
    await this.stopped
    this.stream.getTracks().forEach((track) => track.stop())
    return { blob: new Blob(this.chunks, { type: 'video/webm' }), mode: this.mode }
  }
}

async function createSink(canvas, width, height, fps, bitrate) {
  if (supportsWebCodecs()) {
    const codec = await pickCodec(width, height, fps, bitrate)
    if (codec) return new WebCodecsSink(codec, width, height, fps, bitrate)
  }
  if (typeof window.MediaRecorder !== 'function') {
    throw new Error('当前浏览器既不支持 WebCodecs 也不支持 MediaRecorder，无法导出')
  }
  return new MediaRecorderSink(canvas, fps, bitrate)
}

export async function renderVideo({
  controller,
  width = EXPORT_WIDTH,
  height = EXPORT_HEIGHT,
  fps,
  frames,
  crossfadeFrames = 0,
  background = '#0f1218',
  backgroundImage = null,
  onProgress,
  shouldCancel,
}) {
  const source = controller.getCanvas()
  if (!source) throw new Error('渲染画布不可用')

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })

  controller.prepare({ width, height })
  let sink = null
  const head = []
  try {
    sink = await createSink(canvas, width, height, fps, bitrateFor(width, height))
    const dt = 1000 / fps
    for (let index = 0; index < frames; index++) {
      if (shouldCancel && shouldCancel()) throw new ExportCancelled()
      controller.step(dt)
      ctx.fillStyle = background
      ctx.fillRect(0, 0, width, height)
      // 背景图层在模型画布之下，位置和尺寸由预览面板的同一组参数换算而来
      if (backgroundImage) {
        ctx.save()
        ctx.globalAlpha = backgroundImage.opacity ?? 1
        ctx.drawImage(
          backgroundImage.image,
          backgroundImage.x,
          backgroundImage.y,
          backgroundImage.width,
          backgroundImage.height,
        )
        ctx.restore()
      }
      ctx.drawImage(source, 0, 0, width, height)

      // 尾部淡化到首帧，循环播放时接缝更平滑
      if (crossfadeFrames > 0) {
        const fadeStart = frames - crossfadeFrames
        if (index >= fadeStart) {
          const bitmap = head[index - fadeStart]
          if (bitmap) {
            ctx.globalAlpha = (index - fadeStart + 1) / crossfadeFrames
            ctx.drawImage(bitmap, 0, 0)
            ctx.globalAlpha = 1
          }
        }
      }
      await sink.addFrame(canvas, index)
      if (crossfadeFrames > 0 && index < crossfadeFrames) head.push(await createImageBitmap(canvas))
      if (onProgress) onProgress((index + 1) / frames)
    }
    return { ...(await sink.finish()), frames, fps }
  } catch (cause) {
    try {
      await sink?.finish()
    } catch {
      // 失败路径的收尾异常不重要，保留原始错误
    }
    throw cause
  } finally {
    controller.finish()
    for (const bitmap of head) {
      try { bitmap.close() } catch { /* noop */ }
    }
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

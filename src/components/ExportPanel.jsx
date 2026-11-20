import React, { useMemo, useRef, useState } from 'react'
import { backgroundRect, DEFAULT_BACKGROUND_TRANSFORM } from '../lib/background.js'
import { EXPORT_SIZES } from '../lib/framing.js'
import { buildExportName } from '../lib/exportName.js'
import { downloadBlob, ExportCancelled, renderVideo, supportsWebCodecs } from '../lib/videoExport.js'

const FPS_OPTIONS = [24, 30, 60]
const MAX_SECONDS = 30

export default function ExportPanel({ api, model, backgroundSource, backgroundTransform, onClose }) {
  const [duration, setDuration] = useState(() => {
    const value = api?.getDuration?.() || 0
    return value > 0 ? Number(value.toFixed(2)) : 5
  })
  const animationDuration = useMemo(() => {
    try { return api?.getDuration?.() || 0 } catch { return 0 }
  }, [api])
  const animationName = useMemo(() => {
    try { return api?.getName?.() || '' } catch { return '' }
  }, [api])

  const [fps, setFps] = useState(60)
  const [sizeIndex, setSizeIndex] = useState(0)
  const [background, setBackground] = useState('#0f1218')
  const [crossfadeOn, setCrossfadeOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const cancelRef = useRef(false)
  // 面板打开时冻结时间戳：预览的文件名和真正落盘的名字一致
  const [stamp] = useState(() => new Date())

  const { width, height } = EXPORT_SIZES[sizeIndex]
  const frames = Math.max(1, Math.round(duration * fps))
  const crossfadeFrames = crossfadeOn ? Math.min(Math.round(0.3 * fps), Math.floor(frames / 3)) : 0
  const ext = supportsWebCodecs() ? 'mp4' : 'webm'
  const filename = useMemo(
    () => buildExportName({ model, animation: animationName, seconds: duration, fps, width, height, ext, date: stamp }),
    [model, animationName, duration, fps, width, height, ext, stamp],
  )

  async function start() {
    if (!api) return
    setError('')
    setResult(null)
    setBusy(true)
    setProgress(0)
    cancelRef.current = false
    try {
      let backgroundImage = null
      if (backgroundSource) {
        const image = new Image()
        await new Promise((resolve, reject) => {
          image.onload = resolve
          image.onerror = () => reject(new Error('背景图片加载失败，无法导出'))
          image.src = backgroundSource.url
        })
        backgroundImage = {
          image,
          ...backgroundRect(backgroundTransform || DEFAULT_BACKGROUND_TRANSFORM, width, height),
          opacity: (backgroundTransform?.opacity ?? 100) / 100,
        }
      }
      const output = await renderVideo({
        controller: api,
        width,
        height,
        fps,
        frames,
        crossfadeFrames,
        background,
        backgroundImage,
        onProgress: setProgress,
        shouldCancel: () => cancelRef.current,
      })
      const actualExt = output.mode === 'webcodecs' ? 'mp4' : 'webm'
      const outName = actualExt === ext
        ? filename
        : buildExportName({ model, animation: animationName, seconds: duration, fps, width, height, ext: actualExt, date: stamp })
      downloadBlob(output.blob, outName)
      setResult({ filename: outName, size: output.blob.size, frames: output.frames, mode: output.mode })
    } catch (cause) {
      setError(cause instanceof ExportCancelled ? '已取消' : (cause.message || String(cause)))
    } finally {
      setBusy(false)
      setProgress(0)
    }
  }

  return (
    <div
      className="export-backdrop"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <div className="export-panel">
        <div className="export-head">
          <strong>导出视频</strong>
          <span>{width}×{height} · 取景框内画面</span>
          <button className="export-close" onClick={onClose} disabled={busy}>关闭</button>
        </div>

        <div className="export-rows">
          <label className="export-row">
            <span>时长</span>
            <div className="export-field">
              {animationDuration > 0 && (
                <button
                  className={'export-chip' + (duration === Number(animationDuration.toFixed(2)) ? ' active' : '')}
                  disabled={busy}
                  onClick={() => setDuration(Number(animationDuration.toFixed(2)))}
                >
                  跟随动画（{animationDuration.toFixed(2)}s）
                </button>
              )}
              <input
                className="export-number"
                type="number"
                min="0.2"
                max={MAX_SECONDS}
                step="0.1"
                value={duration}
                disabled={busy}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  setDuration(Number.isFinite(next) ? Math.min(MAX_SECONDS, Math.max(0.2, next)) : 5)
                }}
              />
              <span className="export-note">
                {animationName ? `当前动画「${animationName}」` : '当前无动画'}，共 {frames} 帧
              </span>
            </div>
          </label>

          <div className="export-row">
            <span>分辨率</span>
            <div className="export-field">
              {EXPORT_SIZES.map((option, index) => (
                <button
                  key={option.label}
                  className={'export-chip' + (sizeIndex === index ? ' active' : '')}
                  disabled={busy}
                  onClick={() => setSizeIndex(index)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="export-row">
            <span>帧率</span>
            <div className="export-field">
              {FPS_OPTIONS.map((value) => (
                <button
                  key={value}
                  className={'export-chip' + (fps === value ? ' active' : '')}
                  disabled={busy}
                  onClick={() => setFps(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <label className="export-row">
            <span>背景</span>
            <div className="export-field">
              <input
                className="export-color"
                type="color"
                value={background}
                disabled={busy}
                onChange={(event) => setBackground(event.target.value)}
              />
              <span className="export-note">
                H.264 不支持透明，底色必须不透明
                {backgroundSource ? ` · 背景图：${backgroundSource.name}` : ' · 未设置背景图'}
              </span>
            </div>
          </label>

          <label className="export-row">
            <span>循环</span>
            <div className="export-field">
              <input
                type="checkbox"
                checked={crossfadeOn}
                disabled={busy}
                onChange={(event) => setCrossfadeOn(event.target.checked)}
              />
              <span className="export-note">尾部交叉淡化 {crossfadeFrames} 帧（{supportsWebCodecs() ? 'MP4' : 'WebM'}）</span>
            </div>
          </label>
        </div>

        <div className="export-file">
          <span>文件名</span>
          <code title={filename}>{filename}</code>
        </div>

        {busy && (
          <div className="export-progress">
            <div className="export-progress-bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <span>{Math.round(progress * 100)}%</span>
          </div>
        )}
        {error && <div className="export-error">{error}</div>}
        {result && !error && (
          <div className="export-result">
            已导出 {result.filename}（{(result.size / 1048576).toFixed(1)} MB，{result.frames} 帧
            {result.mode === 'mediarecorder' ? '，实时录制' : ''}）
          </div>
        )}

        <div className="export-actions">
          {busy
            ? <button className="export-primary" onClick={() => { cancelRef.current = true }}>取消</button>
            : <button className="export-primary" onClick={start} disabled={!api}>开始导出</button>}
        </div>
      </div>
    </div>
  )
}

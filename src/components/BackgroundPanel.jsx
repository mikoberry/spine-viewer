import React from 'react'

function Slider({ label, value, min, max, step = 1, unit = '%', onChange, disabled = false }) {
  return (
    <label className={'background-row' + (disabled ? ' disabled' : '')}>
      <span className="background-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="background-value">{Math.round(value)}{unit}</span>
    </label>
  )
}

export default function BackgroundPanel({
  sources,
  source,
  transform,
  onSourceChange,
  onUpload,
  onTransform,
  onWidthChange,
  onPreset,
  onReset,
  onClose,
}) {
  const known = sources.some((item) => item.id === source?.id)

  function selectSource(event) {
    const id = event.target.value
    if (!id) return onSourceChange(null)
    return onSourceChange(sources.find((item) => item.id === id) || source)
  }

  return (
    <div className="background-panel">
      <div className="background-head">
        <strong>背景设置</strong>
        <span>独立于模型</span>
        <button className="slot-panel-close" title="关闭面板" onClick={onClose}>×</button>
      </div>

      <div className="background-source">
        <select value={source?.id || ''} onChange={selectSource}>
          <option value="">无背景</option>
          {!known && source && <option value={source.id}>{source.name}（本地上传）</option>}
          {sources.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <label className="export-chip background-upload" title="从本机选择图片">
          上传
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onUpload(file)
              event.target.value = ''
            }}
          />
        </label>
      </div>
      {!source && <div className="background-hint">选一张图片作为背景；背景变换不会影响模型的缩放和位置。</div>}

      <div className="background-presets">
        <button className="export-chip" disabled={!source} onClick={() => onPreset('contain')}>适应</button>
        <button className="export-chip" disabled={!source} onClick={() => onPreset('cover')}>铺满</button>
        <button className="export-chip" disabled={!source} onClick={onReset}>重置</button>
      </div>

      <Slider
        label="宽度"
        value={transform.width}
        min={10}
        max={400}
        disabled={!source}
        onChange={onWidthChange}
      />
      <Slider
        label="高度"
        value={transform.height}
        min={10}
        max={400}
        disabled={!source || transform.locked}
        onChange={(value) => onTransform({ ...transform, height: value })}
      />
      <Slider
        label="水平"
        value={transform.x}
        min={-150}
        max={150}
        disabled={!source}
        onChange={(value) => onTransform({ ...transform, x: value })}
      />
      <Slider
        label="垂直"
        value={transform.y}
        min={-150}
        max={150}
        disabled={!source}
        onChange={(value) => onTransform({ ...transform, y: value })}
      />
      <Slider
        label="透明"
        value={transform.opacity}
        min={0}
        max={100}
        disabled={!source}
        onChange={(value) => onTransform({ ...transform, opacity: value })}
      />
      <label className={'background-lock' + (source ? '' : ' disabled')}>
        <input
          type="checkbox"
          disabled={!source}
          checked={transform.locked}
          onChange={(event) => onTransform({ ...transform, locked: event.target.checked })}
        />
        宽高按比例联动
      </label>
    </div>
  )
}

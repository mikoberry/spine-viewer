import React from 'react'
import { computeFrameRect, EXPORT_HEIGHT, EXPORT_WIDTH } from '../lib/framing.js'

// 只画取景框，不拦截指针事件；导出区域就是这个框圈定的 16:9 范围。
// frameOnly 时把框外完全遮住，预览画面即最终导出范围。
export default function FramingOverlay({ visible = true, frameOnly = false, label = `${EXPORT_WIDTH}×${EXPORT_HEIGHT}` }) {
  const [rect, setRect] = React.useState(null)
  const hostRef = React.useRef(null)

  React.useEffect(() => {
    const host = hostRef.current?.parentElement
    if (!host) return undefined
    const update = () => {
      const { clientWidth, clientHeight } = host
      if (clientWidth && clientHeight) setRect(computeFrameRect(clientWidth, clientHeight))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={hostRef} className={'framing-overlay' + (visible ? '' : ' hidden')} aria-hidden="true">
      {rect && (
        <div
          className={'framing-box' + (frameOnly ? ' frame-only' : '')}
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          <span className="framing-label">{frameOnly ? `${label} · 仅框内` : label}</span>
        </div>
      )}
    </div>
  )
}

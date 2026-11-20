import React, { useEffect, useState } from 'react'
import { DEFAULT_BACKGROUND_TRANSFORM } from '../lib/background.js'
import { computeFrameRect } from '../lib/framing.js'

// 背景放在 WebGL 画布下面，且只在取景框范围内绘制：
// 预览里框外压暗的那部分不会被背景填满，导出时正好对应整张画布。
export default function BackgroundLayer({ source, transform = DEFAULT_BACKGROUND_TRANSFORM }) {
  const hostRef = React.useRef(null)
  const [frame, setFrame] = useState(null)

  useEffect(() => {
    const host = hostRef.current?.parentElement
    if (!host) return undefined
    const update = () => {
      const { clientWidth, clientHeight } = host
      setFrame(clientWidth && clientHeight ? computeFrameRect(clientWidth, clientHeight) : null)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  if (!source || !frame) return <div ref={hostRef} className="background-anchor" aria-hidden="true" />

  const width = Math.max(0, transform.width)
  const height = Math.max(0, transform.height)
  return (
    <div ref={hostRef} className="background-anchor" aria-hidden="true">
      <div className="background-frame" style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
        <img
          src={source.url}
          alt=""
          draggable={false}
          style={{
            left: `${50 + transform.x - width / 2}%`,
            top: `${50 + transform.y - height / 2}%`,
            width: `${width}%`,
            height: `${height}%`,
            opacity: Math.max(0, Math.min(100, transform.opacity)) / 100,
          }}
        />
      </div>
    </div>
  )
}

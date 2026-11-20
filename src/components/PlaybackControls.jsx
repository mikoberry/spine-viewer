import React from 'react'

const SPEED_MIN = 0.1
const SPEED_MAX = 3

export default function PlaybackControls({ playing, onToggle, speed, onSpeed }) {
  return (
    <>
      <button className={playing ? 'active play-toggle' : 'play-toggle'} onClick={onToggle}>
        {playing ? '暂停' : '播放'}
      </button>
      <input
        className="speed-range"
        type="range"
        min={SPEED_MIN}
        max={SPEED_MAX}
        step="0.05"
        value={speed}
        title="播放速度"
        onChange={(event) => onSpeed(Number(event.target.value))}
      />
      <button className="speed-value" title="恢复 1.0 倍速" onClick={() => onSpeed(1)}>
        {String(Number(speed.toFixed(2)))}×
      </button>
    </>
  )
}

// 预览里的 16:9 取景框同时定义导出范围：Viewer 的相机 fit、框的绘制、
// 导出时的相机换算都读这里的同一个结果，避免"看到的"和"导出的"对不上。

export const EXPORT_SIZES = [
  { width: 1920, height: 1080, label: '1920×1080' },
  { width: 2560, height: 1440, label: '2560×1440' },
]
export const EXPORT_WIDTH = EXPORT_SIZES[0].width
export const EXPORT_HEIGHT = EXPORT_SIZES[0].height
export const FRAME_ASPECT = EXPORT_WIDTH / EXPORT_HEIGHT

const FRAME_PADDING = 0.92

/** 取景框位置与尺寸，单位和传入的宽高一致（CSS 或画布像素）。 */
export function computeFrameRect(width, height, aspect = FRAME_ASPECT, padding = FRAME_PADDING) {
  const safeWidth = Math.max(width, 1)
  const safeHeight = Math.max(height, 1)
  let w = safeWidth * padding
  let h = w / aspect
  if (h > safeHeight * padding) {
    h = safeHeight * padding
    w = h * aspect
  }
  return { x: (safeWidth - w) / 2, y: (safeHeight - h) / 2, w, h }
}

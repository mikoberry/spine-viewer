import { FRAME_ASPECT } from './framing.js'

// 背景变换只运行在取景框（即导出画面）坐标系里：
// width/height 是框的百分比，x/y 是相对框中心的百分比偏移。
// 预览的 <img> 和视频导出的 2D 画布用同一组数字，所见即所得。

export const DEFAULT_BACKGROUND_TRANSFORM = {
  width: 100,
  height: 100,
  x: 0,
  y: 0,
  opacity: 100,
  locked: false,
}

function naturalAspect(source) {
  return source?.width > 0 && source?.height > 0 ? source.width / source.height : FRAME_ASPECT
}

/** 用原始宽高比算出「适应」或「铺满」的百分比尺寸。 */
export function fitBackground(source, mode = 'cover') {
  const aspect = naturalAspect(source)
  if (mode === 'contain') {
    return aspect > FRAME_ASPECT
      ? { width: 100, height: (100 * FRAME_ASPECT) / aspect }
      : { width: (100 * aspect) / FRAME_ASPECT, height: 100 }
  }
  return aspect > FRAME_ASPECT
    ? { width: (100 * aspect) / FRAME_ASPECT, height: 100 }
    : { width: 100, height: (100 * FRAME_ASPECT) / aspect }
}

/** 宽度拖动时按原图比例联动高度；不锁定时各调各的。 */
export function transformForWidth(transform, width, source) {
  if (!transform.locked) return { ...transform, width }
  const height = (width * FRAME_ASPECT) / naturalAspect(source)
  return { ...transform, width, height: Math.round(height * 10) / 10 }
}

/** 把百分比变换换算成目标画布上的像素矩形。 */
export function backgroundRect(transform, width, height) {
  const w = (width * transform.width) / 100
  const h = (height * transform.height) / 100
  return {
    x: (width - w) / 2 + (transform.x / 100) * width,
    y: (height - h) / 2 + (transform.y / 100) * height,
    width: w,
    height: h,
  }
}

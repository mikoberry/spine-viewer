// 导出文件名：{模型}_{动画}_{宽}x{高}_{帧率}_{时长}_{时间戳}.{ext}
// 时间戳在导出面板打开时冻结一次，面板预览和实际下载保持一致。

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

function segment(value, fallback = '') {
  return String(value ?? '')
    .replace(ILLEGAL, '-')
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .trim() || fallback
}

export function buildExportName({ model, animation, seconds, fps, width, height, ext, date = new Date() }) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  const parts = [
    segment(model?.name || model?.file, 'spine'),
    segment(animation, 'still'),
    `${width}x${height}`,
    `${fps}fps`,
    `${Number(seconds).toFixed(2)}s`,
    stamp,
  ]
  return `${parts.join('_')}.${ext}`
}

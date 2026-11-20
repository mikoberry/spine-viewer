// Spine 的运行时只能读自己那条 major.minor 线导出的数据：4.1 不能读 4.2 的
// 附件扩展，4.2 也不保证兼容 4.1；3.8 的二进制头与 4.x 也不同。4.1/4.2 用
// npm alias 并存，3.8 内置官方构建产物。版本由扫描器从 skel 头部读出，随模型
// 记录一起传到这里。

import * as spine41 from '@esotericsoftware/spine-webgl'
import * as spine42 from '@esotericsoftware/spine-webgl-4.2'
import spine38Bundle from '../vendor/spine-webgl-3.8.js'

// Spine 官方从未发布 3.x 的 npm 包，3.8 运行时内置自官方 3.8 分支的构建产物。
// 它和 4.x 的顶点/包围盒接口不同，用 legacy 标记在播放器里做分支。
const spine38 = { ...spine38Bundle, legacy: true }

const RUNTIMES = new Map([
  ['3.8', spine38],
  ['4.1', spine41],
  ['4.2', spine42],
])

export function spineRuntime(version) {
  return RUNTIMES.get(String(version || '').slice(0, 3)) || null
}

export function updatePose(runtime, skeleton, delta = 0, { reset = false } = {}) {
  // 4.2 拆出了物理时钟；4.1 没有这些方法，feature detect 即可共用一套调用。
  if (typeof skeleton.update === 'function') skeleton.update(delta)
  const physics = runtime.Physics ? (reset ? runtime.Physics.reset : runtime.Physics.update) : undefined
  skeleton.updateWorldTransform(physics)
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import BackgroundPanel from './components/BackgroundPanel.jsx'
import ExportPanel from './components/ExportPanel.jsx'
import SpineViewer from './components/SpineViewer.jsx'
import { DEFAULT_BACKGROUND_TRANSFORM, fitBackground, transformForWidth } from './lib/background.js'
import { buildLocalLibrary, collectDroppedFiles } from './lib/dropLibrary.js'

const BASE_URL = import.meta.env.BASE_URL || '/'

// 开发时 Vite 中间件提供 /models/*；静态 Pages 上文件在 <base>models/ 下。
// 扫描器产出的 URL 以 /models/ 开头，这里统一补上 base。
function assetUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return path
  return `${BASE_URL}${path.slice(1)}`
}

async function fetchLibrary() {
  try {
    const response = await fetch(`${BASE_URL}api/models`, { cache: 'no-store' })
    if (response.ok) return response.json()
  } catch {
    // 静态托管没有 API，回落到构建时生成的 models.json。
  }
  const response = await fetch(`${BASE_URL}models.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`模型清单读取失败：${response.status}`)
  return response.json()
}

function resolveLibraryUrls(data) {
  const models = (Array.isArray(data) ? data : data.models || []).map((model) => ({
    ...model,
    skeletonUrl: assetUrl(model.skeletonUrl),
    atlasUrl: assetUrl(model.atlasUrl),
    pages: (model.pages || []).map((page) => ({ ...page, url: assetUrl(page.url) })),
  }))
  const backgrounds = (data.backgrounds || []).map((item) => ({
    ...item,
    url: assetUrl(item.url),
  }))
  return { models, backgrounds }
}

export default function App() {
  const [models, setModels] = useState([])
  const [backgrounds, setBackgrounds] = useState([])
  const [localModels, setLocalModels] = useState([])
  const [localBackgrounds, setLocalBackgrounds] = useState([])
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  const [showFrame, setShowFrame] = useState(true)
  const [frameOnly, setFrameOnly] = useState(false)
  const [background, setBackground] = useState(null)
  const [backgroundTransform, setBackgroundTransform] = useState(DEFAULT_BACKGROUND_TRANSFORM)
  // 画面里额外添加的模型：当前选中那个始终显示，这里只存“额外添加”的部分。
  const [stageModels, setStageModels] = useState([])
  const [stageLayout, setStageLayout] = useState('stack')
  const stageSeqRef = useRef(0)
  const objectUrlRef = useRef(null)
  const localUrlsRef = useRef([])
  const folderInputRef = useRef(null)
  const viewerRef = useRef(null)

  useEffect(() => {
    fetchLibrary()
      .then((data) => {
        const library = resolveLibraryUrls(data)
        setModels(library.models)
        setBackgrounds(library.backgrounds)
        setLoading(false)
      })
      .catch((cause) => { setError(cause.message || String(cause)); setLoading(false) })
  }, [])

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    for (const url of localUrlsRef.current) URL.revokeObjectURL(url)
  }, [])

  function releaseObjectUrl() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }

  function changeBackground(source, { keepObjectUrl = false } = {}) {
    if (!keepObjectUrl) releaseObjectUrl()
    setBackground(source)
    setBackgroundTransform({ ...DEFAULT_BACKGROUND_TRANSFORM, ...fitBackground(source, 'cover') })
  }

  function uploadBackground(file) {
    const url = URL.createObjectURL(file)
    const probe = new Image()
    probe.onload = () => {
      releaseObjectUrl()
      objectUrlRef.current = url
      changeBackground({
        id: `upload:${file.name}:${Date.now()}`,
        name: file.name.replace(/\.[^.]+$/, ''),
        url,
        width: probe.naturalWidth,
        height: probe.naturalHeight,
      }, { keepObjectUrl: true })
    }
    probe.onerror = () => {
      URL.revokeObjectURL(url)
      setError(`背景图片读取失败：${file.name}`)
    }
    probe.src = url
  }

  function changeWidth(width) {
    setBackgroundTransform((current) => transformForWidth(current, width, background))
  }

  async function importEntries(entries, sourceLabel) {
    if (!entries.length) {
      setImportNote('拖入的内容里没有可用文件')
      return
    }
    setImporting(true)
    setImportNote('')
    try {
      const result = await buildLocalLibrary(entries)
      localUrlsRef.current.push(...result.urls)
      setLocalModels((current) => {
        const ids = new Set(current.map((item) => item.id))
        return [...current, ...result.models.filter((item) => !ids.has(item.id))]
      })
      setLocalBackgrounds((current) => {
        const ids = new Set(current.map((item) => item.id))
        return [...current, ...result.backgrounds.filter((item) => !ids.has(item.id))]
      })
      setImportNote(result.models.length
        ? `已从${sourceLabel}导入 ${result.models.length} 个模型${result.backgrounds.length ? `、${result.backgrounds.length} 张背景图` : ''}`
        : `未在${sourceLabel}中找到带 atlas 的 Spine 模型`)
      if (result.models.length) setSelectedId(result.models[0].id)
    } catch (cause) {
      setImportNote(`导入失败：${cause.message || String(cause)}`)
    } finally {
      setImporting(false)
    }
  }

  async function onDrop(event) {
    event.preventDefault()
    setDropActive(false)
    const entries = await collectDroppedFiles(event.dataTransfer)
    await importEntries(entries, '拖入的文件夹')
  }

  function onDragOver(event) {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  function onDragLeave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return
    setDropActive(false)
  }

  function clearLocal() {
    for (const url of localUrlsRef.current) URL.revokeObjectURL(url)
    localUrlsRef.current = []
    setLocalModels([])
    setLocalBackgrounds([])
    setImportNote('')
    setSelectedId('')
    setStageModels([])
  }

  // 添加/移除画面模型。当前选中的模型已经在画面里，不重复添加。
  function addToStage(model) {
    if (!model) return
    setStageModels((current) => {
      if (current.some((item) => item.model.id === model.id)) return current
      stageSeqRef.current += 1
      return [...current, { key: `${model.id}#${stageSeqRef.current}`, model }]
    })
  }

  function removeFromStage(key) {
    setStageModels((current) => current.filter((item) => item.key !== key))
  }

  function clearStage() {
    setStageModels([])
  }

  function toggleShowFrame() {
    // 框内预览依赖取景框：隐藏取景框时一并关掉，避免没有参考框的裁剪状态
    if (showFrame && frameOnly) setFrameOnly(false)
    setShowFrame((value) => !value)
  }

  function toggleFrameOnly() {
    // 打开框内预览时，如果取景框是隐藏的，先把它打开
    if (!frameOnly && !showFrame) setShowFrame(true)
    setFrameOnly((value) => !value)
  }

  const allModels = useMemo(() => [...models, ...localModels], [models, localModels])
  const allBackgrounds = useMemo(() => [...backgrounds, ...localBackgrounds], [backgrounds, localBackgrounds])

  // 模型库里被清掉（比如清空拖入）后，画面上的残留条目一并移除。
  useEffect(() => {
    setStageModels((current) => {
      const ids = new Set(allModels.map((item) => item.id))
      const next = current.filter((item) => ids.has(item.model.id))
      return next.length === current.length ? current : next
    })
  }, [allModels])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return allModels
    return allModels.filter((model) => `${model.name} ${model.id} ${model.group} ${model.spineVersionFull}`.toLowerCase().includes(keyword))
  }, [allModels, query])

  const selected = filtered.find((model) => model.id === selectedId) || filtered[0] || null
  const stageIds = useMemo(() => new Set(stageModels.map((item) => item.model.id)), [stageModels])
  // 当前选中的模型本来就会画，固定到画面里只是让它换个选中后仍留在画面，
  // 这里过滤掉，避免同一个模型被画两遍。
  const stageExtras = useMemo(
    () => stageModels.filter((item) => !selected || item.model.id !== selected.id),
    [stageModels, selected],
  )

  return (
    <div className="app" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <input
        ref={folderInputRef}
        type="file"
        webkitdirectory=""
        multiple
        hidden
        onChange={(event) => {
          const entries = Array.from(event.target.files || []).map((file) => ({
            path: file.webkitRelativePath || file.name,
            file,
          }))
          event.target.value = ''
          importEntries(entries, '选择的文件夹')
        }}
      />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">Spine 模型查看器</div>
          <div className="brand-sub">读取 model-library 目录</div>
          <div className="counts">
            <span>Spine {allModels.length}</span>
            {localModels.length > 0 && <span>拖入 {localModels.length}</span>}
          </div>
        </div>

        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型名 / 目录 / 版本"
        />

        <div className="import-actions">
          <button className="bar-button" disabled={importing} onClick={() => folderInputRef.current?.click()}>
            {importing ? '导入中…' : '导入文件夹'}
          </button>
          {localModels.length > 0 && <button className="bar-button" onClick={clearLocal}>清除拖入</button>}
        </div>
        {importNote && <div className="import-note">{importNote}</div>}

        <div className="list-head">模型列表（{filtered.length}）</div>
        <div className="list">
          {loading && <div className="hint">读取目录中…</div>}
          {error && <div className="error-box">{error}</div>}
          {!loading && !error && filtered.length === 0 && <div className="hint">没有匹配的模型。</div>}
          {filtered.map((model) => {
            const isSelected = selected && selected.id === model.id
            const onStage = stageIds.has(model.id)
            const addable = !onStage
            return (
              <div
                key={model.id}
                className={'list-item' + (isSelected ? ' selected' : '') + (onStage ? ' on-stage' : '')}
              >
                <button className="item-pick" onClick={() => setSelectedId(model.id)} title={model.id}>
                  <span className="item-name">{model.name}</span>
                  <span className="item-meta">
                    <span className="item-group">{model.group}</span>
                    {model.local && <span className="item-local">拖入</span>}
                    <span className="item-code">Spine {model.spineVersionFull || '?'}</span>
                  </span>
                  {model.issues.length > 0 && <span className="item-issue">{model.issues.join('；')}</span>}
                </button>
                <button
                  className={'item-add' + (onStage ? ' on' : '')}
                  disabled={!addable}
                  title={onStage ? '已在画面中' : isSelected ? '固定到画面：切换选中模型后仍保留' : '添加到画面'}
                  onClick={() => addToStage(model)}
                >
                  {onStage ? '已在' : '＋ 画面'}
                </button>
              </div>
            )
          })}
        </div>
      </aside>

      <main className="main">
        <div className="stage">
          {selected
            ? (
              <SpineViewer
                ref={viewerRef}
                model={selected}
                extras={stageExtras}
                layout={stageLayout}
                background={background}
                backgroundTransform={backgroundTransform}
                showFrame={showFrame}
                frameOnly={frameOnly}
              />
            )
            : <div className="empty">请从左侧选择一个模型。</div>}
        </div>
        {selected && (
          <div className="scene-bar">
            <span className="scene-label">画面模型 {1 + stageExtras.length}</span>
            {!stageIds.has(selected.id) && (
              <span className="scene-chip current" title={selected.name}>
                <span className="scene-chip-tag">当前</span>
                <span className="scene-chip-name">{selected.name}</span>
              </span>
            )}
            {stageModels.map((item) => {
              const isCurrent = item.model.id === selected.id
              return (
                <span className={'scene-chip' + (isCurrent ? ' current' : '')} key={item.key} title={item.model.name}>
                  {isCurrent && <span className="scene-chip-tag">当前</span>}
                  <span className="scene-chip-name">{item.model.name}</span>
                  <button
                    className="scene-chip-remove"
                    title={isCurrent ? '从画面列表移除（仍会显示当前模型）' : '从画面移除'}
                    onClick={() => removeFromStage(item.key)}
                  >×</button>
                </span>
              )
            })}
            <span className="scene-actions">
              <button
                className="bar-button"
                disabled={stageIds.has(selected.id)}
                title={stageIds.has(selected.id) ? '当前模型已在画面列表中' : '固定当前模型：切换选中模型后仍留在画面里'}
                onClick={() => addToStage(selected)}
              >
                {stageIds.has(selected.id) ? '已在画面' : '添加到画面'}
              </button>
              <span className="layout-switch" title="多个模型的位置关系：堆叠保持各自原始坐标，并排则水平排开">
                <button
                  className={stageLayout === 'stack' ? 'active' : ''}
                  onClick={() => setStageLayout('stack')}
                >堆叠</button>
                <button
                  className={stageLayout === 'row' ? 'active' : ''}
                  onClick={() => setStageLayout('row')}
                >并排</button>
              </span>
              {stageModels.length > 0 && <button className="bar-button" onClick={clearStage}>清空</button>}
            </span>
          </div>
        )}
        {selected && (
          <div className="path-bar">
            <strong>{selected.name}</strong>
            <span>{selected.folder || 'root'}</span>
            <code>{selected.local ? selected.file : selected.skeletonUrl}</code>
            <span className="path-actions">
              <button
                className={'bar-button' + (showFrame ? ' active' : '')}
                onClick={toggleShowFrame}
              >
                取景框：{showFrame ? '显示' : '隐藏'}
              </button>
              <button
                className={'bar-button' + (frameOnly ? ' active' : '')}
                title="只显示取景框内的画面，开启时会自动显示取景框"
                onClick={toggleFrameOnly}
              >
                框内显示：{frameOnly ? '开' : '关'}
              </button>
              <button
                className={'bar-button' + (backgroundOpen ? ' active' : '')}
                onClick={() => setBackgroundOpen((value) => !value)}
              >
                背景{background ? '：已设置' : ''}
              </button>
              <button className="bar-button primary" onClick={() => setExportOpen(true)}>导出视频</button>
            </span>
          </div>
        )}
      </main>

      {dropActive && (
        <div className="drop-overlay">
          <div className="drop-card">松开鼠标，导入模型文件夹</div>
        </div>
      )}

      {backgroundOpen && selected && (
        <BackgroundPanel
          sources={allBackgrounds}
          source={background}
          transform={backgroundTransform}
          onSourceChange={changeBackground}
          onUpload={uploadBackground}
          onTransform={setBackgroundTransform}
          onWidthChange={changeWidth}
          onPreset={(mode) => setBackgroundTransform((current) => ({
            ...current,
            ...fitBackground(background, mode),
            x: 0,
            y: 0,
          }))}
          onReset={() => changeBackground(background, { keepObjectUrl: objectUrlRef.current !== null })}
          onClose={() => setBackgroundOpen(false)}
        />
      )}

      {exportOpen && selected && (
        <ExportPanel
          key={selected.id}
          api={viewerRef.current}
          model={selected}
          backgroundSource={background}
          backgroundTransform={backgroundTransform}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  )
}

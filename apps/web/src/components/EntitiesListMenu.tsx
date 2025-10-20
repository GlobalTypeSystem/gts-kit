import { useState, useRef, useEffect, useMemo } from 'react'
import { Search, CheckCircle, AlertCircle, RefreshCw, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MenuPanel, MenuHeader, MenuTitle, MenuContent, MenuItem, MenuItemContent } from '@/components/ui/menu'
import { JsonObj, JsonSchema, JsonFile } from '@gts/shared'
import { renderGtsNameWithBreak } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popup, PopupTrigger, PopupContent } from '@/components/ui/popup'
import { getWebCapabilities, getBrowserLimitationMessage } from '../../../../packages/fs-adapters/fs-adapter-web/src/index'

type Entity = JsonObj | JsonSchema
interface EntityListProps {
  jsonObjs: JsonObj[]
  schemas: JsonSchema[]
  invalidFiles: JsonFile[]
  selectedEntity: Entity | null
  selectedInvalidFile: JsonFile | null
  onEntitySelect: (entity: Entity) => void
  onInvalidFileSelect: (file: JsonFile) => void
  onRefresh?: () => void
  onOpen?: () => void
  // Expose filtering state for unified keyboard navigation
  onFilteredEntitiesChange?: (entities: Array<Entity | JsonFile>) => void
}

export function EntityList({ jsonObjs, schemas, invalidFiles, selectedEntity: selectedEntity, selectedInvalidFile, onEntitySelect: onEntitySelect, onInvalidFileSelect, onRefresh, onOpen, onFilteredEntitiesChange }: EntityListProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [openJsonList, setOpenJsonList] = useState(true)
  const [openSchemaList, setOpenSchemaList] = useState(true)
  const [openInvalidList, setOpenInvalidList] = useState(true)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Get capabilities from the adapter
  const capabilities = getWebCapabilities()
  const limitationMessage = getBrowserLimitationMessage()

  const searchTermLc = useMemo(() => searchTerm.toLowerCase(), [searchTerm])
  const match = (name: string, id: string) =>
    name.toLowerCase().includes(searchTermLc) || id.toLowerCase().includes(searchTermLc)

  const getEntityIcon = (entity: Entity) => {
    const validation = entity.validation
    const isSchema = entity.isSchema

    if (validation && validation.errors.length > 0) {
      return <AlertCircle className="h-4 w-4 bg-red-500 text-white rounded-full" />
    }

    return isSchema
      ? <CheckCircle className="h-4 w-4 text-blue-500" />
      : <CheckCircle className="h-4 w-4 text-green-500" />
  }

  const filteredJsonObjs = useMemo(() => (
    jsonObjs.filter(entity => match(entity.file?.name || entity.id, entity.id))
  ), [jsonObjs, searchTermLc])
  const filteredSchemas = useMemo(() => (
    schemas.filter(s => match(s.file?.name || s.id, s.id))
  ), [schemas, searchTermLc])
  const filteredInvalidFiles = useMemo(() => (
    invalidFiles.filter(f => match(f.name, f.path))
  ), [invalidFiles, searchTermLc])

  // Build the visible linear list in render order for keyboard navigation
  const visibleEntities: Array<Entity | JsonFile> = useMemo(() => {
    const list: Array<Entity | JsonFile> = []
    if (openJsonList) list.push(...filteredJsonObjs)
    if (openSchemaList) list.push(...filteredSchemas)
    if (openInvalidList) list.push(...filteredInvalidFiles)
    return list
  }, [filteredJsonObjs, filteredSchemas, filteredInvalidFiles, openJsonList, openSchemaList, openInvalidList])

  // Notify parent of filtered entities for keyboard navigation (only when content actually changes)
  const lastVisibleKeyRef = useRef<string>("")
  const visibleKey = useMemo(() => (
    visibleEntities.map((x) => (( 'path' in x && 'validation' in x && !('isSchema' in (x as any))) ? `F:${(x as JsonFile).path}` : `E:${(x as Entity).id}`)).join('|')
  ), [visibleEntities])
  useEffect(() => {
    if (visibleKey === lastVisibleKeyRef.current) return
    lastVisibleKeyRef.current = visibleKey
    onFilteredEntitiesChange?.(visibleEntities)
  }, [visibleKey, visibleEntities, onFilteredEntitiesChange])

  // Keep selected item visible by scrolling it into view when selection changes
  useEffect(() => {
    if ((!selectedEntity && !selectedInvalidFile) || !panelRef.current) return

    const selectedId = selectedEntity?.id || selectedInvalidFile?.path
    if (!selectedId) return

    const itemEl = panelRef.current.querySelector(`[data-entity-id="${CSS.escape(selectedId)}"]`) as HTMLElement | null
    const viewport = panelRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null

    if (!itemEl || !viewport) return

    // Use requestAnimationFrame for smoother scrolling
    requestAnimationFrame(() => {
      const itemRect = itemEl.getBoundingClientRect()
      const vpRect = viewport.getBoundingClientRect()
      const margin = 8 // slightly larger margin for better visibility

      // Calculate if item is outside visible area
      const isAbove = itemRect.top < vpRect.top + margin
      const isBelow = itemRect.bottom > vpRect.bottom - margin

      if (isAbove || isBelow) {
        // Use smooth scrolling behavior
        const targetScrollTop = isAbove
          ? viewport.scrollTop + itemRect.top - (vpRect.top + margin)
          : viewport.scrollTop + itemRect.bottom - (vpRect.bottom - margin)

        // Ensure we don't scroll beyond bounds
        const maxScrollTop = viewport.scrollHeight - viewport.clientHeight
        const clampedScrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop))

        viewport.scrollTo({
          top: clampedScrollTop,
          behavior: 'smooth'
        })
      }
    })
  }, [selectedEntity, selectedInvalidFile])

  // Keyboard navigation is now handled globally in SharedApp.tsx

  return (
    <MenuPanel
      className="h-full"
      ref={panelRef as any}
      aria-label="Entity list panel (use Shift + Arrow keys to navigate)"
    >
      <MenuHeader className="pb-3">
        <MenuTitle>JSON entities</MenuTitle>
        <div className="flex items-center gap-2 mt-2">
          {capabilities.supportsRefresh ? (
            <Button variant="outline" size="sm" onClick={onRefresh} title="Rescan current directory">
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
          ) : (
            <Popup>
              <PopupTrigger>
                <Button variant="outline" size="sm" disabled title="Refresh not supported in this browser">
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Refresh
                </Button>
              </PopupTrigger>
              <PopupContent side="bottom">
                <div className="text-center">
                  <div className="font-medium mb-1">Refresh not supported</div>
                  <div className="text-muted-foreground">
                    {limitationMessage}
                  </div>
                </div>
              </PopupContent>
            </Popup>
          )}
          <Button variant="secondary" size="sm" onClick={onOpen} title="Open another directory">
            <FolderOpen className="h-4 w-4 mr-1" />
            Open
          </Button>
        </div>
        <div className="relative mt-2">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search ... e.g. gts."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8"
          />
        </div>
      </MenuHeader>
      <MenuContent>
        <ScrollArea className="h-[calc(100vh-170px)]">
          <div className="p-2 space-y-1">
            {/* JSON Objects */}
            <div
              className="flex items-center justify-between px-2 py-1 text-xs uppercase tracking-wide text-muted-foreground cursor-pointer select-none"
              onClick={() => setOpenJsonList(v => !v)}
              role="button"
              aria-expanded={openJsonList}
            >
              <div className="flex items-center gap-1">
                {openJsonList ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>JSON Objects</span>
              </div>
              <span className="text-[10px]">{filteredJsonObjs.length}</span>
            </div>
            {openJsonList && (
              <>
                {filteredJsonObjs.map((entity) => (
                  <MenuItem
                    key={entity.id}
                    selected={selectedEntity?.id === entity.id}
                    data-entity-id={entity.id}
                    entityType="json"
                    onClick={() => onEntitySelect(entity)}
                  >
                    {getEntityIcon(entity)}
                    <MenuItemContent html={renderGtsNameWithBreak(entity.label || entity.id)} />
                  </MenuItem>
                ))}
                {filteredJsonObjs.length === 0 && (
                  <div className="text-center text-muted-foreground py-4">No JSON objects</div>
                )}
              </>
            )}

            {/* JSON Schemas */}
            <div
              className="mt-2 flex items-center justify-between px-2 py-1 text-xs uppercase tracking-wide text-muted-foreground cursor-pointer select-none"
              onClick={() => setOpenSchemaList(v => !v)}
              role="button"
              aria-expanded={openSchemaList}
            >
              <div className="flex items-center gap-1">
                {openSchemaList ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>JSON Schemas</span>
              </div>
              <span className="text-[10px]">{filteredSchemas.length}</span>
            </div>
            {openSchemaList && (
              <>
                {filteredSchemas.map((s) => (
                  <MenuItem
                    key={s.id}
                    selected={selectedEntity?.id === s.id}
                    data-entity-id={s.id}
                    entityType="schema"
                    onClick={() => onEntitySelect(s)}
                  >
                    {getEntityIcon(s)}
                    <MenuItemContent html={renderGtsNameWithBreak(s.id)} />
                  </MenuItem>
                ))}
                {filteredSchemas.length === 0 && (
                  <div className="text-center text-muted-foreground py-4">No schemas</div>
                )}
              </>
            )}

            {/* Invalid JSON Files */}
            {invalidFiles.length > 0 && (
              <>
                <div
                  className="mt-2 flex items-center justify-between px-2 py-1 text-xs uppercase tracking-wide text-muted-foreground cursor-pointer select-none"
                  onClick={() => setOpenInvalidList(v => !v)}
                  role="button"
                  aria-expanded={openInvalidList}
                >
                  <div className="flex items-center gap-1">
                    {openInvalidList ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <span>Invalid JSON Files</span>
                  </div>
                  <span className="text-[10px]">{filteredInvalidFiles.length}</span>
                </div>
                {openInvalidList && (
                  <>
                    {filteredInvalidFiles.map((f) => (
                      <MenuItem
                        key={f.path}
                        selected={selectedInvalidFile?.path === f.path}
                        data-entity-id={f.path}
                        entityType="invalid_file"
                        onClick={() => onInvalidFileSelect(f)}
                      >
                        <AlertCircle className="h-4 w-4 bg-red-500 text-red-100" />
                        <MenuItemContent html={renderGtsNameWithBreak(f.name)} />
                      </MenuItem>
                    ))}
                    {filteredInvalidFiles.length === 0 && (
                      <div className="text-center text-muted-foreground py-4">No invalid files</div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </MenuContent>
    </MenuPanel>
  )
}

import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

type PopupContextType = {
  open: boolean
  setOpen: (v: boolean) => void
  openDelay: number
  closeDelay: number
  scheduleClose: () => void
  cancelClose: () => void
  anchorEl: HTMLElement | null
  setAnchorEl: (el: HTMLElement | null) => void
}

const PopupContext = React.createContext<PopupContextType | null>(null)

export function Popup({
  children,
  openDelay = 0,
  closeDelay = 200,
}: {
  children: React.ReactNode
  openDelay?: number
  closeDelay?: number
}) {
  const [open, setOpen] = React.useState(false)
  const closeTimer = React.useRef<number | null>(null)
  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null)
  const cancelClose = React.useCallback(() => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])
  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), closeDelay)
  }, [closeDelay, cancelClose])
  const value = React.useMemo(() => ({ open, setOpen, openDelay, closeDelay, scheduleClose, cancelClose, anchorEl, setAnchorEl }), [open, openDelay, closeDelay, scheduleClose, cancelClose, anchorEl])
  return <PopupContext.Provider value={value}>{children}</PopupContext.Provider>
}

export function PopupTrigger({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const ctx = React.useContext(PopupContext)
  if (!ctx) return <>{children}</>

  const openTimer = React.useRef<number | null>(null)
  const clearOpenTimer = () => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }
  const onEnter = () => {
    clearOpenTimer()
    openTimer.current = window.setTimeout(() => ctx.setOpen(true), ctx.openDelay)
  }
  const onLeave = () => {
    clearOpenTimer()
    ctx.scheduleClose()
  }

  return (
    <span
      ref={(el) => ctx.setAnchorEl(el)}
      className={cn('inline-flex items-center min-w-0 max-w-full', className)}
      onMouseEnter={() => { ctx.cancelClose(); onEnter() }}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      {children}
    </span>
  )
}

export function PopupContent({
  children,
  className,
  side = 'top',
  copyableText,
}: {
  children: React.ReactNode
  className?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  copyableText?: string
}) {
  const ctx = React.useContext(PopupContext)
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [mounted, setMounted] = React.useState(false)
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
    return () => setMounted(false)
  }, [])

  const anchor = ctx?.anchorEl || null

  const scheduleClose = () => ctx?.scheduleClose()
  const cancelClose = () => ctx?.cancelClose()

  React.useEffect(() => {
    if (!ctx?.open || !anchor) return
    const rect = anchor.getBoundingClientRect()
    const padding = 8
    let top = rect.top
    let left = rect.left
    switch (side) {
      case 'top':
        top = rect.top - padding
        left = rect.left - 8
        break
      case 'bottom':
        top = rect.bottom + padding
        left = rect.left - 8
        break
      case 'left':
        top = rect.top
        left = rect.left - padding - 8
        break
      case 'right':
        top = rect.top
        left = rect.right + padding - 8
        break
    }
    setCoords({ top, left })
  }, [ctx?.open, anchor, side])

  const onCopy = async () => {
    if (!copyableText) return
    try {
      await navigator.clipboard.writeText(copyableText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1000)
    } catch {}
  }

  if (!ctx || !mounted) return null
  if (!ctx.open || !coords) return null

  const content = (
    <div
      ref={(n) => {
        ref.current = n
        containerRef.current = n
      }}
      className={cn(
        'z-50 min-w-[240px] max-w-[80vw] rounded-md border bg-popover text-popover-foreground shadow-md outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'p-2 text-xs bg-gray-100',
        className,
      )}
      style={{ position: 'fixed', top: coords.top, left: coords.left }}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="break-all whitespace-pre-wrap select-text">{children}</div>
        {copyableText && (
          <button
            type="button"
            onClick={onCopy}
            className="shrink-0 rounded border bg-background px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted"
            aria-label="Copy"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
    </div>
  )

  return createPortal(content, document.body)
}

export const PopupDemo = {
  Popup,
  PopupTrigger,
  PopupContent,
}

import * as React from 'react'
import { X, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ToastType = 'success' | 'error' | 'info'

interface ToastProps {
  message: string | React.ReactNode
  type?: ToastType
  duration?: number // milliseconds, 0 = no auto-dismiss
  onClose?: () => void
}

export function Toast({ message, type = 'info', duration = 3000, onClose }: ToastProps) {
  const [isVisible, setIsVisible] = React.useState(true)
  const [isFadingOut, setIsFadingOut] = React.useState(false)
  const onCloseRef = React.useRef(onClose)

  // Keep ref updated
  React.useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  React.useEffect(() => {
    if (duration > 0) {
      const fadeOutDelay = Math.max(duration - 300, 0) // Start fade 300ms before removal
      const fadeTimer = setTimeout(() => {
        setIsFadingOut(true)
      }, fadeOutDelay)

      const removeTimer = setTimeout(() => {
        setIsVisible(false)
        onCloseRef.current?.()
      }, duration)

      return () => {
        clearTimeout(fadeTimer)
        clearTimeout(removeTimer)
      }
    }
  }, [duration])

  const handleClose = () => {
    setIsFadingOut(true)
    setTimeout(() => {
      setIsVisible(false)
      onClose?.()
    }, 300)
  }

  if (!isVisible) return null

  const Icon = type === 'success' ? CheckCircle2 : type === 'error' ? AlertCircle : null
  
  const styles = {
    success: {
      bg: 'bg-green-50 border-green-200',
      icon: 'text-green-600',
      text: 'text-green-900',
      closeHover: 'hover:bg-green-100'
    },
    error: {
      bg: 'bg-red-50 border-red-200',
      icon: 'text-red-600',
      text: 'text-red-900',
      closeHover: 'hover:bg-red-100'
    },
    info: {
      bg: 'bg-blue-50 border-blue-200',
      icon: 'text-blue-600',
      text: 'text-blue-900',
      closeHover: 'hover:bg-blue-100'
    }
  }

  const currentStyle = styles[type]

  return (
    <div
      className={cn(
        'fixed top-16 right-4 z-[100] flex items-start gap-3 rounded-lg shadow-xl border-2 px-4 py-3 min-w-[200px] max-w-[400px]',
        currentStyle.bg,
        'transition-opacity duration-300',
        isFadingOut ? 'opacity-0' : 'opacity-100'
      )}
    >
      {Icon && <Icon className={cn('w-5 h-5 flex-shrink-0 mt-0.5', currentStyle.icon)} />}
      <div className={cn('flex-1 text-sm leading-relaxed font-medium', currentStyle.text)}>{message}</div>
      <button
        onClick={handleClose}
        className={cn('flex-shrink-0 ml-1 p-1 rounded transition-colors', currentStyle.text, currentStyle.closeHover)}
        aria-label="Close"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

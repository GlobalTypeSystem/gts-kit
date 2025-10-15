import { useEffect, useCallback } from 'react'

export function useKeyboardZoom(onZoom: (delta: number) => void) {
  const handleWheel = useCallback((event: Event) => {
    const wheelEvent = event as WheelEvent
    // Only zoom when Command key is held (macOS) or Ctrl key (Windows/Linux)
    if (wheelEvent.metaKey || wheelEvent.ctrlKey) {
      event.preventDefault()
      const delta = wheelEvent.deltaY > 0 ? -0.1 : 0.1
      onZoom(delta)
    }
  }, [onZoom])

  useEffect(() => {
    const element = document.querySelector('.react-flow')
    if (element) {
      element.addEventListener('wheel', handleWheel, { passive: false })
      return () => {
        element.removeEventListener('wheel', handleWheel)
      }
    }
  }, [handleWheel])
}

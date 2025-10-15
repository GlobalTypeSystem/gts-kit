import { useState, useEffect, useCallback, useRef } from 'react'
import { getAppApi, getApiBase } from '@/utils/api'

export type ServerHealthStatus = 'healthy' | 'unhealthy' | 'checking'

const HEALTH_CHECK_INTERVAL = 2000 // 2 seconds
const HEALTH_CHECK_TIMEOUT = 5000 // 5 seconds

/**
 * Hook to manage server health checking with automatic polling when server is down.
 * Only applies to web mode with server backend - returns 'healthy' for other platforms.
 */
export function useServerHealth() {
  const [status, setStatus] = useState<ServerHealthStatus>('checking')
  const [isPolling, setIsPolling] = useState(false)
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const serverUrl = getApiBase()

  // Check if we're using server backend (web mode without injected storage)
  const usesServerBackend = useCallback(() => {
    const appApi = getAppApi()
    return appApi.type === 'web' && !appApi.layoutStorage
  }, [])

  // Perform a single health check
  const checkHealth = useCallback(async (): Promise<boolean> => {
    if (!usesServerBackend()) {
      return true // Always healthy for non-server backends
    }

    // Cancel any ongoing check
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const apiBase = getApiBase()

      // Create timeout promise
      const timeoutPromise = new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error('Health check timeout')), HEALTH_CHECK_TIMEOUT)
      })

      const fetchPromise = fetch(`${apiBase}/health`, {
        method: 'GET',
        signal: controller.signal,
      })

      const response = await Promise.race([fetchPromise, timeoutPromise])
      const isHealthy = response.ok
      setStatus(isHealthy ? 'healthy' : 'unhealthy')
      return isHealthy
    } catch (error: any) {
      // Ignore abort errors
      if (error.name === 'AbortError') {
        return false
      }

      setStatus('unhealthy')
      return false
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
    }
  }, [usesServerBackend])

  // Start polling for server health
  const startPolling = useCallback(() => {
    if (!usesServerBackend()) {
      return // No polling needed for non-server backends
    }

    if (pollingIntervalRef.current) {
      return // Already polling
    }

    setIsPolling(true)

    // Immediate check
    checkHealth()

    // Set up interval
    pollingIntervalRef.current = setInterval(async () => {
      const isHealthy = await checkHealth()
      if (isHealthy) {
        stopPolling()
      }
    }, HEALTH_CHECK_INTERVAL)
  }, [checkHealth, usesServerBackend])

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
    setIsPolling(false)
  }, [])

  // Mark server as unhealthy and start polling
  const markUnhealthy = useCallback(() => {
    setStatus('unhealthy')
    startPolling()
  }, [startPolling])

  // Initial health check on mount
  useEffect(() => {
    const usesServer = usesServerBackend()
    if (!usesServer) {
      setStatus('healthy')
      return
    }
    checkHealth().then((isHealthy) => {
      if (!isHealthy) {
        startPolling()
      }
    })

    return () => {
      stopPolling()
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [checkHealth, stopPolling, usesServerBackend, startPolling])

  return {
    status,
    isPolling,
    checkHealth,
    startPolling,
    stopPolling,
    markUnhealthy,
    serverUrl,
    usesServerBackend: usesServerBackend()
  }
}

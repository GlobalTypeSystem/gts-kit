// Common types used across the application

export type Viewport = {
  x: number
  y: number
  zoom: number
}

export type Position = {
  x: number
  y: number
}

export type HandlePosition = {
  side: 'Left' | 'Right' | 'Top' | 'Bottom'
  pct: number
}

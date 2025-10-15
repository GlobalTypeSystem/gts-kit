// Timing constants for animations, delays, and transitions

export const TIMING = {
  // Viewport and layout
  VIEWPORT_RESTORE_DELAY: 100,
  FIT_VIEW_DELAY: 30,
  VIEWPORT_INIT_DELAY: 10,

  // UI interactions
  COPY_INDICATOR_DURATION: 1000,
  POPUP_CLOSE_DELAY: 200,

  // State updates
  NEXT_TICK: 1,
  STATE_PROPAGATION_DELAY: 1,

  // Animations
  VIEWPORT_TRANSITION_DURATION: 200,

  // Toast
  SAVE_LAYOUT_ERROR_MSG_DURATION: 5000,
  SAVE_LAYOUT_SUCCESS_MSG_DURATION: 2000,
} as const

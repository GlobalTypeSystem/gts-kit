/**
 * Cooperative time slicing for long loops on the extension host.
 *
 * Everything an extension does shares one thread with every other extension
 * and with the host's own message handling, so a loop over 100K+ files that
 * never yields freezes commands, tree clicks, hovers and progress updates for
 * as long as it runs. Long loops call `slicer.tick()` per item; it yields back
 * to the event loop once the current slice has used up its budget.
 */

const DEFAULT_SLICE_MS = 20

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Thrown by a cancelled scan step; callers abandon the work silently. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

export class TimeSlicer {
  private sliceStart = Date.now()
  /** Total time other work (other extensions, host messages) ran while this slicer yielded. */
  awayMs = 0

  constructor(
    private readonly isCancelled: () => boolean = () => false,
    private readonly sliceMs = DEFAULT_SLICE_MS
  ) {}

  /** Yield if the slice is used up; throws CancelledError once cancelled. */
  async tick(): Promise<void> {
    const yieldStart = Date.now()
    if (yieldStart - this.sliceStart < this.sliceMs) return
    await yieldToEventLoop()
    this.sliceStart = Date.now()
    this.awayMs += this.sliceStart - yieldStart
    this.throwIfCancelled()
  }

  /** For use right after a long await that isn't sliced (e.g. a file search). */
  throwIfCancelled(): void {
    if (this.isCancelled()) throw new CancelledError()
  }
}

const MIN_PUBLISH_INTERVAL_MS = 1000
const MAX_PUBLISH_INTERVAL_MS = 60000
// Other work triggered by a publish may take up to 1/(1+N) of the time.
const PUBLISH_COST_FACTOR = 4

/**
 * When to publish the next batch of results (e.g. diagnostics) from a long
 * sliced loop. Each publish makes other extensions react on this same thread
 * (Windsurf re-reads every diagnostic in the workspace on each diagnostics
 * change: seconds once there are tens of thousands), which publishing every
 * second turned into a validation pass that practically never finished. The
 * interval adapts to that cost, measured as the time spent away from the loop
 * between publishes, keeping it to a fraction of the loop's own time.
 */
export class PublishSchedule {
  private last = Date.now()
  private interval = MIN_PUBLISH_INTERVAL_MS
  private awayAtLast: number

  constructor(private readonly slicer: TimeSlicer) {
    this.awayAtLast = slicer.awayMs
  }

  get due(): boolean {
    return Date.now() - this.last >= this.interval
  }

  /** Call right after publishing. */
  published(): void {
    const away = this.slicer.awayMs - this.awayAtLast
    this.interval = Math.min(MAX_PUBLISH_INTERVAL_MS, Math.max(MIN_PUBLISH_INTERVAL_MS, away * PUBLISH_COST_FACTOR))
    this.last = Date.now()
    this.awayAtLast = this.slicer.awayMs
  }
}

/** `items.filter(predicate)`, yielding between slices. */
export async function filterSliced<T>(items: readonly T[], predicate: (item: T) => boolean, slicer: TimeSlicer): Promise<T[]> {
  const out: T[] = []
  for (const item of items) {
    if (predicate(item)) out.push(item)
    await slicer.tick()
  }
  return out
}

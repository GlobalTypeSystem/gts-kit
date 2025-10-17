import { GtsConfig, getGtsConfig } from '@gts/shared'

// Self-contained config defaults and shape (not exported; consumers should only use AppConfig)
type ConfigShape = {
  gts: GtsConfig
  schema: {
    node: {
      width: number
      height: number
      label_width: number
      nodesep: number
      ranksep: number
    }
    fit_view: {
      padding: number
      min_zoom: number
      max_zoom: number
    }
  }
  sidebar: {
    min_width: number
    max_width: number
    default_width: number
  }
  server: {
    hostname: string
    port: number
  }
  workspace: string
}

const DEFAULTS: ConfigShape = {
  gts: {
    entity_id_fields: [],
    schema_id_fields: [],
  },
  schema: {
    node: {
      width: 400,
      height: 300,
      label_width: 200,
      nodesep: 250,
      ranksep: 170,
    },
    fit_view: {
      padding: 0.1,
      min_zoom: 0.25,
      max_zoom: 1.2,
    }
  },
  sidebar: {
    min_width: 100,
    max_width: 400,
    default_width: 360,
  },
  server: {
    hostname: '',
    port: 7806,
  },
  workspace: 'default'
}

class ConfigService {
  private config: ConfigShape = DEFAULTS
  private initialized = false
  private initializing: Promise<void> | null = null

  private async loadFromCandidates(): Promise<ConfigShape | null> {
    const candidates = ['/apps/web/config.json', '/config.json']
    for (const p of candidates) {
      try {
        const resp = await fetch(p)
        if (!resp.ok) continue
        const cfg = await resp.json()
        if (cfg) {
          // Ensure $id is present in gts.schema_id_fields as highest priority
          const merged: ConfigShape = {
            gts: getGtsConfig(cfg.gts),
            schema: {
              node: {
                width: Number(cfg.schema.node?.width ?? cfg.schema.node_width) || DEFAULTS.schema.node.width,
                height: Number(cfg.schema.node?.height ?? cfg.schema.node_height) || DEFAULTS.schema.node.height,
                label_width: Number(cfg.schema.node?.label_width ?? cfg.schema.node_label_width) || DEFAULTS.schema.node.label_width,
                nodesep: Number(cfg.schema.node?.nodesep ?? cfg.schema.node_nodesep) || DEFAULTS.schema.node.nodesep,
                ranksep: Number(cfg.schema.node?.ranksep ?? cfg.schema.node_ranksep) || DEFAULTS.schema.node.ranksep,
              },
              fit_view: {
                padding: Number(cfg.schema.fit_view?.padding) || DEFAULTS.schema.fit_view.padding,
                min_zoom: Number(cfg.schema.fit_view?.min_zoom) || DEFAULTS.schema.fit_view.min_zoom,
                max_zoom: Number(cfg.schema.fit_view?.max_zoom) || DEFAULTS.schema.fit_view.max_zoom,
              }
            },
            sidebar: {
              min_width: Number(cfg.sidebar?.min_width) || DEFAULTS.sidebar.min_width,
              max_width: Number(cfg.sidebar?.max_width) || DEFAULTS.sidebar.max_width,
              default_width: Number(cfg.sidebar?.default_width) || DEFAULTS.sidebar.default_width,
            },
            server: {
              hostname: cfg.server?.hostname ?? DEFAULTS.server.hostname,
              port: Number(cfg.server?.port) || DEFAULTS.server.port,
            },
            workspace: cfg.workspace ?? DEFAULTS.workspace,
          }
          return merged
        }
      } catch (_) {
        // ignore and try next
      }
    }
    return null
  }

  async init(): Promise<void> {
    if (this.initialized) return
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      const loaded = await this.loadFromCandidates()
      if (loaded) this.config = loaded
      this.initialized = true
      this.initializing = null
    })()
    return this.initializing
  }

  get(): ConfigShape {
    return this.config
  }
}

export const AppConfig = new ConfigService()

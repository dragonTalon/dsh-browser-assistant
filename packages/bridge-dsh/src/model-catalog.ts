/**
 * bridge-local model catalog assembly: read-only projection of the dsh `llm`
 * and `agentDefaultModel` services into one extension-facing value.
 *
 * Why local/structural types: the bridge must not import dsh internal
 * packages (no runtime dependency drift) and must degrade when a service is
 * absent, so `index.ts` probes with `ctx.get(...)` and only passes services
 * that exist. These interfaces are the structural minimum the assembly
 * consumes — same pattern as `TypertGatewayLike` / `HostConnectionLike`.
 *
 * Multimodal authority: `inputModalities` is only reachable in-process
 * (`llm.listModels`); it is NOT exposed by any dsh @Remote method. Providers
 * that do not publish it keep the field absent — never invented.
 *
 * @module
 */

/** One registered provider route, structural minimum. */
export interface LlmProviderLike {
  readonly id: string
  readonly name: string
}

/** One model entry as returned by the provider adapter. */
export interface LlmModelLike {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Accepted request modalities; absent = unknown capability (not negative). */
  readonly inputModalities?: readonly string[]
}

/** Structural subset of the dsh `llm` Cordis service. */
export interface LlmLike {
  listProviders(): readonly LlmProviderLike[] | Promise<readonly LlmProviderLike[]>
  listModels(provider: string): readonly LlmModelLike[] | Promise<readonly LlmModelLike[]>
}

/** One complete model selection shared by session projection and default. */
export interface ModelSelectionValue {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Structural subset of the dsh `agentDefaultModel` Cordis service. */
export interface AgentDefaultModelLike {
  currentSelection(): ModelSelectionValue
}

/** Optional pair discovered by the plugin at boot. */
export interface ModelCatalogServices {
  readonly llm: LlmLike
  readonly agentDefaultModel: AgentDefaultModelLike
}

/** Wire value returned by the `model.catalog` RPC. */
export interface ModelCatalogValue {
  /** Deployment default used before a Session selects a model. */
  readonly default: ModelSelectionValue
  /** Provider groups with a non-empty model list. */
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly Readonly<{
      id: string
      name: string
      description?: string
      inputModalities?: readonly string[]
    }>[]
  }[]
  /** Providers whose catalog lookup failed, isolated from the rest. */
  readonly failures: readonly {
    readonly id: string
    readonly name: string
    readonly message: string
  }[]
}

/**
 * Assemble the extension-facing catalog: deployment default plus one group
 * per provider whose adapter answers, fault-isolating each provider. Mirrors
 * dsh session-controller's buildModelCatalog tolerance shape, with the
 * added `inputModalities` that only in-process access can reach.
 * @param services - probed `llm` + `agentDefaultModel` pair.
 * @returns the catalog value; per-provider failures land in `failures`.
 */
export async function buildBridgeModelCatalog(
  services: ModelCatalogServices,
): Promise<ModelCatalogValue> {
  const providers = await services.llm.listProviders()
  const results = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await services.llm.listModels(provider.id)
      const entries = normalizeModels(models)
      return {
        kind: 'group' as const,
        group: { id: provider.id, name: provider.name, models: entries },
      }
    } catch (error: unknown) {
      return {
        kind: 'failure' as const,
        failure: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))
  const defaultSelection = services.agentDefaultModel.currentSelection()
  return {
    default: {
      provider: defaultSelection.provider,
      model: defaultSelection.model,
      ...(defaultSelection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: defaultSelection.reasoningEffort }),
    },
    groups: results
      .flatMap((result) => (result.kind === 'group' ? [result.group] : []))
      .filter((group) => group.models.length > 0),
    failures: results.flatMap((result) => (result.kind === 'failure' ? [result.failure] : [])),
  }
}

/** Validate and detach adapter-returned model entries; invalid rows are dropped. */
function normalizeModels(models: readonly LlmModelLike[]): {
  id: string
  name: string
  description?: string
  inputModalities?: readonly string[]
}[] {
  const seen = new Set<string>()
  const entries: {
    id: string
    name: string
    description?: string
    inputModalities?: readonly string[]
  }[] = []
  for (const model of models) {
    if (typeof model?.id !== 'string' || model.id.length === 0 || seen.has(model.id)) continue
    seen.add(model.id)
    const name = typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id
    const modalities = Array.isArray(model.inputModalities)
      && model.inputModalities.every((modality) => typeof modality === 'string' && modality.length > 0)
      ? [...model.inputModalities]
      : undefined
    entries.push({
      id: model.id,
      name,
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
    })
  }
  return entries
}

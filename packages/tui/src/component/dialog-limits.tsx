import type { ModelInfo } from "@opencode/client"
import { TextAttributes } from "@opentui/core"
import { createMemo, For, onMount, Show } from "solid-js"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { DIALOG_LIST_INSET, DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { formatDollars, formatReset, limitScope, usageLevel } from "../util/usage-limits"
import { useUsageLimits } from "./usage"

/** Token counts as the limits read them: whole thousands and millions. */
function formatTokens(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "—"
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return `${value}`
}

/** How long until a reset, so a limit reads as time left rather than only a date. */
function formatCountdown(at: number) {
  const ms = at - Date.now()
  if (!Number.isFinite(ms)) return undefined
  if (ms <= 0) return "now"
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function resetText(at: number) {
  const countdown = formatCountdown(at)
  return countdown ? `${formatReset(at)} (in ${countdown})` : formatReset(at)
}

/**
 * `/limits`: every available model with the limits OpenCode knows about it, and when they reset. Unlike `/usage`,
 * which only lists models the workspace limits, this shows free models, models without a budget, and every model's
 * context window too.
 */
export function DialogLimits() {
  const limits = useUsageLimits()
  const data = useData()
  const location = useLocation()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  onMount(() => limits.load(true))

  const providers = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item])),
  )
  const key = (model: ModelInfo) => `${model.providerID}/${model.id}`
  const providerName = (model: ModelInfo) => providers().get(model.providerID)?.name ?? model.providerID

  const rows = createMemo(() =>
    limits
      .models()
      .map((model) => {
        const usage = limits.usage(model)
        const free = model.cost.length > 0 && model.cost.every((cost) => cost.input === 0)
        return { model, usage, free, level: usage ? usageLevel(usage, model) : undefined }
      })
      .toSorted(
        (a, b) =>
          providerName(a.model).localeCompare(providerName(b.model)) || a.model.name.localeCompare(b.model.name),
      ),
  )

  const nearest = createMemo(() => {
    const resets = rows().flatMap((row) => (row.usage ? [row.usage.resetsAt] : []))
    return resets.length > 0 ? Math.min(...resets) : undefined
  })

  const description = createMemo(() => {
    const parts: string[] = []
    const workspace = limits.info()?.workspace.name
    if (workspace) parts.push(`Workspace: ${workspace}`)
    const go = limits.info()?.go
    if (go) {
      parts.push(`Go 5h ${Math.round(go.rolling.percent)}%`)
      parts.push(`week ${Math.round(go.weekly.percent)}%`)
      parts.push(`month ${Math.round(go.monthly.percent)}%`)
    }
    if (nearest() !== undefined) parts.push(`resets ${formatReset(nearest()!)}`)
    if (limits.info() === null) parts.push("Console limits unavailable")
    return parts.join(" · ")
  })

  const footer = (row: ReturnType<typeof rows>[number]) => {
    const context = `${formatTokens(row.model.limit.context)} context`
    if (row.usage) {
      const countdown = formatCountdown(row.usage.resetsAt)
      return [context, `${formatDollars(row.usage.left)} left`, countdown ? `resets in ${countdown}` : undefined]
        .filter(Boolean)
        .join(" · ")
    }
    if (row.free) return `${context} · free`
    if (limits.unlimited(row.model)) return `${context} · no limit`
    return `${context} · no usage limit`
  }

  return (
    <DialogSelect
      title="Model limits"
      description={description() || undefined}
      placeholder="Search models"
      options={rows().map((row) => ({
        title: row.model.name,
        description: providerName(row.model),
        searchText: providerName(row.model),
        category: providerName(row.model),
        value: key(row.model),
        footer: footer(row),
        footerColor:
          row.level === "out" || row.level === "reached" ? theme.text.feedback.error.base : undefined,
        onSelect: () => dialog.replace(() => <DialogLimitsModel model={row.model} />),
      }))}
      emptyView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={theme.text.muted} wrapMode="word">
            No models are available. Connect a provider and try again.
          </text>
        </box>
      }
    />
  )
}

/** Every limit on one model: its context window and price, the Console budgets covering it, and the Go allowance. */
export function DialogLimitsModel(props: { model: ModelInfo }) {
  const limits = useUsageLimits()
  const data = useData()
  const location = useLocation()
  const theme = useTheme().surface("dialog")
  const usage = () => limits.usage(props.model)
  const provider = () =>
    (data.location.provider.list(location.ref) ?? []).find((item) => item.id === props.model.providerID)
  const workspace = () => limits.info()?.workspace.name
  const short = () => {
    const value = usage()
    if (!value) return false
    const level = usageLevel(value, props.model)
    return level === "out" || level === "reached"
  }
  const go = () => (props.model.providerID === "opencode-go" ? limits.info()?.go : undefined)
  const free = () => props.model.cost.length > 0 && props.model.cost.every((cost) => cost.input === 0)

  return (
    <DialogLayout
      header={
        <DialogHeader
          titleView={
            <text fg={theme.text.base}>
              <span style={{ fg: theme.text.muted }}>Limits › </span>
              {props.model.name}
            </text>
          }
        />
      }
    >
      <box gap={1}>
        <box>
          <text fg={theme.text.muted}>{provider()?.name ?? props.model.providerID}</text>
          <text fg={theme.text.base}>
            {formatTokens(props.model.limit.context)} context
            <Show when={props.model.limit.output > 0}>
              <span style={{ fg: theme.text.muted }}> · {formatTokens(props.model.limit.output)} max output</span>
            </Show>
          </text>
          <Show when={free()}>
            <text fg={theme.text.muted}>Free model: no usage limit.</text>
          </Show>
        </box>

        <Show when={usage()}>
          {(value) => (
            <box>
              <text
                fg={short() ? theme.text.feedback.error.base : theme.text.base}
                attributes={TextAttributes.BOLD}
              >
                {formatDollars(value().left)} remaining
              </text>
              <text fg={theme.text.muted}>Resets {resetText(value().resetsAt)}</text>
              <box paddingTop={1}>
                <text fg={theme.text.muted}>Limits</text>
                <For each={value().limits}>
                  {(item, index) => (
                    <box>
                      <text fg={theme.text.base}>
                        <span
                          style={{
                            fg:
                              index() > 0
                                ? theme.text.muted
                                : value().reached
                                  ? theme.text.feedback.error.base
                                  : theme.text.feedback.warning.base,
                          }}
                        >
                          {index() === 0 ? "•" : "-"}{" "}
                        </span>
                        {formatDollars(item.spent)} used of {formatDollars(item.budget.limit)}
                      </text>
                      <box paddingLeft={2}>
                        <text fg={theme.text.muted} wrapMode="word">
                          {limitScope(item.budget, workspace())}
                        </text>
                        <text fg={theme.text.muted}>Resets {resetText(item.budget.resetsAt)}</text>
                      </box>
                    </box>
                  )}
                </For>
              </box>
            </box>
          )}
        </Show>

        <Show when={go()}>
          {(value) => (
            <box>
              <text fg={theme.text.muted}>OpenCode Go allowance</text>
              <For each={["rolling", "weekly", "monthly"] as const}>
                {(window) => (
                  <text fg={theme.text.base}>
                    {window[0].toUpperCase() + window.slice(1)}: {Math.round(value()[window].percent)}% used
                    <span style={{ fg: theme.text.muted }}> · resets {resetText(value()[window].resetsAt)}</span>
                  </text>
                )}
              </For>
            </box>
          )}
        </Show>

        <Show when={!usage() && !free() && !go()}>
          <text fg={theme.text.muted} wrapMode="word">
            No usage limit is known for this model. Its provider may still rate-limit requests; check the provider's
            dashboard for those limits.
          </text>
        </Show>
      </box>
    </DialogLayout>
  )
}

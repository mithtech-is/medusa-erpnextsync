import React, { useCallback, useEffect, useMemo, useState } from "react"
import { defineRouteConfig } from "@medusajs/admin-sdk"
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  StatusBadge,
  Switch,
  Text,
  Textarea,
} from "@medusajs/ui"
import { ArrowsPointingOut, Plus, Trash } from "@medusajs/icons"

/**
 * /app/erpnext — ERPNext / Frappe sync admin page.
 *
 * Tabs:
 *   - Settings : URL, webhook secret, API key/secret, retry knobs.
 *                "Test connection" pings frappe.auth.get_logged_user.
 *   - Push     : manual fan-out of customers / orders / products /
 *                customer KYC. Useful for back-fill, repaving after a
 *                Frappe-side outage, or pushing entities that predate
 *                the live event-bus subscriber.
 *   - Pull     : preview ERPNext doctype rows via the Frappe resource
 *                API (Item by default). Read-only — the write-back-to-
 *                Medusa half is intentionally an operator decision.
 *   - Events   : the `erpnext_sync_event` log with status filters and a
 *                per-row retry button.
 */

type SettingsView = {
  exists: boolean
  enable_sync: boolean
  erpnext_url: string | null
  frappe_receive_method: string
  webhook_secret_masked: string | null
  frappe_to_medusa_secret_masked: string | null
  erpnext_api_key_masked: string | null
  erpnext_api_secret_masked: string | null
  request_timeout_ms: number
  auto_retry_failed: boolean
  auto_retry_max_attempts: number
  auto_retry_min_interval_minutes: number
  last_full_resync_at: string | null
  push_allowlist: string | null
  log_retention_days: number
  notes: string | null
  updated_by_user_id: string | null
  env_fallback: {
    erpnext_url: string | null
    webhook_secret_present: boolean
  }
}

type EventRow = {
  id: string
  event: string
  event_id: string
  status: "pending" | "success" | "failed" | "skipped"
  attempts: number
  last_attempt_at: string | null
  succeeded_at: string | null
  last_error: string | null
  target_url: string | null
}

type Tab = "settings" | "mappings" | "pull" | "events"

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "settings", label: "Settings" },
  // Mappings — Medusa-side `erpnext_mapping` rows, edited via the
  // doctype-introspection mapper at the bottom of this file.
  // Replaces the earlier Frappe-proxy MappingsTab (dead code retained
  // briefly below the new component for reference; remove once the
  // new editor is battle-tested).
  { key: "mappings", label: "Mappings" },
  { key: "pull", label: "Pull" },
  { key: "events", label: "Events" },
]

const ErpnextPage = () => {
  const [tab, setTab] = useState<Tab>("settings")
  const [view, setView] = useState<SettingsView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/admin/erpnext/settings", {
        credentials: "include",
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.message || "load_failed")
      setView(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <Container>
      <div className="mb-4 flex items-center gap-2">
        <ArrowsPointingOut />
        <Heading level="h1">ERPNext sync</Heading>
        {view?.enable_sync ? (
          <StatusBadge color="green">on</StatusBadge>
        ) : (
          <StatusBadge color="grey">off</StatusBadge>
        )}
      </div>
      <Text size="small" className="text-ui-fg-subtle mb-4">
        Bidirectional sync with the Frappe sync app. Push fires on
        every Medusa event automatically; the buttons here are for
        back-fill or replay. Pull is read-only — review then decide what
        to write back into Medusa.
      </Text>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
          <Text>{error}</Text>
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button
            key={t.key}
            variant={tab === t.key ? "primary" : "secondary"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {!view && loading && <Text>Loading…</Text>}
      {view && tab === "settings" && (
        <SettingsTab view={view} onSaved={(v) => setView(v)} />
      )}
      {view && tab === "mappings" && <MappingsTab onJumpToTab={setTab} />}
      {view && tab === "pull" && <PullTab />}
      {view && tab === "events" && <EventsTab />}
    </Container>
  )
}

// ─────────────────────────────────────────────────────────────────
// Settings tab
// ─────────────────────────────────────────────────────────────────

const SettingsTab: React.FC<{
  view: SettingsView
  onSaved: (v: SettingsView) => void
}> = ({ view, onSaved }) => {
  const [enableSync, setEnableSync] = useState(view.enable_sync)
  const [url, setUrl] = useState(view.erpnext_url ?? "")
  const [receiveMethod, setReceiveMethod] = useState(
    view.frappe_receive_method ?? "",
  )
  // Three secret fields. Empty = leave-as-is, null sentinel = clear,
  // value = update. Mirrors cashfree-settings UX.
  const [webhookSecret, setWebhookSecret] = useState("")
  const [frappeToMedusaSecret, setFrappeToMedusaSecret] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [apiSecret, setApiSecret] = useState("")
  const [timeoutMs, setTimeoutMs] = useState(view.request_timeout_ms)
  const [autoRetry, setAutoRetry] = useState(view.auto_retry_failed)
  const [retryMax, setRetryMax] = useState(view.auto_retry_max_attempts)
  const [retryInterval, setRetryInterval] = useState(
    view.auto_retry_min_interval_minutes,
  )
  const [pushAllowlist, setPushAllowlist] = useState(view.push_allowlist ?? "")
  const [logRetentionDays, setLogRetentionDays] = useState(
    view.log_retention_days ?? 180,
  )
  /** A freshly generated secret, shown once so it can be copied into
   *  Frappe. Cleared on save — we never re-display a stored secret. */
  const [freshSecret, setFreshSecret] = useState<
    { field: "webhook" | "f2m"; value: string } | null
  >(null)

  /** 32 random bytes as hex, from the browser's CSPRNG. Generating here
   *  rather than asking the operator to invent one removes the two ways
   *  this goes wrong: a weak secret, and a typo when transcribing the
   *  same value into two systems. */
  const generateSecret = (field: "webhook" | "f2m") => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    if (field === "webhook") setWebhookSecret(hex)
    else setFrappeToMedusaSecret(hex)
    setFreshSecret({ field, value: hex })
  }
  const [notes, setNotes] = useState(view.notes ?? "")
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pingResult, setPingResult] = useState<{
    ok: boolean
    message?: string
    user?: string
    httpStatus?: number
  } | null>(null)
  const [pinging, setPinging] = useState(false)

  useEffect(() => {
    setEnableSync(view.enable_sync)
    setUrl(view.erpnext_url ?? "")
    setReceiveMethod(view.frappe_receive_method ?? "")
    setWebhookSecret("")
    setFrappeToMedusaSecret("")
    setApiKey("")
    setApiSecret("")
    setTimeoutMs(view.request_timeout_ms)
    setAutoRetry(view.auto_retry_failed)
    setRetryMax(view.auto_retry_max_attempts)
    setRetryInterval(view.auto_retry_min_interval_minutes)
    setPushAllowlist(view.push_allowlist ?? "")
    setLogRetentionDays(view.log_retention_days ?? 180)
    setNotes(view.notes ?? "")
  }, [view])

  const save = async () => {
    setSaving(true)
    setErr(null)
    setFlash(null)
    try {
      const body: Record<string, unknown> = {
        enable_sync: enableSync,
        erpnext_url: url.trim() || null,
        frappe_receive_method: receiveMethod.trim() || null,
        request_timeout_ms: timeoutMs,
        auto_retry_failed: autoRetry,
        auto_retry_max_attempts: retryMax,
        auto_retry_min_interval_minutes: retryInterval,
        push_allowlist: pushAllowlist.trim() || null,
        log_retention_days: Number(logRetentionDays) || 0,
        notes: notes.trim() || null,
      }
      // Only include secret fields if user typed something — empty
      // string would mean "leave as-is" but the API treats absent the
      // same way, so just don't send them.
      if (webhookSecret) body.webhook_secret = webhookSecret
      if (frappeToMedusaSecret)
        body.frappe_to_medusa_secret = frappeToMedusaSecret
      if (apiKey) body.erpnext_api_key = apiKey
      if (apiSecret) body.erpnext_api_secret = apiSecret

      const res = await fetch("/admin/erpnext/settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || "save_failed")
      onSaved(data)
      setFlash("Saved")
      setTimeout(() => setFlash(null), 2500)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save_failed")
    } finally {
      setSaving(false)
    }
  }

  const ping = async () => {
    setPinging(true)
    setPingResult(null)
    try {
      const res = await fetch("/admin/erpnext/ping", {
        method: "POST",
        credentials: "include",
      })
      const body = await res.json()
      setPingResult(body)
    } catch (e) {
      setPingResult({
        ok: false,
        message: e instanceof Error ? e.message : "ping_failed",
      })
    } finally {
      setPinging(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded border border-ui-border-base p-4">
        <div className="mb-3 flex items-center justify-between">
          <Heading level="h2">Connection</Heading>
          <div className="flex items-center gap-2">
            <Label className="text-ui-fg-subtle">Sync enabled</Label>
            <Switch checked={enableSync} onCheckedChange={setEnableSync} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3">
          <div>
            <Label>ERPNext URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://erp.example.com"
            />
            {view.env_fallback.erpnext_url && (
              <Text size="small" className="text-ui-fg-subtle">
                Env fallback: {view.env_fallback.erpnext_url}
              </Text>
            )}
          </div>

          <div>
            <Label>Frappe receive method</Label>
            <Input
              value={receiveMethod}
              onChange={(e) => setReceiveMethod(e.target.value)}
              placeholder="medusync.api.receive"
            />
            <Text size="small" className="text-ui-fg-subtle">
              Whitelisted Frappe method that receives pushes. The mapped
              push appends <code>_mapped</code>. Leave blank to use the
              default (<code>medusync.api.receive</code>).
            </Text>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <div className="flex items-center justify-between">
                <Label>Medusa → Frappe secret</Label>
                <Button
                  size="small"
                  variant="transparent"
                  onClick={() => generateSecret("webhook")}
                >
                  Generate
                </Button>
              </div>
              <Input
                type="password"
                placeholder={view.webhook_secret_masked ?? "(unset)"}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
              <Text size="small" className="text-ui-fg-subtle">
                Signs pushes going OUT to Frappe. Click Generate, save,
                then copy it into <strong>Medusa Settings → Medusa
                Webhook Secret</strong> (or Medusync Settings → Inbound
                Secret) on the Frappe side. You never need to invent one
                or type it in twice.
              </Text>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label>Frappe → Medusa secret</Label>
                <Button
                  size="small"
                  variant="transparent"
                  onClick={() => generateSecret("f2m")}
                >
                  Generate
                </Button>
              </div>
              <Input
                type="password"
                placeholder={
                  view.frappe_to_medusa_secret_masked ?? "(unset)"
                }
                value={frappeToMedusaSecret}
                onChange={(e) => setFrappeToMedusaSecret(e.target.value)}
              />
              <Text size="small" className="text-ui-fg-subtle">
                Verifies pushes coming IN from Frappe. Generate here, then
                copy it into <strong>Medusync Settings → Outbound
                Secret</strong> (or onto each Frappe Webhook row, if you
                use those instead).
              </Text>
            </div>
            <div>
              <Label>API key</Label>
              <Input
                placeholder={view.erpnext_api_key_masked ?? "(unset)"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <Label className="mt-2">API secret</Label>
              <Input
                type="password"
                placeholder={view.erpnext_api_secret_masked ?? "(unset)"}
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
              />
              <Text size="small" className="text-ui-fg-subtle">
                Token-auth for REST pulls + the seeders.
              </Text>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={saving} variant="primary">
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button onClick={ping} disabled={pinging} variant="secondary">
            {pinging ? "Pinging…" : "Test connection"}
          </Button>
          <Button
            onClick={async () => {
              setErr(null)
              const r = await fetch("/admin/erpnext/seed-mappings", {
                method: "POST",
                credentials: "include",
              })
              const b = await r.json()
              setFlash(
                `Mappings seeded: ${b.seeded?.length ?? 0}, skipped: ${b.skipped?.length ?? 0}, errors: ${b.errors?.length ?? 0}`,
              )
            }}
            variant="secondary"
          >
            Reseed canonical mappings
          </Button>
          <Button
            onClick={async () => {
              setErr(null)
              const r = await fetch(
                "/admin/erpnext/seed-frappe-webhooks",
                {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    medusa_base_url:
                      window.location.origin || undefined,
                  }),
                },
              )
              const b = await r.json()
              if (r.ok) {
                setFlash(
                  `Frappe webhooks seeded: ${b.seeded?.length ?? 0}, skipped: ${b.skipped?.length ?? 0}, errors: ${b.errors?.length ?? 0}`,
                )
              } else {
                setErr(b.message ?? "seed_frappe_webhooks_failed")
              }
            }}
            variant="secondary"
          >
            Reseed Frappe webhooks
          </Button>
          {flash && <StatusBadge color="green">{flash}</StatusBadge>}
          {err && (
            <Text size="small" className="text-red-600">
              {err}
            </Text>
          )}
        </div>

        {pingResult && (
          <div
            className={`mt-3 rounded border px-3 py-2 ${
              pingResult.ok
                ? "border-green-200 bg-green-50"
                : "border-red-200 bg-red-50"
            }`}
          >
            <Text size="small">
              {pingResult.ok
                ? `OK · authenticated as ${pingResult.user ?? "(unknown)"}`
                : `Failed${pingResult.httpStatus ? ` (HTTP ${pingResult.httpStatus})` : ""}: ${pingResult.message}`}
            </Text>
          </div>
        )}
      </section>

      <section className="rounded border border-ui-border-base p-4">
        <Heading level="h2" className="mb-3">
          Retry & timeouts
        </Heading>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <Label>Request timeout (ms)</Label>
            <Input
              type="number"
              min={1000}
              max={120_000}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
            />
          </div>
          <div>
            <Label>Auto-retry max attempts</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={retryMax}
              onChange={(e) => setRetryMax(Number(e.target.value) || 0)}
            />
          </div>
          <div>
            <Label>Auto-retry interval (min)</Label>
            <Input
              type="number"
              min={1}
              max={1440}
              value={retryInterval}
              onChange={(e) =>
                setRetryInterval(Number(e.target.value) || 0)
              }
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Label className="text-ui-fg-subtle">Auto-retry failed events</Label>
          <Switch checked={autoRetry} onCheckedChange={setAutoRetry} />
        </div>
      </section>

      {freshSecret && (
        <section className="rounded border border-ui-tag-green-border bg-ui-tag-green-bg p-4">
          <Heading level="h2" className="mb-2">
            New secret generated — copy it into Frappe now
          </Heading>
          <Text className="mb-2 text-xs">
            Shown once. It is stored masked, so this is the only chance to
            copy it. Save this page first, then paste it on the Frappe
            side at{" "}
            {freshSecret.field === "webhook" ? (
              <>
                <strong>Medusa Settings → Medusa Webhook Secret</strong> (or{" "}
                <strong>Medusync Settings → Inbound Secret</strong>)
              </>
            ) : (
              <>
                <strong>Medusync Settings → Outbound Secret</strong>
              </>
            )}
            . Until both sides match, that direction returns 401.
          </Text>
          <div className="flex gap-2">
            <Input readOnly value={freshSecret.value} className="font-mono text-xs" />
            <Button
              size="small"
              variant="secondary"
              onClick={() => navigator.clipboard?.writeText(freshSecret.value)}
            >
              Copy
            </Button>
            <Button size="small" variant="transparent" onClick={() => setFreshSecret(null)}>
              Done
            </Button>
          </div>
        </section>
      )}

      <section className="rounded border border-ui-border-base p-4">
        <Heading level="h2" className="mb-3">
          Sync log retention
        </Heading>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={1825}
            value={logRetentionDays}
            onChange={(e) => setLogRetentionDays(Number(e.target.value))}
            className="w-32"
          />
          <Text className="text-ui-fg-subtle">days</Text>
        </div>
        <Text className="mt-1 text-xs text-ui-fg-subtle">
          How long every sync attempt — succeeded, failed and skipped —
          stays queryable in the Events tab. Default 180 days. Set 0 to
          keep forever, but note these rows carry the synced payload, so
          on a Customer mapping that is a second copy of personal data.
        </Text>
      </section>

      <section className="rounded border border-ui-border-base p-4">
        <Heading level="h2" className="mb-3">
          Outbound allowlist
        </Heading>
        <Text className="mb-2 text-xs text-ui-fg-subtle">
          Leave empty to sync every record — that is the normal setting.
          When this has entries, ONLY records matching one of them are
          pushed to ERPNext; everything else is skipped and shown in the
          Events tab as <code>not_in_allowlist</code>. Use it when this
          Medusa points at a non-production ERPNext and you want the real
          path exercised on a few records without sending everyone's
          personal data there. One per line — a customer id, email,
          product handle, order display id, or ISIN. Decoy records are
          always excluded regardless of this setting.
        </Text>
        <Textarea
          rows={4}
          value={pushAllowlist}
          onChange={(e) => setPushAllowlist(e.target.value)}
          placeholder={"cus_01ABC…\nsomeone@example.com\nINE0DJ201029"}
        />
        {pushAllowlist.trim() && (
          <Text className="mt-2 text-xs text-ui-tag-orange-text">
            Restricted: only{" "}
            {pushAllowlist.split(/[\n,;]+/).filter((x) => x.trim()).length}{" "}
            record(s) will sync outbound. Clear this box to resume full sync.
          </Text>
        )}
      </section>

      <section className="rounded border border-ui-border-base p-4">
        <Heading level="h2" className="mb-3">
          Notes
        </Heading>
        <Textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything ops should know about this Frappe instance…"
        />
      </section>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────
// Pull tab
// ─────────────────────────────────────────────────────────────────

// The three doctypes this connector syncs, shown as friendly choices so a
// non-technical operator never has to know Frappe's exact capitalisation.
const PULL_DOCTYPE_CHOICES = ["Customer", "Item", "Sales Order"] as const

// Frappe DocType names are case- and space-sensitive: "customer" 500s, only
// "Customer" resolves. Forgive the common lowercase/plural typos before the
// request goes out so a fat-fingered entry still works.
const DOCTYPE_ALIASES: Record<string, string> = {
  customer: "Customer",
  customers: "Customer",
  item: "Item",
  items: "Item",
  product: "Item",
  products: "Item",
  "sales order": "Sales Order",
  salesorder: "Sales Order",
  "sales orders": "Sales Order",
  order: "Sales Order",
  orders: "Sales Order",
}

function normalizeDoctype(raw: string): string {
  const trimmed = raw.trim()
  return DOCTYPE_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

const PullTab: React.FC = () => {
  const [doctype, setDoctype] = useState("Customer")
  // "Other…" reveals a free-text box for any doctype the live list can't show.
  const [customDoctype, setCustomDoctype] = useState(false)
  const [limit, setLimit] = useState(50)
  const [fields, setFields] = useState("")
  const [filters, setFilters] = useState("")
  const [running, setRunning] = useState(false)
  const [items, setItems] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Live doctype list from the connected site, so leftover/custom doctypes
  // (e.g. "RISITEX Wallet Settlement") are pickable by exact name instead of
  // typed — which is what caused the earlier case/spelling 500s.
  const [doctypes, setDoctypes] = useState<string[]>([])
  const [dtSearch, setDtSearch] = useState("")
  const [dtLoading, setDtLoading] = useState(false)
  const [dtError, setDtError] = useState<string | null>(null)

  const loadDoctypes = async (search: string) => {
    setDtLoading(true)
    setDtError(null)
    try {
      const url = search
        ? `/admin/erpnext/doctypes?search=${encodeURIComponent(search)}&limit=200`
        : `/admin/erpnext/doctypes?limit=2000`
      const res = await fetch(url, { credentials: "include" })
      const body = await res.json()
      if (!res.ok || body?.ok === false) {
        setDoctypes([])
        setDtError(friendlyErpError(body?.message || `HTTP ${res.status}`))
        return
      }
      setDoctypes(((body.items ?? []) as Array<{ name: string }>).map((i) => i.name))
    } catch (e: any) {
      setDoctypes([])
      setDtError(friendlyErpError(e?.message))
    } finally {
      setDtLoading(false)
    }
  }

  useEffect(() => {
    loadDoctypes("")
  }, [])

  const run = async () => {
    setRunning(true)
    setErr(null)
    setItems(null)
    try {
      const body: Record<string, unknown> = { doctype: normalizeDoctype(doctype), limit }
      if (fields.trim()) {
        body.fields = fields
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      }
      if (filters.trim()) {
        try {
          body.filters = JSON.parse(filters)
        } catch {
          throw new Error("filters must be valid JSON")
        }
      }
      const res = await fetch("/admin/erpnext/pull/items", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || data.ok === false) {
        throw new Error(data.message || "pull_failed")
      }
      setItems(data.items ?? [])
    } catch (e) {
      setErr(friendlyErpError(e instanceof Error ? e.message : "pull_failed"))
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="rounded border border-ui-border-base p-4">
      <Heading level="h2">Pull from ERPNext</Heading>
      <Text size="small" className="text-ui-fg-subtle mb-3">
        Read-only preview against{" "}
        <code className="font-mono">/api/resource/{`<doctype>`}</code>. Uses
        the API key/secret from settings. Response is shown raw — the write-
        back-to-Medusa step is intentionally separate (operator decides
        the field mapping).
      </Text>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <Label>Doctype</Label>
          <Input
            placeholder={
              dtLoading
                ? "loading doctypes…"
                : doctypes.length
                  ? "search doctypes…"
                  : "—"
            }
            value={dtSearch}
            disabled={!doctypes.length && !dtLoading}
            onChange={(e) => {
              setDtSearch(e.target.value)
              loadDoctypes(e.target.value)
            }}
          />
          <select
            className="mt-1 w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm disabled:opacity-50"
            value={customDoctype ? "__other__" : doctype}
            disabled={!doctypes.length && !dtLoading}
            onChange={(e) => {
              if (e.target.value === "__other__") {
                setCustomDoctype(true)
                setDoctype("")
              } else {
                setCustomDoctype(false)
                setDoctype(e.target.value)
              }
            }}
          >
            {/* Common syncs first, then every doctype on the site. */}
            <optgroup label="Common">
              {PULL_DOCTYPE_CHOICES.map((d) => (
                <option key={`c-${d}`} value={d}>
                  {d}
                </option>
              ))}
            </optgroup>
            {doctypes.length > 0 && (
              <optgroup label="All doctypes on this site">
                {doctypes.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="__other__">Other… (type exact name)</option>
          </select>
          {customDoctype && (
            <Input
              className="mt-2"
              value={doctype}
              onChange={(e) => setDoctype(e.target.value)}
              placeholder="Exact Frappe doctype, e.g. Address"
            />
          )}
          {dtError && (
            <Text className="mt-1 text-xs text-ui-fg-error">{dtError}</Text>
          )}
        </div>
        <div>
          <Label>Limit</Label>
          <Input
            type="number"
            min={1}
            max={500}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <Label>Fields (comma-separated, optional)</Label>
          <Input
            value={fields}
            onChange={(e) => setFields(e.target.value)}
            placeholder="name, item_code, item_name"
          />
        </div>
      </div>
      <div className="mt-3">
        <Label>Filters (Frappe JSON, optional)</Label>
        <Textarea
          rows={2}
          value={filters}
          onChange={(e) => setFilters(e.target.value)}
          placeholder='[["disabled","=",0]]'
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={run} disabled={running} variant="primary">
          {running ? "Pulling…" : "Pull"}
        </Button>
        {items && (
          <Text size="small" className="text-ui-fg-subtle">
            {items.length} row(s)
          </Text>
        )}
        {err && (
          <Text size="small" className="text-red-600">
            {err}
          </Text>
        )}
      </div>

      {items && items.length > 0 && (
        <pre className="mt-4 max-h-96 overflow-auto rounded bg-ui-bg-subtle p-3 text-xs">
          {JSON.stringify(items, null, 2)}
        </pre>
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────
// Events tab
// ─────────────────────────────────────────────────────────────────

const EventsTab: React.FC = () => {
  const [status, setStatus] = useState<"" | EventRow["status"]>("")
  const [rows, setRows] = useState<EventRow[] | null>(null)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams()
      if (status) qs.set("status", status)
      qs.set("limit", "100")
      const res = await fetch(`/admin/erpnext/events?${qs}`, {
        credentials: "include",
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || "load_failed")
      setRows(data.items)
      setCount(data.count)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load_failed")
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    refresh()
  }, [refresh])

  const retry = async (eventId: string) => {
    setRetryingId(eventId)
    try {
      const res = await fetch(
        `/admin/erpnext/events/${encodeURIComponent(eventId)}/retry`,
        { method: "POST", credentials: "include" },
      )
      await res.json().catch(() => ({}))
    } finally {
      setRetryingId(null)
      refresh()
    }
  }

  return (
    <section className="rounded border border-ui-border-base p-4">
      <div className="mb-3 flex items-center justify-between">
        <Heading level="h2">Sync events</Heading>
        <div className="flex items-center gap-2">
          {(["", "pending", "success", "failed", "skipped"] as const).map(
            (s) => (
              <Button
                key={s || "all"}
                size="small"
                variant={status === s ? "primary" : "secondary"}
                onClick={() => setStatus(s)}
              >
                {s || "all"}
              </Button>
            ),
          )}
          <Button size="small" variant="secondary" onClick={refresh}>
            ↻
          </Button>
        </div>
      </div>

      {loading && <Text>Loading…</Text>}
      {err && (
        <Text size="small" className="text-red-600">
          {err}
        </Text>
      )}

      {rows && rows.length === 0 && (
        <Text className="text-ui-fg-subtle">No events.</Text>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ui-border-base text-ui-fg-subtle">
                <th className="py-2 text-left">Event</th>
                <th className="py-2 text-left">Status</th>
                <th className="py-2 text-left">Attempts</th>
                <th className="py-2 text-left">Last attempt</th>
                <th className="py-2 text-left">Last error</th>
                <th className="py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-ui-border-base">
                  <td className="py-2">
                    <code className="font-mono text-xs">{r.event}</code>
                    <div className="text-ui-fg-subtle text-xs">
                      {r.event_id}
                    </div>
                  </td>
                  <td className="py-2">
                    <StatusBadge color={statusColor(r.status)}>
                      {r.status}
                    </StatusBadge>
                  </td>
                  <td className="py-2">{r.attempts}</td>
                  <td className="py-2">
                    {r.last_attempt_at
                      ? new Date(r.last_attempt_at).toLocaleString()
                      : "—"}
                  </td>
                  <td className="py-2 max-w-xs truncate" title={r.last_error ?? ""}>
                    {r.last_error ?? "—"}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={retryingId === r.event_id}
                      onClick={() => retry(r.event_id)}
                    >
                      {retryingId === r.event_id ? "…" : "Retry"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Text size="small" className="text-ui-fg-subtle mt-2">
            Showing {rows.length} of {count}
          </Text>
        </div>
      )}
    </section>
  )
}

function statusColor(s: EventRow["status"]): "green" | "red" | "grey" | "orange" {
  switch (s) {
    case "success":
      return "green"
    case "failed":
      return "red"
    case "pending":
      return "orange"
    default:
      return "grey"
  }
}



// ─────────────────────────────────────────────────────────────────
// Mappings tab — generic operator-defined sync rules.
//
// Each mapping pairs one Medusa entity (driven by the static
// registry at modules/erpnext/registry.ts) with one Frappe doctype
// (introspected live via frappe.client.get_meta) and lists field-by-
// field pairs with optional per-field transforms + direction
// overrides. Storage is Medusa-side (`erpnext_mapping` table) —
// no dependency on a Frappe Single doctype for the field config.
//
// Two views inside the tab:
//   - list  → enable toggles, last-run state, delete
//   - edit  → entity/doctype/events/direction + field-pair builder
//             + Test (dry-run) + Pull-now buttons
// ─────────────────────────────────────────────────────────────────

type MedusaEntity = {
  key: string
  label: string
  module_name: string
  is_custom_module: boolean
  events: string[]
  default_key_path: string
  paths: Array<{
    path: string
    label: string
    type: string
    description?: string
    suggested_transform?: string
  }>
}

type DoctypeField = {
  fieldname: string
  label: string
  fieldtype: string
  reqd?: number
  options?: string | null
  in_list_view?: number
  hidden?: number
  read_only?: number
  default?: string | null
  fetch_from?: string | null
}

/** Per-row provenance from /admin/erpnext/mappings/autofill. Display
 *  only — never persisted with the mapping. */
type AutofillAnnotation = {
  erpnext_field: string
  erpnext_label: string
  fieldtype: string
  reqd: boolean
  medusa_path: string
  transform: string | null
  default?: unknown
  direction: "push" | "pull" | "both"
  confidence:
    | "canonical"
    | "composite"
    | "exact"
    | "synonym"
    | "strong"
    | "weak"
    | "none"
  why: string
}

/** Badge colour + label per confidence tier. `weak` and `none` are the
 *  two the operator actually has to look at, so they get the warm
 *  colours; everything else is quiet. */
const CONFIDENCE_META: Record<
  AutofillAnnotation["confidence"],
  { label: string; color: "green" | "blue" | "grey" | "orange" | "red" }
> = {
  canonical: { label: "canonical", color: "green" },
  composite: { label: "combined", color: "blue" },
  exact: { label: "exact", color: "green" },
  synonym: { label: "synonym", color: "blue" },
  strong: { label: "likely", color: "grey" },
  weak: { label: "check this", color: "orange" },
  none: { label: "no match", color: "red" },
}

type FieldPair = {
  medusa_path: string
  erpnext_field: string
  direction?: "push" | "pull" | "both"
  transform?: string
  default?: unknown
  required?: boolean
}

type Mapping = {
  id: string
  name: string
  description: string | null
  enabled: boolean
  medusa_entity: string
  doctype: string
  direction: "push" | "pull" | "both"
  events: string[] | null
  pull_filter: any[] | null
  pull_page_size: number
  key_medusa_field: string
  key_erpnext_field: string
  field_mappings: FieldPair[]
  trigger_preset: string
  trigger_condition: string | null
  skip_unchanged: boolean
  allow_create: boolean
  allow_update: boolean
  last_pull_at: string | null
  last_pull_run_at: string | null
  last_pull_error: string | null
  last_push_run_at: string | null
  last_push_error: string | null
  updated_at: string
}

type Direction = "push" | "pull" | "both"

/**
 * What each direction actually requires on the ERPNext side. Operators
 * ask "do I need to install something?" constantly — the honest answer
 * differs per direction, so say it at the point of choosing.
 */
const DIRECTION_HELP: Record<Direction, string> = {
  push: "Medusa events write into ERPNext over the REST API. Needs only the API key in Settings — nothing installed on ERPNext.",
  pull: "A cron polls ERPNext every 5 min for rows changed since the last run. Needs only the API key. For instant updates instead of 5-minute ones, seed the Frappe webhooks from the Settings tab.",
  both: "Both of the above on the same record. Per-field overrides below decide which side owns each field — set a field to one-way to stop the other side overwriting it.",
}

/**
 * Mirrors TRIGGER_PRESETS in modules/erpnext/trigger.ts. Duplicated
 * rather than imported because the admin bundle is compiled separately
 * from the server code and cannot reach into the module directory.
 * The server re-derives the condition on save, so the two can only
 * disagree about the LABEL, never about behaviour.
 */
const TRIGGER_PRESETS = [
  { value: "always", label: "Always — every matching event", condition: "",
    help: "Sync on every event listed above, with no further filtering." },
  { value: "kyc_verified", label: "Only once KYC is fully verified",
    condition: "metadata.kyc_fully_approved_at is set",
    help: "Holds the record back until an admin has signed off every KYC check." },
  { value: "has_purchased", label: "Only once they have bought something",
    condition: "orders_count > 0",
    help: "Waits for a completed order — keeps browsers and abandoned signups out of ERPNext." },
  { value: "has_value", label: "Only once the key field has a value", condition: "",
    help: "Fires as soon as the key field is populated. Pair with \u2018skip when nothing changed\u2019 to sync each value as it is entered." },
  { value: "custom", label: "Custom condition", condition: "",
    help: "Dot-paths are read off the record. e.g. metadata.kyc_status == \"approved\" and email is not empty" },
]

const TRANSFORM_OPTIONS = [
  { value: "", label: "(no transform)" },
  { value: "lowercase", label: "lowercase" },
  { value: "uppercase", label: "uppercase" },
  { value: "trim", label: "trim whitespace" },
  { value: "number", label: "→ number" },
  { value: "integer", label: "→ integer" },
  { value: "boolean", label: "→ boolean" },
  { value: "json", label: "JSON stringify" },
  { value: "split:,", label: "split by comma → array" },
  { value: "join:,", label: "join array by comma → string" },
  { value: "date_iso", label: "→ ISO datetime" },
  { value: "date_yyyy_mm_dd", label: "→ YYYY-MM-DD" },
]

// ─── Guided setup (plain-language wizard for non-technical admins) ────
//
// The advanced MappingEditor below exposes every knob. Most operators
// only ever want the three standard syncs, so this wizard fronts them:
// pick WHAT to sync (Customers / Products / Orders), tick the fields to
// keep in step, choose WHICH WAY, done. Each preset is exactly the
// mapping the advanced editor would produce — nothing here the editor
// can't also do.

type WizardField = {
  medusa_path: string
  erpnext_field: string
  direction: Direction
  transform?: string
  /** Friendly label shown in the wizard; stripped before saving. */
  label: string
  /** Whether this pair is included by default. */
  on: boolean
  /** Advanced/plumbing pairs are collapsed unless the operator expands. */
  advanced?: boolean
}

type SyncPreset = {
  key: string
  emoji: string
  title: string
  blurb: string
  doctype: string
  medusa_entity: string
  events: string[]
  key_medusa_field: string
  key_erpnext_field: string
  defaultDirection: Direction
  /** Which directions the operator may choose for this sync. */
  directions: Direction[]
  note?: string
  fields: WizardField[]
}

const SYNC_PRESETS: SyncPreset[] = [
  {
    key: "customers",
    emoji: "👤",
    title: "Customers",
    blurb: "Keep buyer accounts in step — name, email, phone.",
    doctype: "Customer",
    medusa_entity: "customer",
    events: ["customer.created", "customer.updated", "customer.deleted"],
    key_medusa_field: "email",
    key_erpnext_field: "email_id",
    defaultDirection: "both",
    directions: ["both", "push", "pull"],
    fields: [
      { medusa_path: "email", erpnext_field: "email_id", direction: "both", transform: "lowercase", label: "Email", on: true },
      { medusa_path: "first_name", erpnext_field: "customer_name", direction: "both", label: "Name", on: true },
      { medusa_path: "phone", erpnext_field: "mobile_no", direction: "both", label: "Phone", on: true },
      { medusa_path: "id", erpnext_field: "medusa_customer_id", direction: "push", label: "Medusa link id", on: true, advanced: true },
    ],
  },
  {
    key: "products",
    emoji: "📦",
    title: "Products",
    blurb: "Mirror your catalogue as ERPNext Items.",
    doctype: "Item",
    medusa_entity: "product",
    events: ["product.created", "product.updated", "product.deleted"],
    key_medusa_field: "handle",
    key_erpnext_field: "item_code",
    defaultDirection: "both",
    directions: ["both", "push", "pull"],
    fields: [
      { medusa_path: "handle", erpnext_field: "item_code", direction: "both", transform: "lowercase", label: "Code (URL handle)", on: true },
      { medusa_path: "title", erpnext_field: "item_name", direction: "both", label: "Name", on: true },
      { medusa_path: "description", erpnext_field: "description", direction: "push", label: "Description", on: true },
      { medusa_path: "id", erpnext_field: "medusa_product_id", direction: "push", label: "Medusa link id", on: true, advanced: true },
    ],
  },
  {
    key: "orders",
    emoji: "🧾",
    title: "Orders",
    blurb: "Send each placed order to ERPNext as a Sales Order.",
    doctype: "Sales Order",
    medusa_entity: "order",
    events: ["order.placed", "order.canceled"],
    key_medusa_field: "id",
    key_erpnext_field: "medusa_order_id",
    defaultDirection: "push",
    directions: ["push"],
    note: "Line items, the customer link and amounts are attached automatically. Orders always flow Medusa → ERPNext.",
    fields: [
      { medusa_path: "id", erpnext_field: "medusa_order_id", direction: "push", label: "Order id (link)", on: true },
      { medusa_path: "email", erpnext_field: "contact_email", direction: "push", label: "Customer email", on: true },
    ],
  },
]

const DIRECTION_CHOICE: Record<Direction, { label: string; help: string }> = {
  push: { label: "Medusa → ERPNext", help: "Changes in your store are written to ERPNext." },
  pull: { label: "ERPNext → Medusa", help: "Changes in ERPNext are pulled into your store." },
  both: { label: "Both ways", help: "Keep both sides in step. Per-field rules decide who wins each field." },
}

// When the operator picks a Medusa entity in the mapping editor we surface
// the ERPNext doctype it almost always pairs with at the top of the list,
// so a non-technical admin doesn't have to know Frappe's naming. These are
// the high-confidence pairs only — anything not listed falls back to the
// full searchable doctype list, and every suggestion is intersected with
// the doctypes that actually exist on the connected site before it shows
// (so we never recommend something the site doesn't have).
const ENTITY_DOCTYPE_SUGGESTIONS: Record<string, string[]> = {
  customer: ["Customer"],
  customer_group: ["Customer Group"],
  product: ["Item"],
  product_category: ["Item Group"],
  order: ["Sales Order"],
  currency: ["Currency"],
  user: ["User"],
  stock_location: ["Warehouse"],
  fulfillment: ["Delivery Note"],
  payment_collection: ["Payment Entry"],
  promotion: ["Pricing Rule"],
  region: ["Territory"],
  wallet_settlement: ["RISITEX Wallet Settlement"],
}

// Turn a raw fetch/HTTP failure into one plain sentence an admin can act on.
// The most common real-world cause of "it won't pull" is simply that ERPNext
// isn't running — say that instead of leaking a stack trace or "HTTP 502".
function friendlyErpError(raw: string | null | undefined): string {
  const s = String(raw ?? "")
  if (
    /econnrefused|refused|failed to fetch|networkerror|enotfound|etimedout|timeout|502|503|504|econnreset|socket hang up/i.test(
      s,
    )
  ) {
    return "ERPNext isn't reachable — is it running? Check the ERPNext server and the URL in the Settings tab."
  }
  return s || "Something went wrong talking to ERPNext."
}

const AddSyncWizard: React.FC<{
  onDone: () => void
  onAdvanced: () => void
}> = ({ onDone, onAdvanced }) => {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [presetKey, setPresetKey] = useState<string | null>(null)
  const [fields, setFields] = useState<WizardField[]>([])
  const [direction, setDirection] = useState<Direction>("both")
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string } | null>(null)

  const preset = SYNC_PRESETS.find((p) => p.key === presetKey) || null

  const choose = (p: SyncPreset) => {
    setPresetKey(p.key)
    setFields(p.fields.map((f) => ({ ...f })))
    setDirection(p.defaultDirection)
    setName(`${p.title} ↔ ERPNext`)
    setError(null)
    setStep(2)
  }

  const save = async () => {
    if (!preset) return
    setBusy(true)
    setError(null)
    try {
      const field_mappings = fields
        .filter((f) => f.on)
        .map((f) => ({
          medusa_path: f.medusa_path,
          erpnext_field: f.erpnext_field,
          direction: f.direction,
          ...(f.transform ? { transform: f.transform } : {}),
        }))
      const draft = {
        name: name.trim() || `${preset.title} ↔ ERPNext`,
        enabled: true,
        medusa_entity: preset.medusa_entity,
        doctype: preset.doctype,
        direction,
        events: preset.events,
        trigger_preset: "always",
        trigger_condition: "",
        skip_unchanged: false,
        allow_create: true,
        allow_update: true,
        pull_filter: null,
        pull_page_size: 200,
        key_medusa_field: preset.key_medusa_field,
        key_erpnext_field: preset.key_erpnext_field,
        field_mappings,
      }
      const res = await fetch("/admin/erpnext/mappings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.message || "Could not save")
      setDone({ id: body?.mapping?.id ?? body?.id ?? "" })
    } catch (e: any) {
      setError(e?.message ?? "Could not save")
    } finally {
      setBusy(false)
    }
  }

  // Step dots
  const Dots = () => (
    <div className="mb-5 flex items-center gap-2 text-xs text-ui-fg-subtle">
      {["Choose", "Set up", "Review"].map((s, i) => (
        <span key={s} className="flex items-center gap-2">
          <span
            className={
              "flex h-5 w-5 items-center justify-center rounded-full text-[11px] " +
              (step >= (i + 1)
                ? "bg-ui-bg-interactive text-ui-fg-on-color"
                : "bg-ui-bg-base-hover")
            }
          >
            {i + 1}
          </span>
          <span className={step === i + 1 ? "text-ui-fg-base" : ""}>{s}</span>
          {i < 2 && <span className="mx-1">→</span>}
        </span>
      ))}
    </div>
  )

  if (done) {
    return (
      <div className="rounded-lg border p-6 text-center">
        <div className="mb-2 text-2xl">✅</div>
        <Heading level="h2" className="mb-1">You're all set</Heading>
        <Text className="mb-4 text-ui-fg-subtle">
          “{name}” is now syncing. You can fine-tune every detail any time from the mappings list.
        </Text>
        <Button variant="primary" onClick={onDone}>Back to syncs</Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Button variant="secondary" size="small" onClick={onDone}>← Cancel</Button>
        <Button variant="transparent" size="small" onClick={onAdvanced}>
          Advanced editor instead
        </Button>
      </div>
      <Dots />
      {error && <Text className="text-ui-fg-error">{error}</Text>}

      {step === 1 && (
        <div>
          <Heading level="h2" className="mb-1">What do you want to keep in sync?</Heading>
          <Text className="mb-4 text-ui-fg-subtle">Pick one to start. You can add more later.</Text>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {SYNC_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => choose(p)}
                className="rounded-lg border p-4 text-left transition hover:border-ui-border-interactive hover:bg-ui-bg-base-hover"
              >
                <div className="mb-1 text-2xl">{p.emoji}</div>
                <div className="mb-1 font-medium">{p.title}</div>
                <Text className="text-xs text-ui-fg-subtle">{p.blurb}</Text>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && preset && (
        <div className="space-y-5">
          <div>
            <Heading level="h2" className="mb-1">
              {preset.emoji} {preset.title} — which way should it sync?
            </Heading>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {preset.directions.map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={
                    "rounded-lg border p-3 text-left transition " +
                    (direction === d
                      ? "border-ui-border-interactive bg-ui-bg-base-hover"
                      : "hover:bg-ui-bg-base-hover")
                  }
                >
                  <div className="text-sm font-medium">{DIRECTION_CHOICE[d].label}</div>
                  <Text className="text-xs text-ui-fg-subtle">{DIRECTION_CHOICE[d].help}</Text>
                </button>
              ))}
            </div>
          </div>

          <div>
            <Heading level="h2" className="mb-1">Which details should we keep in step?</Heading>
            <Text className="mb-3 text-ui-fg-subtle">
              These are matched up for you. Turn any off if you don't want it synced.
            </Text>
            <div className="rounded-lg border divide-y">
              {fields.filter((f) => !f.advanced).map((f, i) => {
                const realIdx = fields.indexOf(f)
                return (
                  <div key={i} className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3 text-sm">
                      <span className="font-medium">{f.label}</span>
                      <span className="text-ui-fg-subtle">
                        Medusa <code className="text-xs">{f.medusa_path}</code> ↔ ERPNext <code className="text-xs">{f.erpnext_field}</code>
                      </span>
                    </div>
                    <Switch
                      checked={f.on}
                      onCheckedChange={(v) =>
                        setFields((arr) => arr.map((x, j) => (j === realIdx ? { ...x, on: !!v } : x)))
                      }
                    />
                  </div>
                )
              })}
            </div>
            {fields.some((f) => f.advanced) && (
              <div className="mt-2">
                <Button variant="transparent" size="small" onClick={() => setShowAdvanced((s) => !s)}>
                  {showAdvanced ? "Hide" : "Show"} technical fields
                </Button>
                {showAdvanced && (
                  <div className="mt-2 rounded-lg border divide-y">
                    {fields.filter((f) => f.advanced).map((f) => {
                      const realIdx = fields.indexOf(f)
                      return (
                        <div key={f.erpnext_field} className="flex items-center justify-between p-3">
                          <div className="flex items-center gap-3 text-sm">
                            <span className="font-medium">{f.label}</span>
                            <span className="text-ui-fg-subtle">
                              keeps the two records linked — recommended
                            </span>
                          </div>
                          <Switch
                            checked={f.on}
                            onCheckedChange={(v) =>
                              setFields((arr) => arr.map((x, j) => (j === realIdx ? { ...x, on: !!v } : x)))
                            }
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {preset.note && (
            <div className="rounded-lg border border-ui-border-base bg-ui-bg-subtle p-3">
              <Text className="text-xs text-ui-fg-subtle">ℹ️ {preset.note}</Text>
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(1)}>← Back</Button>
            <Button variant="primary" onClick={() => setStep(3)}>Review →</Button>
          </div>
        </div>
      )}

      {step === 3 && preset && (
        <div className="space-y-4">
          <Heading level="h2">Review &amp; turn it on</Heading>
          <div>
            <Label>Name this sync</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="rounded-lg border p-4 text-sm">
            <div className="mb-2">
              <span className="text-ui-fg-subtle">Syncing </span>
              <strong>{preset.title}</strong>
              <span className="text-ui-fg-subtle"> as ERPNext </span>
              <strong>{preset.doctype}</strong>
            </div>
            <div className="mb-2">
              <span className="text-ui-fg-subtle">Direction: </span>
              <strong>{DIRECTION_CHOICE[direction].label}</strong>
            </div>
            <div className="text-ui-fg-subtle">
              Keeping in step:{" "}
              {fields.filter((f) => f.on).map((f) => f.label).join(", ") || "nothing selected"}
            </div>
          </div>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(2)}>← Back</Button>
            <Button variant="primary" onClick={save} disabled={busy}>
              {busy ? "Turning on…" : "Turn on sync"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

const MappingsTab: React.FC<{ onJumpToTab?: (t: Tab) => void }> = ({
  onJumpToTab,
}) => {
  const [view, setView] = useState<"list" | "edit" | "wizard">("list")
  const [editingId, setEditingId] = useState<string | null>(null)

  const openNew = () => {
    setEditingId(null)
    setView("edit")
  }
  const openWizard = () => {
    setEditingId(null)
    setView("wizard")
  }
  const openEdit = (id: string) => {
    setEditingId(id)
    setView("edit")
  }
  const back = () => {
    setEditingId(null)
    setView("list")
  }

  return (
    <div>
      <Text className="mb-4 text-ui-fg-subtle">
        Choose what to keep in step between your store and ERPNext. Use{" "}
        <strong>Add a sync</strong> for the guided setup, or the advanced editor
        for full control over fields, filters and triggers.
      </Text>
      {view === "list" && (
        <MappingList onOpen={openEdit} onNew={openNew} onWizard={openWizard} />
      )}
      {view === "wizard" && (
        <AddSyncWizard onDone={back} onAdvanced={openNew} />
      )}
      {view === "edit" && (
        <MappingEditor id={editingId} onBack={back} onJumpToTab={onJumpToTab} />
      )}
    </div>
  )
}
// ─── List view ────────────────────────────────────────────────────────

const MappingList: React.FC<{
  onOpen: (id: string) => void
  onNew: () => void
  onWizard: () => void
}> = ({ onOpen, onNew, onWizard }) => {
  const [items, setItems] = useState<Mapping[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch("/admin/erpnext/mappings", {
        credentials: "include",
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.message || "list_failed")
      setItems(body.items ?? [])
    } catch (e: any) {
      setError(e?.message ?? "failed")
    }
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const toggleEnabled = async (m: Mapping) => {
    await fetch(`/admin/erpnext/mappings/${m.id}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...m, enabled: !m.enabled }),
    })
    refresh()
  }

  const remove = async (m: Mapping) => {
    if (!confirm(`Delete mapping "${m.name}"?`)) return
    await fetch(`/admin/erpnext/mappings/${m.id}`, {
      method: "DELETE",
      credentials: "include",
    })
    refresh()
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <Text weight="plus">{items?.length ?? 0} active {(items?.length ?? 0) === 1 ? "sync" : "syncs"}</Text>
        <div className="flex gap-2">
          <Button size="small" variant="primary" onClick={onWizard}>
            <Plus /> Add a sync
          </Button>
          <Button size="small" variant="secondary" onClick={onNew}>
            Advanced editor
          </Button>
        </div>
      </div>
      {error && <Text className="text-ui-fg-error mb-3">{error}</Text>}
      {!items && <Text>Loading…</Text>}
      {items && items.length === 0 && (
        <div className="rounded-lg border p-8 text-center">
          <div className="mb-2 text-3xl">🔗</div>
          <Heading level="h2" className="mb-1">Nothing is syncing yet</Heading>
          <Text className="mb-4 text-ui-fg-subtle">
            Set up your first sync in a few clicks — pick Customers, Products or Orders and we'll do the rest.
          </Text>
          <Button variant="primary" onClick={onWizard}>
            <Plus /> Add your first sync
          </Button>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="rounded border">
          <table className="w-full text-sm">
            <thead className="bg-ui-bg-base-hover">
              <tr>
                <th className="p-2 text-left">Name</th>
                <th className="p-2 text-left">Medusa</th>
                <th className="p-2 text-left">Frappe doctype</th>
                <th className="p-2 text-left">Direction</th>
                <th className="p-2 text-left">Pairs</th>
                <th className="p-2 text-left">Last run</th>
                <th className="p-2 text-left">Enabled</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2">
                    <a
                      onClick={() => onOpen(m.id)}
                      className="cursor-pointer font-medium text-ui-fg-interactive hover:underline"
                    >
                      {m.name}
                    </a>
                    {m.description && (
                      <div className="text-xs text-ui-fg-subtle">
                        {m.description}
                      </div>
                    )}
                  </td>
                  <td className="p-2">{m.medusa_entity}</td>
                  <td className="p-2">{m.doctype}</td>
                  <td className="p-2">{m.direction}</td>
                  <td className="p-2">{m.field_mappings?.length ?? 0}</td>
                  <td className="p-2 text-xs text-ui-fg-subtle">
                    {m.last_push_run_at && (
                      <div>push: {formatDate(m.last_push_run_at)}</div>
                    )}
                    {m.last_pull_run_at && (
                      <div>pull: {formatDate(m.last_pull_run_at)}</div>
                    )}
                    {m.last_push_error && (
                      <div className="text-ui-fg-error">{m.last_push_error}</div>
                    )}
                    {m.last_pull_error && (
                      <div className="text-ui-fg-error">{m.last_pull_error}</div>
                    )}
                  </td>
                  <td className="p-2">
                    <Switch
                      checked={m.enabled}
                      onCheckedChange={() => toggleEnabled(m)}
                    />
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      size="small"
                      variant="transparent"
                      onClick={() => remove(m)}
                    >
                      <Trash />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Editor ───────────────────────────────────────────────────────────

const MappingEditor: React.FC<{
  id: string | null
  onBack: () => void
  onJumpToTab?: (t: Tab) => void
}> = ({ id, onBack, onJumpToTab }) => {
  const [entities, setEntities] = useState<MedusaEntity[]>([])
  const [doctypes, setDoctypes] = useState<string[]>([])
  const [doctypeSearch, setDoctypeSearch] = useState("")
  const [doctypeFields, setDoctypeFields] = useState<DoctypeField[]>([])
  const [draft, setDraft] = useState<Partial<Mapping>>({
    name: "",
    description: "",
    enabled: true,
    direction: "both",
    trigger_preset: "always",
    trigger_condition: "",
    skip_unchanged: false,
    allow_create: true,
    allow_update: true,
    events: [],
    pull_filter: null,
    pull_page_size: 200,
    key_medusa_field: "",
    key_erpnext_field: "name",
    field_mappings: [],
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testRecordId, setTestRecordId] = useState("")
  const [testResult, setTestResult] = useState<any>(null)

  // Load entities + (when editing) the mapping to be edited.
  useEffect(() => {
    fetch("/admin/erpnext/medusa-entities", { credentials: "include" })
      .then((r) => r.json())
      .then((b) => setEntities(b.items ?? []))
  }, [])

  useEffect(() => {
    if (!id) return
    fetch(`/admin/erpnext/mappings/${id}`, { credentials: "include" })
      .then((r) => r.json())
      .then((b) => {
        if (b?.mapping) {
          setDraft(b.mapping)
          if (b.mapping.doctype) loadDoctypeFields(b.mapping.doctype)
        }
      })
  }, [id])

  // Load doctypes when entities have been resolved (so the form is usable).
  const [doctypesError, setDoctypesError] = useState<string | null>(null)
  const [doctypesLoading, setDoctypesLoading] = useState(false)
  useEffect(() => {
    refreshDoctypes("")
  }, [])

  const refreshDoctypes = async (search: string) => {
    setDoctypesLoading(true)
    setDoctypesError(null)
    try {
      // Full list is fetched large (route clamps to 2000) so the curated
      // per-entity recommendations below are never truncated out.
      const url = search
        ? `/admin/erpnext/doctypes?search=${encodeURIComponent(search)}&limit=200`
        : `/admin/erpnext/doctypes?limit=2000`
      const res = await fetch(url, { credentials: "include" })
      const body = await res.json()
      if (!res.ok || body?.ok === false) {
        // Surface the underlying reason — the most common cause is that
        // ERPNext simply isn't running, or URL / api_key / api_secret
        // aren't set yet (Settings tab).
        setDoctypes([])
        setDoctypesError(
          friendlyErpError(
            body?.message || `Frappe responded HTTP ${res.status}`,
          ),
        )
        return
      }
      const items = (body.items ?? []) as Array<{ name: string }>
      setDoctypes(items.map((i) => i.name))
      if (items.length === 0) {
        setDoctypesError(
          "Frappe returned zero doctypes — the api_key user may lack DocType read permission",
        )
      }
    } catch (e: any) {
      setDoctypes([])
      setDoctypesError(friendlyErpError(e?.message))
    } finally {
      setDoctypesLoading(false)
    }
  }

  const loadDoctypeFields = async (name: string) => {
    if (!name) {
      setDoctypeFields([])
      return
    }
    try {
      const res = await fetch(
        `/admin/erpnext/doctypes/${encodeURIComponent(name)}`,
        { credentials: "include" },
      )
      const body = await res.json()
      setDoctypeFields(body.fields ?? [])
    } catch (e: any) {
      setDoctypeFields([])
      setError(`could not load fields for ${name}: ${e?.message}`)
    }
  }

  const activeEntity = useMemo(
    () => entities.find((e) => e.key === draft.medusa_entity) ?? null,
    [entities, draft.medusa_entity],
  )

  // The ERPNext doctype(s) this entity usually pairs with, narrowed to the
  // ones that actually exist on the connected site. Drives the "Recommended"
  // group in the doctype dropdown and the one-click auto-pick below.
  const recommendedDoctypes = useMemo(() => {
    const wanted = ENTITY_DOCTYPE_SUGGESTIONS[draft.medusa_entity ?? ""] ?? []
    if (!wanted.length || !doctypes.length) return []
    const have = new Set(doctypes)
    return wanted.filter((d) => have.has(d))
  }, [draft.medusa_entity, doctypes])

  const pickEntity = (key: string) => {
    const e = entities.find((x) => x.key === key)
    setDraft((d) => ({
      ...d,
      medusa_entity: key,
      events: e ? e.events : [],
      key_medusa_field: e ? e.default_key_path : "",
    }))
    // Smart shortcut: if this entity has exactly one recommended doctype that
    // exists on the site, select it straight away — that chains into
    // loadDoctypeFields + autofill, so the field grid is ready with no extra
    // clicks. (Only when the doctype isn't already chosen, and the list has
    // loaded so the intersection is meaningful.)
    const wanted = ENTITY_DOCTYPE_SUGGESTIONS[key] ?? []
    const liveWanted = doctypes.length
      ? wanted.filter((d) => doctypes.includes(d))
      : wanted
    if (!draft.doctype && liveWanted.length === 1) {
      pickDoctype(liveWanted[0])
    } else if (draft.doctype) {
      runAutofill(key, draft.doctype)
    }
  }

  const pickDoctype = (name: string) => {
    setDraft((d) => ({ ...d, doctype: name }))
    loadDoctypeFields(name)
    // Build the whole grid for this doctype — mandatory fields plus
    // every field we can guess a Medusa source for. Canonical pairs are
    // folded in server-side and win over the heuristics.
    if (draft.medusa_entity) {
      runAutofill(draft.medusa_entity, name)
    }
  }

  // ── Generic autofill ───────────────────────────────────────────────
  // `suggest` (canonical-only) covers six hand-written pairs. This
  // covers every doctype on the connected site by reading its live
  // field meta. Annotations drive the per-row confidence badges and are
  // dropped on save.
  const [annotations, setAnnotations] = useState<
    Record<string, AutofillAnnotation>
  >({})
  const [autofilling, setAutofilling] = useState(false)
  const [autofillMode, setAutofillMode] = useState<"smart" | "all">("smart")

  const runAutofill = async (
    entity: string,
    doctype: string,
    opts: { force?: boolean; mode?: "smart" | "all" } = {},
  ) => {
    if (!entity || !doctype) return
    // Don't trample an operator mid-edit unless they asked for it.
    if (!opts.force && (draft.field_mappings?.length ?? 0) > 0) return
    setAutofilling(true)
    setSuggestStatus(null)
    try {
      const params = new URLSearchParams({
        entity,
        doctype,
        mode: opts.mode ?? autofillMode,
      })
      if (draft.direction) params.set("direction", draft.direction)
      const r = await fetch(
        `/admin/erpnext/mappings/autofill?${params.toString()}`,
        { credentials: "include" },
      )
      const b = await r.json()
      if (!b?.ok) {
        setSuggestStatus(
          `Could not read "${doctype}" from Frappe: ${b?.message ?? "unknown error"}`,
        )
        return
      }
      const byField: Record<string, AutofillAnnotation> = {}
      for (const a of (b.annotations ?? []) as AutofillAnnotation[]) {
        byField[a.erpnext_field] = a
      }
      setAnnotations(byField)
      setDraft((d) => ({
        ...d,
        key_medusa_field: b.key_medusa_field || d.key_medusa_field,
        key_erpnext_field: b.key_erpnext_field || d.key_erpnext_field,
        events: b.events?.length ? b.events : d.events,
        pull_filter: b.pull_filter ?? d.pull_filter,
        field_mappings: b.field_mappings ?? [],
      }))

      const s = b.summary ?? {}
      const confident =
        (s.canonical ?? 0) + (s.composite ?? 0) + (s.exact ?? 0) + (s.synonym ?? 0)
      const needsReview = (s.weak ?? 0) + (s.none ?? 0)
      setSuggestStatus(
        `Read ${b.total_doctype_fields} fields from "${doctype}". ` +
          `Mapped ${b.field_mappings?.length ?? 0} — ${confident} confident, ` +
          `${s.strong ?? 0} likely${needsReview ? `, ${needsReview} needing your eyes` : ""}.` +
          (b.canonical
            ? " Canonical pairs for this combination were applied first."
            : ""),
      )
    } catch (e: any) {
      setSuggestStatus(`Autofill failed: ${e?.message ?? "network error"}`)
    } finally {
      setAutofilling(false)
    }
  }

  /** Status banner under the Field mappings heading — explains what the
   *  form just did to itself so the grid never appears to fill by magic. */
  const [suggestStatus, setSuggestStatus] = useState<string | null>(null)

  const setPair = (idx: number, patch: Partial<FieldPair>) => {
    setDraft((d) => {
      const fm = [...(d.field_mappings ?? [])]
      fm[idx] = { ...fm[idx], ...patch }
      return { ...d, field_mappings: fm }
    })
  }
  const addPair = () => {
    setDraft((d) => ({
      ...d,
      field_mappings: [
        ...(d.field_mappings ?? []),
        { medusa_path: "", erpnext_field: "" },
      ],
    }))
  }
  const removePair = (idx: number) => {
    setDraft((d) => {
      const fm = [...(d.field_mappings ?? [])]
      fm.splice(idx, 1)
      return { ...d, field_mappings: fm }
    })
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const url = id ? `/admin/erpnext/mappings/${id}` : "/admin/erpnext/mappings"
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.message || "save_failed")
      onBack()
    } catch (e: any) {
      setError(e?.message ?? "save_failed")
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (!id) {
      setError("save first, then test")
      return
    }
    if (!testRecordId.trim()) {
      setError("enter a Medusa record id to test against")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        // Route folder is `dry-run` (NOT `test`) — Medusa's compiler
        // hardcodes `test` as an ignored directory name and silently
        // drops any file under it, leaving the endpoint to return 404
        // for every push. See dry-run/route.ts.
        `/admin/erpnext/mappings/${id}/dry-run`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ record_id: testRecordId.trim() }),
        },
      )
      const body = await res.json()
      setTestResult(body)
    } catch (e: any) {
      setError(e?.message ?? "test_failed")
    } finally {
      setBusy(false)
    }
  }

  const pullNow = async () => {
    if (!id) {
      setError("save first, then pull")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/admin/erpnext/mappings/${id}/pull-now`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      )
      const body = await res.json()
      setTestResult(body)
    } catch (e: any) {
      setError(e?.message ?? "pull_failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="secondary" size="small" onClick={onBack}>
          ← Back to list
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" size="small" onClick={test} disabled={busy || !id}>
            Test
          </Button>
          <Button variant="secondary" size="small" onClick={pullNow} disabled={busy || !id}>
            Pull now
          </Button>
          <Button variant="primary" size="small" onClick={save} disabled={busy}>
            {id ? "Save" : "Create"}
          </Button>
        </div>
      </div>

      {error && <Text className="text-ui-fg-error">{error}</Text>}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Name</Label>
          <Input
            value={draft.name ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </div>
        <div>
          <Label>Sync direction</Label>
          <select
            className="w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm"
            value={draft.direction ?? "both"}
            onChange={(e) =>
              setDraft((d) => ({ ...d, direction: e.target.value as any }))
            }
          >
            <option value="push">One-way — Medusa → ERPNext</option>
            <option value="pull">One-way — ERPNext → Medusa</option>
            <option value="both">Two-way — both directions</option>
          </select>
          <Text className="mt-1 text-xs text-ui-fg-subtle">
            {DIRECTION_HELP[(draft.direction ?? "both") as Direction]}
          </Text>
        </div>
        <div className="col-span-2">
          <Label>Description</Label>
          <Textarea
            rows={2}
            value={draft.description ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, description: e.target.value }))
            }
          />
        </div>
        <div>
          <Label>Medusa entity</Label>
          <select
            className="w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm"
            value={draft.medusa_entity ?? ""}
            onChange={(e) => pickEntity(e.target.value)}
          >
            <option value="">— pick an entity —</option>
            {entities.map((e) => (
              <option key={e.key} value={e.key}>
                {e.label}
                {e.is_custom_module ? `  (${e.module_name})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Frappe doctype</Label>
          <div className="flex gap-2">
            <Input
              placeholder={
                doctypesLoading
                  ? "loading…"
                  : doctypes.length
                    ? "search Frappe doctypes…"
                    : "—"
              }
              value={doctypeSearch}
              disabled={!doctypes.length && !doctypesLoading}
              onChange={(e) => {
                setDoctypeSearch(e.target.value)
                refreshDoctypes(e.target.value)
              }}
            />
          </div>
          <select
            className="mt-1 w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm disabled:opacity-50"
            value={draft.doctype ?? ""}
            disabled={!doctypes.length}
            onChange={(e) => pickDoctype(e.target.value)}
          >
            <option value="">
              {doctypesLoading
                ? "loading…"
                : doctypes.length
                  ? "— pick a doctype —"
                  : "— Frappe not connected —"}
            </option>
            {/* Recommended-for-this-entity group first, so the admin usually
                just picks the top one. Falls back to the full list below. */}
            {recommendedDoctypes.length > 0 && (
              <optgroup label={`Recommended for ${activeEntity?.label ?? "this entity"}`}>
                {recommendedDoctypes.map((d) => (
                  <option key={`rec-${d}`} value={d}>
                    {d}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup
              label={
                recommendedDoctypes.length > 0 ? "All doctypes" : undefined
              }
            >
              {doctypes.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </optgroup>
          </select>
          {recommendedDoctypes.length > 0 && (
            <Text className="mt-1 text-xs text-ui-fg-subtle">
              Suggested for {activeEntity?.label}:{" "}
              <strong>{recommendedDoctypes.join(", ")}</strong>. Pick another
              below if yours is different.
            </Text>
          )}
          {/* Inline empty-state guidance. The most common reason the
              list is empty is ERPNEXT_URL / api_key / api_secret not
              configured yet — point the operator at the Settings tab. */}
          {!doctypesLoading && doctypes.length === 0 && (
            <Text className="mt-1 text-xs text-ui-fg-error">
              {doctypesError || "No doctypes available."}{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  // Switch the parent tab back to Settings so the
                  // operator can paste URL + api_key / api_secret +
                  // press "Test connection" without leaving the page.
                  onJumpToTab?.("settings")
                }}
                className="underline"
              >
                Open Settings tab →
              </a>
            </Text>
          )}
        </div>

        <div>
          <Label>Key field (Medusa path)</Label>
          <Input
            value={draft.key_medusa_field ?? ""}
            placeholder={activeEntity?.default_key_path ?? "email"}
            onChange={(e) =>
              setDraft((d) => ({ ...d, key_medusa_field: e.target.value }))
            }
          />
        </div>
        <div>
          <Label>Key field (Frappe doctype)</Label>
          <Input
            value={draft.key_erpnext_field ?? "name"}
            onChange={(e) =>
              setDraft((d) => ({ ...d, key_erpnext_field: e.target.value }))
            }
          />
        </div>

        <div className="col-span-2">
          <Label>Push events (comma separated)</Label>
          <Input
            value={(draft.events ?? []).join(", ")}
            placeholder={
              activeEntity ? activeEntity.events.join(", ") : "e.g. customer.created, customer.updated"
            }
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                events: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              }))
            }
          />
          <Text className="mt-1 text-xs text-ui-fg-subtle">
            Subscriber fires this mapping whenever any listed event lands.
            Leave empty to disable the push side entirely.
          </Text>
        </div>

        <div className="col-span-2">
          <Label>Frappe-side pull filter (JSON)</Label>
          <Textarea
            rows={3}
            value={
              draft.pull_filter
                ? JSON.stringify(draft.pull_filter, null, 2)
                : ""
            }
            placeholder='[["disabled","=",0]]'
            onChange={(e) => {
              const v = e.target.value.trim()
              if (!v) {
                setDraft((d) => ({ ...d, pull_filter: null }))
                return
              }
              try {
                const parsed = JSON.parse(v)
                if (Array.isArray(parsed)) {
                  setDraft((d) => ({ ...d, pull_filter: parsed }))
                }
              } catch {
                /* still typing — don't clobber draft */
              }
            }}
          />
          <Text className="mt-1 text-xs text-ui-fg-subtle">
            Frappe filter syntax — array of [field, op, value] triples ANDed
            together with the time-based <code>modified &gt; last_pull_at</code>
            cursor at pull time.
          </Text>
        </div>

        {/* ── When does this actually fire? ───────────────────────── */}
        <div className="col-span-2 rounded border border-ui-border-base p-3">
          <Label>When should this sync?</Label>
          <Text className="mb-2 text-xs text-ui-fg-subtle">
            The events above decide which changes are candidates. This
            decides which <em>records</em> qualify — e.g. only once KYC
            clears, or only once they have actually bought something.
          </Text>
          <select
            className="w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm"
            value={draft.trigger_preset ?? "always"}
            onChange={(e) => {
              const preset = TRIGGER_PRESETS.find((p) => p.value === e.target.value)
              setDraft((d) => ({
                ...d,
                trigger_preset: e.target.value,
                // Keep whatever the operator typed when they switch to
                // custom; otherwise adopt the preset's own condition.
                trigger_condition:
                  e.target.value === "custom"
                    ? (d.trigger_condition ?? "")
                    : (preset?.condition ?? ""),
              }))
            }}
          >
            {TRIGGER_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <Text className="mt-1 text-xs text-ui-fg-subtle">
            {TRIGGER_PRESETS.find((p) => p.value === (draft.trigger_preset ?? "always"))?.help}
          </Text>
          <Input
            className="mt-2 font-mono text-xs"
            placeholder="always — no condition"
            value={draft.trigger_condition ?? ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                trigger_condition: e.target.value,
                trigger_preset: "custom",
              }))
            }
          />
          <Text className="mt-1 text-xs text-ui-fg-subtle">
            Supported: <code>is set</code>, <code>is not set</code>,{" "}
            <code>is empty</code>, <code>== != &gt; &gt;= &lt; &lt;=</code>,{" "}
            <code>contains</code>, <code>starts with</code>,{" "}
            <code>and</code> / <code>or</code> / <code>not</code> and brackets.
            Not JavaScript — it can only read fields off the record. An
            invalid condition is rejected on save, and would sync nothing
            rather than everything.
          </Text>
          <div className="mt-3 flex items-center gap-2">
            <Switch
              checked={Boolean(draft.skip_unchanged)}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, skip_unchanged: v }))}
            />
            <Label className="text-ui-fg-subtle">
              Skip when nothing changed
            </Label>
          </div>
          <Text className="mt-1 text-xs text-ui-fg-subtle">
            Compares against the last payload that synced successfully for
            this record. Only the fields mapped below count — an unrelated
            change elsewhere on the record will not re-push.
          </Text>
        </div>

        {/* ── May it create, may it update? ───────────────────────── */}
        <div className="col-span-2 rounded border border-ui-border-base p-3">
          <Label>What may this sync do to the other side?</Label>
          <div className="mt-2 flex gap-6">
            <div className="flex items-center gap-2">
              <Switch
                checked={draft.allow_create !== false}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, allow_create: v }))}
              />
              <Label className="text-ui-fg-subtle">Create missing records</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={draft.allow_update !== false}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, allow_update: v }))}
              />
              <Label className="text-ui-fg-subtle">Update existing records</Label>
            </div>
          </div>
          <Text className="mt-1 text-xs text-ui-fg-subtle">
            Both on = full upsert, which is the usual setting. Create-only
            never overwrites a record someone edited on the other side;
            update-only enriches records that system already owns.
          </Text>
        </div>
      </div>

      {/* Field-pair mapper */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <Heading level="h2">Field mappings</Heading>
          <div className="flex items-center gap-2">
            <select
              className="rounded border bg-ui-bg-base px-2 py-1.5 text-sm"
              value={autofillMode}
              onChange={(e) => {
                const mode = e.target.value as "smart" | "all"
                setAutofillMode(mode)
                if (draft.medusa_entity && draft.doctype) {
                  runAutofill(draft.medusa_entity, draft.doctype, {
                    force: true,
                    mode,
                  })
                }
              }}
              title="Which doctype fields to put in the grid"
            >
              <option value="smart">mandatory + matched</option>
              <option value="all">every field</option>
            </select>
            <Button
              size="small"
              variant="secondary"
              isLoading={autofilling}
              onClick={() =>
                runAutofill(draft.medusa_entity!, draft.doctype!, {
                  force: true,
                })
              }
              disabled={!draft.medusa_entity || !draft.doctype || autofilling}
              title={
                !draft.medusa_entity || !draft.doctype
                  ? "Pick a Medusa entity and Frappe doctype first"
                  : "Read the doctype's fields and guess a Medusa source for each. Replaces the current pairs."
              }
            >
              Auto-map fields
            </Button>
            <Button size="small" variant="secondary" onClick={addPair}>
              <Plus /> Add pair
            </Button>
          </div>
        </div>
        {suggestStatus && (
          <div className="mb-3 rounded border border-ui-border-interactive bg-ui-bg-subtle p-3 text-xs text-ui-fg-subtle">
            {suggestStatus}
          </div>
        )}
        <Text className="mb-4 text-xs text-ui-fg-subtle">
          Each row pairs one Medusa source with one Frappe fieldname.
          Picking a doctype reads its fields live and guesses a source for
          each — the badge on every row says how confident that guess is,
          so <em>check this</em> and <em>no match</em> are the only ones
          you have to look at. A source can also combine several Medusa
          fields: <code>{"{first_name} {last_name}"}</code> writes both
          into ERPNext's single name column. Combined sources are
          push-only (there's no way to split a joined value back apart).
        </Text>
        {(draft.field_mappings ?? []).length === 0 && (
          <div className="rounded border p-4 text-center text-ui-fg-subtle">
            No field pairs yet — click <em>Auto-map fields</em> to read the
            doctype and fill this in, or <em>Add pair</em> to build manually.
          </div>
        )}
        {/* Mandatory ERPNext fields we could not guess a source for.
            They're not persistable as pairs (no source), so they'd be
            invisible — but they're exactly what makes a push 417 later. */}
        {(() => {
          const mapped = new Set(
            (draft.field_mappings ?? []).map((p) => p.erpnext_field),
          )
          const gaps = Object.values(annotations).filter(
            (a) => a.reqd && !a.medusa_path && !mapped.has(a.erpnext_field),
          )
          if (!gaps.length) return null
          return (
            <div className="mb-3 rounded border border-ui-tag-orange-border bg-ui-tag-orange-bg p-3 text-xs">
              <div className="mb-1 font-medium">
                {gaps.length} mandatory ERPNext field
                {gaps.length === 1 ? "" : "s"} with no Medusa source
              </div>
              <div className="text-ui-fg-subtle">
                ERPNext will reject the write unless these have a value.
                Add a pair with a default, or let Frappe's own default
                apply:{" "}
                {gaps
                  .map(
                    (g) =>
                      `${g.erpnext_label} (${g.erpnext_field})` +
                      (g.default ? ` → defaults to "${g.default}"` : ""),
                  )
                  .join("; ")}
              </div>
            </div>
          )
        })()}
        {/* Two rows writing the same ERPNext column IN THE SAME
            DIRECTION is a silent data race — whichever runs last wins,
            and which one that is depends on array order. (Opposite
            directions are fine: Product↔Security fills `isin` from the
            handle on pull and from metadata on push.) The fix is almost
            always one row with a fallback: {a || b}. */}
        {(() => {
          const seen = new Map<string, string[]>()
          for (const p of draft.field_mappings ?? []) {
            if (!p.erpnext_field || !p.medusa_path) continue
            const dirs =
              (p.direction ?? draft.direction ?? "both") === "both"
                ? ["push", "pull"]
                : [p.direction ?? draft.direction ?? "both"]
            for (const d of dirs) {
              const k = `${p.erpnext_field}::${d}`
              seen.set(k, [...(seen.get(k) ?? []), p.medusa_path])
            }
          }
          const clashes = [...seen.entries()].filter(([, v]) => v.length > 1)
          if (!clashes.length) return null
          return (
            <div className="mb-3 rounded border border-ui-tag-red-border bg-ui-tag-red-bg p-3 text-xs">
              <div className="mb-1 font-medium">
                {clashes.length} field{clashes.length === 1 ? "" : "s"} written twice
                in the same direction
              </div>
              <div className="text-ui-fg-subtle">
                Whichever row runs last wins, so the result depends on row
                order rather than on anything you chose. If you meant
                &ldquo;use the first one that has a value&rdquo;, delete one
                row and write the other as{" "}
                <code>{"{path.a || path.b}"}</code>.
                <ul className="mt-1 list-disc pl-4">
                  {clashes.map(([k, v]) => (
                    <li key={k}>
                      <code>{k.split("::")[0]}</code> on {k.split("::")[1]} ←{" "}
                      {v.join("  ·  ")}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )
        })()}
        {(draft.field_mappings ?? []).map((pair, idx) => (
          <FieldPairRow
            key={idx}
            pair={pair}
            entity={activeEntity}
            fields={doctypeFields}
            annotation={annotations[pair.erpnext_field]}
            mappingDirection={(draft.direction ?? "both") as Direction}
            onChange={(patch) => setPair(idx, patch)}
            onRemove={() => removePair(idx)}
          />
        ))}
      </div>

      {/* Test / pull panel */}
      {id && (
        <div className="mt-6 rounded border p-4">
          <Heading level="h2" className="mb-2">
            Test
          </Heading>
          <div className="mb-2 flex gap-2">
            <Input
              placeholder="Medusa record id (cus_…, prod_…, etc.)"
              value={testRecordId}
              onChange={(e) => setTestRecordId(e.target.value)}
            />
            <Button variant="secondary" size="small" onClick={test} disabled={busy}>
              Dry-run push
            </Button>
          </div>
          {testResult && (
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-ui-bg-subtle p-2 text-xs">
              {JSON.stringify(testResult, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ─── One field-pair row ──────────────────────────────────────────────

const FieldPairRow: React.FC<{
  pair: FieldPair
  entity: MedusaEntity | null
  fields: DoctypeField[]
  annotation?: AutofillAnnotation
  mappingDirection: Direction
  onChange: (patch: Partial<FieldPair>) => void
  onRemove: () => void
}> = ({
  pair,
  entity,
  fields,
  annotation,
  mappingDirection,
  onChange,
  onRemove,
}) => {
  // A `{slot}` source combines several Medusa fields, so the dropdown
  // can't represent it — show the raw expression and hide the picker's
  // "unset" state from confusing the operator.
  const isTemplate = /\{[^{}]+\}/.test(pair.medusa_path ?? "")
  const effectiveDirection = pair.direction ?? mappingDirection
  const conf = annotation ? CONFIDENCE_META[annotation.confidence] : null

  return (
    <div className="mb-2 grid grid-cols-12 gap-2 rounded border p-2 items-center">
      <div className="col-span-3">
        {isTemplate ? (
          <div className="rounded border border-ui-tag-blue-border bg-ui-tag-blue-bg px-2 py-1.5 text-xs">
            combines{" "}
            {(pair.medusa_path.match(/\{([^{}]+)\}/g) ?? [])
              .map((s) => s.slice(1, -1))
              .join(" + ")}
          </div>
        ) : (
          <select
            className="w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm"
            value={pair.medusa_path}
            onChange={(e) => onChange({ medusa_path: e.target.value })}
          >
            <option value="">— Medusa field —</option>
            {(entity?.paths ?? []).map((p) => (
              <option key={p.path} value={p.path}>
                {p.label} ({p.path})
              </option>
            ))}
          </select>
        )}
        <Input
          className="mt-1"
          placeholder="…dot-path, or {a} {b} to combine"
          value={pair.medusa_path}
          onChange={(e) => onChange({ medusa_path: e.target.value })}
        />
      </div>
      <div className="col-span-1 text-center text-ui-fg-subtle">
        {effectiveDirection === "push"
          ? "→"
          : effectiveDirection === "pull"
            ? "←"
            : "↔"}
      </div>
      <div className="col-span-3">
        <select
          className="w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm"
          value={pair.erpnext_field}
          onChange={(e) => onChange({ erpnext_field: e.target.value })}
        >
          <option value="">— Frappe field —</option>
          {fields.map((f) => (
            <option key={f.fieldname} value={f.fieldname}>
              {f.label} ({f.fieldname}, {f.fieldtype})
              {f.reqd ? " *" : ""}
            </option>
          ))}
        </select>
        <Input
          className="mt-1"
          placeholder="…or custom fieldname"
          value={pair.erpnext_field}
          onChange={(e) => onChange({ erpnext_field: e.target.value })}
        />
        {(conf || annotation?.reqd) && (
          <div className="mt-1 flex items-center gap-1">
            {annotation?.reqd && (
              <Badge size="2xsmall" color="red">
                required
              </Badge>
            )}
            {conf && (
              <Badge size="2xsmall" color={conf.color} title={annotation?.why}>
                {conf.label}
              </Badge>
            )}
          </div>
        )}
      </div>
      <div className="col-span-2">
        <select
          className="w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm"
          value={pair.transform ?? ""}
          onChange={(e) => onChange({ transform: e.target.value || undefined })}
        >
          {TRANSFORM_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="col-span-2">
        <select
          className="w-full rounded border bg-ui-bg-base px-2 py-1.5 text-sm disabled:opacity-60"
          value={effectiveDirection}
          disabled={isTemplate}
          title={
            isTemplate
              ? "A combined source can only be pushed — a joined value can't be split back into its parts."
              : "Override the mapping's direction for this one field"
          }
          onChange={(e) => onChange({ direction: e.target.value as any })}
        >
          <option value="both">two-way</option>
          <option value="push">→ ERPNext only</option>
          <option value="pull">← Medusa only</option>
        </select>
      </div>
      <div className="col-span-1 text-right">
        <Button variant="transparent" size="small" onClick={onRemove}>
          <Trash />
        </Button>
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

export const config = defineRouteConfig({
  label: "ERPNext",
  icon: ArrowsPointingOut,
})

export default ErpnextPage

import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CurrencyDollar } from "@medusajs/icons"
import {
  Container,
  Heading,
  Button,
  Table,
  Input,
  Label,
  Select,
  Drawer,
  toast,
} from "@medusajs/ui"
import { useEffect, useState } from "react"

type WS = {
  id: string
  settlement_batch_id: string
  period_from?: string | null
  period_to?: string | null
  total_credits?: number | null
  total_debits?: number | null
  net_amount?: number | null
  currency?: string | null
  status: "Pending" | "Posted" | "Failed" | "Cancelled"
}

const BLANK: Partial<WS> = { settlement_batch_id: "", currency: "INR", status: "Pending" }

const WalletSettlementsPage = () => {
  const [rows, setRows] = useState<WS[]>([])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Partial<WS>>(BLANK)
  const [editing, setEditing] = useState<string | null>(null)

  const load = async () => {
    const r = await fetch("/admin/wallet-settlements", { credentials: "include" })
    const b = await r.json()
    setRows(b.wallet_settlements ?? [])
  }
  useEffect(() => {
    load()
  }, [])

  const save = async () => {
    const url = editing
      ? `/admin/wallet-settlements/${editing}`
      : "/admin/wallet-settlements"
    const body = editing
      ? {
          period_from: draft.period_from,
          period_to: draft.period_to,
          total_credits: draft.total_credits,
          total_debits: draft.total_debits,
          net_amount: draft.net_amount,
          currency: draft.currency,
          status: draft.status,
        }
      : draft
    const r = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      toast.error("Save failed")
      return
    }
    toast.success(editing ? "Updated" : "Created")
    setOpen(false)
    setDraft(BLANK)
    setEditing(null)
    load()
  }

  const cancel = async (id: string) => {
    const r = await fetch(`/admin/wallet-settlements/${id}`, {
      method: "DELETE",
      credentials: "include",
    })
    if (!r.ok) {
      toast.error("Cancel failed")
      return
    }
    toast.success("Cancelled")
    load()
  }

  const num = (v: string) => (v === "" ? null : Number(v))

  return (
    <Container className="p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading>Wallet Settlements</Heading>
        <Button
          size="small"
          onClick={() => {
            setDraft(BLANK)
            setEditing(null)
            setOpen(true)
          }}
        >
          Add settlement
        </Button>
      </div>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Batch</Table.HeaderCell>
            <Table.HeaderCell>Period</Table.HeaderCell>
            <Table.HeaderCell>Net</Table.HeaderCell>
            <Table.HeaderCell>Currency</Table.HeaderCell>
            <Table.HeaderCell>Status</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row key={r.id}>
              <Table.Cell>{r.settlement_batch_id}</Table.Cell>
              <Table.Cell>
                {r.period_from} → {r.period_to}
              </Table.Cell>
              <Table.Cell>{r.net_amount}</Table.Cell>
              <Table.Cell>{r.currency}</Table.Cell>
              <Table.Cell>{r.status}</Table.Cell>
              <Table.Cell>
                <div className="flex gap-2">
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => {
                      setDraft(r)
                      setEditing(r.id)
                      setOpen(true)
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    disabled={r.status === "Cancelled"}
                    onClick={() => cancel(r.id)}
                  >
                    Cancel
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <Drawer open={open} onOpenChange={setOpen}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{editing ? "Edit" : "New"} settlement</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-col gap-3">
            <div>
              <Label>Batch id</Label>
              <Input
                value={draft.settlement_batch_id ?? ""}
                disabled={!!editing}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, settlement_batch_id: e.target.value }))
                }
              />
            </div>
            <div className="flex gap-2">
              <div>
                <Label>Period from</Label>
                <Input
                  placeholder="2026-08-01"
                  value={draft.period_from ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, period_from: e.target.value }))
                  }
                />
              </div>
              <div>
                <Label>Period to</Label>
                <Input
                  placeholder="2026-08-31"
                  value={draft.period_to ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, period_to: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="flex gap-2">
              <div>
                <Label>Credits</Label>
                <Input
                  type="number"
                  value={draft.total_credits ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, total_credits: num(e.target.value) }))
                  }
                />
              </div>
              <div>
                <Label>Debits</Label>
                <Input
                  type="number"
                  value={draft.total_debits ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, total_debits: num(e.target.value) }))
                  }
                />
              </div>
              <div>
                <Label>Net</Label>
                <Input
                  type="number"
                  value={draft.net_amount ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, net_amount: num(e.target.value) }))
                  }
                />
              </div>
            </div>
            <div className="flex gap-2">
              <div>
                <Label>Currency</Label>
                <Input
                  value={draft.currency ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, currency: e.target.value }))
                  }
                />
              </div>
              <div className="flex-1">
                <Label>Status</Label>
                <Select
                  value={draft.status ?? "Pending"}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, status: v as WS["status"] }))
                  }
                >
                  <Select.Trigger>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {["Pending", "Posted", "Failed", "Cancelled"].map((s) => (
                      <Select.Item key={s} value={s}>
                        {s}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              </div>
            </div>
          </Drawer.Body>
          <Drawer.Footer>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={save}>{editing ? "Save" : "Create"}</Button>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Wallet Settlements",
  icon: CurrencyDollar,
})

export default WalletSettlementsPage

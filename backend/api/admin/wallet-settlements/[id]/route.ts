import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { syncWsToErpnext } from "../../../../lib/emit-ws-event"

const WS_MODULE = "wallet_settlement"

const UpdateSchema = z.object({
  period_from: z.string().trim().nullish(),
  period_to: z.string().trim().nullish(),
  total_credits: z.number().nullish(),
  total_debits: z.number().nullish(),
  net_amount: z.number().nullish(),
  currency: z.string().trim().nullish(),
  status: z.enum(["Pending", "Posted", "Failed", "Cancelled"]).optional(),
})

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const svc = req.scope.resolve(WS_MODULE) as any
  const row = await svc.retrieveWalletSettlement(req.params.id)
  return res.json({ wallet_settlement: row })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = UpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ message: "Invalid update", errors: parsed.error.flatten() })
  }
  const svc = req.scope.resolve(WS_MODULE) as any
  const [updated] = await svc.updateWalletSettlements([
    { id: req.params.id, ...parsed.data },
  ])
  await syncWsToErpnext(req.scope, "wallet_settlement.updated", updated)
  return res.json({ wallet_settlement: updated })
}

// Safe delete = mark Cancelled + soft-delete, then emit deleted so the
// far side also cancels. The record is preserved on both sides.
export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
  const svc = req.scope.resolve(WS_MODULE) as any
  // Grab the record (for its settlement_batch_id) before soft-deleting, so
  // the push can tell ERPNext which settlement to cancel.
  const [record] = await svc.updateWalletSettlements([
    { id: req.params.id, status: "Cancelled" },
  ])
  await svc.deleteWalletSettlements([req.params.id])
  await syncWsToErpnext(req.scope, "wallet_settlement.deleted", record)
  return res.json({ id: req.params.id, object: "wallet_settlement", deleted: true })
}

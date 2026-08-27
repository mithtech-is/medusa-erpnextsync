import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { syncWsToErpnext } from "../../../lib/emit-ws-event"

const WS_MODULE = "wallet_settlement"

const CreateSchema = z.object({
  settlement_batch_id: z.string().trim().min(1),
  period_from: z.string().trim().nullish(),
  period_to: z.string().trim().nullish(),
  total_credits: z.number().nullish(),
  total_debits: z.number().nullish(),
  net_amount: z.number().nullish(),
  currency: z.string().trim().nullish(),
  status: z.enum(["Pending", "Posted", "Failed", "Cancelled"]).default("Pending"),
})

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const svc = req.scope.resolve(WS_MODULE) as any
  const rows = await svc.listWalletSettlements(
    {},
    { order: { settlement_batch_id: "ASC" } },
  )
  return res.json({ wallet_settlements: rows })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = CreateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ message: "Invalid wallet settlement", errors: parsed.error.flatten() })
  }
  const svc = req.scope.resolve(WS_MODULE) as any
  const [created] = await svc.createWalletSettlements([parsed.data])
  await syncWsToErpnext(req.scope, "wallet_settlement.created", created)
  return res.status(201).json({ wallet_settlement: created })
}

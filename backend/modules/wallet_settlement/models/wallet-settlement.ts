import { model } from "@medusajs/framework/utils"

/**
 * A wallet settlement batch, mirrored two-way with the ERPNext doctype
 * `RISITEX Wallet Settlement`. Amounts are kept in the SAME unit as
 * ERPNext (rupees) as plain numbers — no paise conversion. `status`
 * uses ERPNext's exact title-case values so no case transform is needed
 * in the mapping. `Cancelled` is the safe-delete state (records are
 * marked, never destroyed).
 */
export const WalletSettlement = model.define("wallet_settlement", {
  id: model.id().primaryKey(),
  settlement_batch_id: model.text().unique(),
  period_from: model.text().nullable(),
  period_to: model.text().nullable(),
  total_credits: model.number().nullable(),
  total_debits: model.number().nullable(),
  net_amount: model.number().nullable(),
  currency: model.text().nullable(),
  status: model
    .enum(["Pending", "Posted", "Failed", "Cancelled"])
    .default("Pending"),
})

import { ExecArgs } from "@medusajs/framework/types"

/**
 * Demo-only: plugin-side mapping for wallet_settlement ↔ RISITEX Wallet
 * Settlement (two-way). Mirrors the Product ↔ Item seed shape. Idempotent.
 */
export default async function seed({ container }: ExecArgs) {
  const svc: any = container.resolve("erpnext")
  const existing = await svc.listErpnextMappings({}, { take: 500 })
  const name = "Wallet Settlement ↔ RISITEX Wallet Settlement"
  const cur = existing.find((m: any) => m.name === name)
  const row = {
    name,
    enabled: true,
    medusa_entity: "wallet_settlement",
    doctype: "RISITEX Wallet Settlement",
    direction: "both",
    events: [
      "wallet_settlement.created",
      "wallet_settlement.updated",
      "wallet_settlement.deleted",
    ],
    key_medusa_field: "settlement_batch_id",
    key_erpnext_field: "settlement_batch_id",
    allow_create: true,
    allow_update: true,
    field_mappings: [
      { medusa_path: "settlement_batch_id", erpnext_field: "settlement_batch_id", direction: "both" },
      { medusa_path: "period_from", erpnext_field: "period_from", direction: "both" },
      { medusa_path: "period_to", erpnext_field: "period_to", direction: "both" },
      { medusa_path: "total_credits", erpnext_field: "total_credits", direction: "both" },
      { medusa_path: "total_debits", erpnext_field: "total_debits", direction: "both" },
      { medusa_path: "net_amount", erpnext_field: "net_amount", direction: "both" },
      { medusa_path: "currency", erpnext_field: "currency", direction: "both" },
      { medusa_path: "status", erpnext_field: "status", direction: "both" },
      { medusa_path: "id", erpnext_field: "medusa_settlement_id", direction: "push" },
    ],
  }
  if (cur) {
    await svc.updateErpnextMappings([{ id: cur.id, ...row }])
    console.log("[seed] updated wallet settlement mapping")
  } else {
    await svc.createErpnextMappings([row])
    console.log("[seed] created wallet settlement mapping")
  }
}

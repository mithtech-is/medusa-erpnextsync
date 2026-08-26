import { Module } from "@medusajs/framework/utils"
import WalletSettlementService from "./service"

export const WALLET_SETTLEMENT_MODULE = "wallet_settlement"

export default Module(WALLET_SETTLEMENT_MODULE, {
  service: WalletSettlementService,
})

export { WalletSettlementService }

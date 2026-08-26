import { MedusaService } from "@medusajs/framework/utils"
import { WalletSettlement } from "./models/wallet-settlement"

class WalletSettlementService extends MedusaService({ WalletSettlement }) {}

export default WalletSettlementService

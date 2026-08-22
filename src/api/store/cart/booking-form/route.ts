import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import saveBookingFormWorkflow from "../../../../workflows/save-booking-form"
import { StoreSaveBookingFormBodyType } from "./validators"

type RequestWithAuthContext = MedusaRequest & {
  auth_context?: {
    actor_id?: string
  }
  pricingContext?: any
}

const throwInvalidData = (message: string, code?: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message, code)
}

/**
 * Save booking form pre-data for a cart item
 * POST /store/cart/booking-form
 *
 * Thin wrapper around saveBookingFormWorkflow
 */
export async function POST(req: MedusaRequest<StoreSaveBookingFormBodyType>, res: MedusaResponse) {
  try {
    const validatedBody = req.validatedBody

    // Call the workflow
    const { result } = await saveBookingFormWorkflow(req.scope).run({
      input: {
        cart_id: validatedBody.cart_id,
        group_id: validatedBody.group_id,
        pre_data: validatedBody.pre_data,
      },
    })

    // Respond with booking form
    res.json({
      booking_form: result,
    })
  } catch (error) {
    console.error("Error saving booking form:", error)

    if (MedusaError.isMedusaError(error)) {
      throw error
    }

    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Failed to save booking form"
    )
  }
}
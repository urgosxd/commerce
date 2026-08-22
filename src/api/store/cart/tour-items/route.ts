import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import addBookingToCartWorkflow from "../../../../workflows/add-booking-to-cart"
import { trackCommerceEvent, type TrackingItem } from "../../../../utils/conversion-tracking"
import { StoreAddTourItemsBodyType } from "./validators"

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
 * Add tour items to cart
 * POST /store/cart/tour-items
 *
 * Thin wrapper around addBookingToCartWorkflow
 */
export async function POST(req: MedusaRequest<StoreAddTourItemsBodyType>, res: MedusaResponse) {
  try {
    const requestWithAuth = req as RequestWithAuthContext
    const validatedBody = req.validatedBody

    // Validate cart_id
    if (!validatedBody.cart_id) {
      throwInvalidData("Missing required field: cart_id")
    }

    // Call the workflow with matching field names
    const { result } = await addBookingToCartWorkflow(req.scope).run({
      input: {
        cart_id: validatedBody.cart_id,
        type: "tour",
        id: validatedBody.tour_id,
        date: validatedBody.tour_date,
        adults: Number(validatedBody.adults || 0),
        children: Number(validatedBody.children || 0),
        infants: Number(validatedBody.infants || 0),
        customer: validatedBody.customer,
items: validatedBody.items,
         pricing_context: (req as any).pricingContext,
         actor_id: (req as any).auth_context?.actor_id,
         additional_data: {},
      },
    })

    // The workflow's conditionalCartFetchStep returns cart with items.* (all item
    // fields) via baseFields. No refetch needed — just default promotions to []
    // (baseFields omits promotions when cart has none, per the optimization).
    const cart = { ...result.cart, promotions: result.cart?.promotions ?? [] }

    // Respond with cart and summary
    res.json({
      cart,
      summary: result.summary,
    })

    trackCommerceEvent({
      eventName: "AddToCart",
      eventId: `add_to_cart:${result.group_id}`,
      trigger: "store.cart.tour-items.post",
      request: req,
      currency: result.currency_code,
      value: result.total_price,
      items: result.tracking_items,
      description: result.summary.destination,
      user: {
        email: validatedBody.customer?.email,
        phone: validatedBody.customer?.phone,
        externalId: requestWithAuth.auth_context?.actor_id,
      },
    }).catch((err) => {
      console.error("[tracking] AddToCart event failed (non-blocking)", err)
    })
  } catch (error) {
    console.error("Error adding tour items to cart:", error)

    if (MedusaError.isMedusaError(error)) {
      throw error
    }

    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Failed to add tour items to cart"
    )
  }
}
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { BOOKING_FORM_MODULE } from "../../modules/booking-form"

export type SaveBookingFormStepInput = {
  cart_id: string
  group_id: string
  pre_data: Record<string, unknown>
}

/**
 * Step to save or update booking form pre-data
 * Looks up cart item by group_id to get type/entity_id/entity_date
 */
export const saveBookingFormStep = createStep(
  "save-booking-form",
  async (input: SaveBookingFormStepInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const bookingFormModuleService = container.resolve(BOOKING_FORM_MODULE) as any

    // 1. Look up the cart item with matching group_id to get type/entity_id/entity_date
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: ["id", "items.metadata"],
      filters: { id: input.cart_id },
    })

    const cart = carts[0]
    const matchingItem = (cart?.items || []).find(
      (item: any) => item.metadata?.group_id === input.group_id
    )

    if (!matchingItem) {
      throw new Error(`No cart item found with group_id "${input.group_id}" for cart "${input.cart_id}"`)
    }

    const metadata = matchingItem.metadata || {}
    const type: "tour" | "package" = metadata.is_package === true ? "package" : "tour"
    const entityId = type === "package" ? metadata.package_id : metadata.tour_id
    // entityDate can be a string or timestamp object - normalize to string
    const entityDateRaw = type === "package" ? metadata.package_date : metadata.tour_date
    const entityDate = typeof entityDateRaw === 'string' ? entityDateRaw : String(entityDateRaw)

    if (!entityId || !entityDateRaw) {
      throw new Error(`Cart item with group_id "${input.group_id}" is missing ${type}_id or ${type}_date in metadata`)
    }

    // 2. Check if a BookingForm already exists for this cart_id + group_id (idempotent)
    const existing = await bookingFormModuleService.listBookingForms({
      cart_id: input.cart_id,
      group_id: input.group_id,
    })

    let createdOrUpdated: any
    let created = false

    if (existing.length > 0) {
      // Update existing record
      await bookingFormModuleService.updateBookingForms([
        { id: existing[0].id, pre_data: input.pre_data, status: "draft" },
      ])
      createdOrUpdated = { ...existing[0], pre_data: input.pre_data, status: "draft" }
    } else {
      // Create new record
      const createdRec = await bookingFormModuleService.createBookingForms([
        {
          cart_id: input.cart_id,
          group_id: input.group_id,
          type,
          entity_id: entityId,
          entity_date: new Date(entityDate),
          pre_data: input.pre_data,
          status: "draft",
        },
      ])
      createdOrUpdated = Array.isArray(createdRec) ? createdRec[0] : createdRec
      created = true
    }

    return new StepResponse(
      createdOrUpdated,
      created ? [createdOrUpdated.id] : []
    )
  },
  async (compensationData, { container }) => {
    if (!compensationData || compensationData.length === 0) return
    const bookingFormModuleService = container.resolve(BOOKING_FORM_MODULE) as any
    await bookingFormModuleService.deleteBookingForms(compensationData as string[])
  }
)
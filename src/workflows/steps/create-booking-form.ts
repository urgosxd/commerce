import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import BOOKING_FORM_MODULE from "../../modules/booking-form/service"
import { BOOKING_FORM_MODULE as BOOKING_FORM_MODULE_KEY } from "../../modules/booking-form"

export type CreateBookingFormStepInput = {
  cart_id: string
  group_id: string
  type: "tour" | "package"
  entity_id: string
  entity_date: string
  pre_data?: Record<string, unknown>
}

/**
 * Step to create or update a booking form record
 */
export const createBookingFormStep = createStep(
  "create-booking-form",
  async (input: CreateBookingFormStepInput, { container }) => {
    const { pre_data, ...data } = input

    // Guard: if pre_data is undefined/null/empty, skip without touching DB
    if (!pre_data) {
      return new StepResponse(undefined)
    }

    const bookingFormModuleService = container.resolve(
      BOOKING_FORM_MODULE_KEY
    ) as any

    // Idempotency: check if record already exists for this cart_id and group_id
    const existing = await bookingFormModuleService.listBookingForms({
      cart_id: data.cart_id,
      group_id: data.group_id,
    })

    let createdOrUpdated
    let created = false

    if (existing.length > 0) {
      // Update existing record
      existing[0].pre_data = pre_data
      existing[0].status = "draft"
      await bookingFormModuleService.updateBookingForms([
        {
          id: existing[0].id,
          pre_data: pre_data,
          status: "draft",
        },
      ] as any)
      createdOrUpdated = existing[0]
    } else {
      // Create new record (createBookingForms returns an array)
      const newDate = new Date(data.entity_date)
      const createdRec = await bookingFormModuleService.createBookingForms([
        {
          cart_id: data.cart_id,
          group_id: data.group_id,
          type: data.type,
          entity_id: data.entity_id,
          entity_date: newDate,
          pre_data: pre_data,
          status: "draft",
        },
      ] as any)
      createdOrUpdated = Array.isArray(createdRec) ? createdRec[0] : createdRec
      created = true
    }

    return new StepResponse(
      createdOrUpdated,
      created ? [createdOrUpdated.id] : [] // CompensationData: IDs to delete
    )
  },
  async (compensationData, { container }) => {
    // Compensation: delete only if we created the record
    if (!compensationData || compensationData.length === 0) {
      return
    }

    const bookingFormModuleService = container.resolve(
      BOOKING_FORM_MODULE_KEY
    ) as any

    await bookingFormModuleService.deleteBookingForms(compensationData as string[])
  }
)
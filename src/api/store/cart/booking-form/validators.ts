import { z } from "@medusajs/framework/zod"

/**
 * Body for POST /store/cart/booking-form
 */
export const StoreSaveBookingFormBody = z.object({
  cart_id: z.string().min(1, "cart_id is required"),
  group_id: z.string().min(1, "group_id is required"),
  pre_data: z.record(z.string(), z.any()),
})

export type StoreSaveBookingFormBodyType = z.infer<typeof StoreSaveBookingFormBody>
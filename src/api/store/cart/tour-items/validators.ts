import { z } from "@medusajs/framework/zod"

/**
 * Body for POST /store/cart/tour-items
 */
export const StoreAddTourItemsBody = z.object({
  cart_id: z.string().optional(),
  tour_id: z.string().optional(),
  tour_date: z.string().optional(),
  adults: z.coerce.number().optional(),
  children: z.coerce.number().optional(),
  infants: z.coerce.number().optional(),
  customer: z
    .object({
      name: z.string(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      formId: z.any().optional(),
    })
    .optional(),
  items: z
    .array(
      z.object({
        variant_id: z.string(),
        quantity: z.coerce.number().optional(),
        unit_price: z.coerce.number().optional(),
        thumbnail: z.string().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
    )
    .optional(),
  })

export type StoreAddTourItemsBodyType = z.infer<typeof StoreAddTourItemsBody>
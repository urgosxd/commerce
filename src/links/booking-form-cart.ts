import BookingFormModule from "../modules/booking-form"
import CartModule from "@medusajs/medusa/cart"
import { defineLink } from "@medusajs/framework/utils"

/**
 * Link between BookingForm and Cart
 * - deleteCascade: BookingForm is deleted when its linked Cart is deleted
 * - isList: A cart can have multiple booking forms (multiple passengers)
 */
export default defineLink(
  {
    linkable: BookingFormModule.linkable.bookingForm,
    deleteCascade: true,
    isList: true,
  },
  CartModule.linkable.cart
)
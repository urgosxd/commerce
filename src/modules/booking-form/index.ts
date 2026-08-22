import BookingFormModuleService from "./service"
import { Module } from "@medusajs/framework/utils"
import BookingForm from "./models/booking-form"

export const BOOKING_FORM_MODULE = "bookingFormModule"

export default Module(BOOKING_FORM_MODULE, {
  service: BookingFormModuleService,
})

export * from "./models/booking-form"

export const linkable = {
  bookingForm: BookingForm,
}
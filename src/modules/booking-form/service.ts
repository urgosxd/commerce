import { MedusaService } from "@medusajs/framework/utils"
import { BookingForm } from "./models/booking-form"

class BookingFormModuleService extends MedusaService({ BookingForm }) {
  // inherits: createBookingForms, listBookingForms, retrieveBookingForm, deleteBookingForms, etc.
}

export default BookingFormModuleService
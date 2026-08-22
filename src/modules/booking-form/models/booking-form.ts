import { model } from "@medusajs/framework/utils"

export const BookingForm = model.define("booking_form", {
  id: model.id().primaryKey(),
  cart_id: model.text(),
  group_id: model.text(),
  type: model.enum(["tour", "package"]).default("tour"),
  entity_id: model.text(),
  entity_date: model.dateTime(),
  pre_data: model.json().nullable(),
  status: model.enum(["draft", "consumed"]).default("draft"),
}).indexes([
  {
    on: ["cart_id"],
  },
  {
    on: ["group_id"],
  },
])

export default BookingForm
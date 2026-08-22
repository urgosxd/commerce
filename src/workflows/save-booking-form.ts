import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { saveBookingFormStep, SaveBookingFormStepInput } from "./steps/save-booking-form"

export type SaveBookingFormWorkflowInput = SaveBookingFormStepInput

export const saveBookingFormWorkflow = createWorkflow(
  "save-booking-form",
  function (input: SaveBookingFormWorkflowInput) {
    const result = saveBookingFormStep(input)
    return new WorkflowResponse(result)
  }
)

export default saveBookingFormWorkflow
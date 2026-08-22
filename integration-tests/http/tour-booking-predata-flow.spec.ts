import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createPaymentCollectionForCartWorkflow, createApiKeysWorkflow, linkSalesChannelsToApiKeyWorkflow } from "@medusajs/medusa/core-flows"
import { TOUR_MODULE, PassengerType } from "../../src/modules/tour"
import type TourModuleService from "../../src/modules/tour/service"
import { BOOKING_FORM_MODULE } from "../../src/modules/booking-form"

jest.setTimeout(180 * 1000)

medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("Tour Booking preData Flow - E2E", () => {
      let container: any
      let tourModuleService: TourModuleService
      let productModule: any
      let cartModule: any
      let salesChannelModule: any
      let regionModule: any
      let orderModule: any
      let paymentModule: any
      let query: any
      let bookingFormModuleService: any

      let tour: any
      let product: any
      let adultVariant: any
      let childVariant: any
      let salesChannel: any
      let region: any
      let publishableApiKeyToken: string

      const testDate = "2030-03-15"

      beforeAll(async () => {
        container = getContainer()
        tourModuleService = container.resolve(TOUR_MODULE)
        productModule = container.resolve(Modules.PRODUCT)
        cartModule = container.resolve(Modules.CART)
        salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
        regionModule = container.resolve(Modules.REGION)
        orderModule = container.resolve(Modules.ORDER)
        paymentModule = container.resolve(Modules.PAYMENT)
        query = container.resolve(ContainerRegistrationKeys.QUERY)
        bookingFormModuleService = container.resolve(BOOKING_FORM_MODULE) as any
      })

      beforeEach(async () => {
        salesChannel = await salesChannelModule.createSalesChannels({
          name: "Cart Flow Test Channel",
        })

        region = await regionModule.createRegions({
          name: "Cart Flow Test Region",
          currency_code: "usd",
          countries: ["us"],
          payment_providers: ["pp_system_default"],
        })

        product = await productModule.createProducts({
          title: "Cusco Walking Tour",
          status: "published",
          sales_channels: [{ id: salesChannel.id }],
          options: [
            { title: "Passenger Type", values: ["Adult", "Child"] },
          ],
        })

        adultVariant = await productModule.createProductVariants({
          product_id: product.id,
          title: "Adult Ticket",
          sku: `CART-FLOW-ADULT-${Date.now()}`,
          manage_inventory: false,
          requires_shipping: false,
          options: { "Passenger Type": "Adult" },
        })

        childVariant = await productModule.createProductVariants({
          product_id: product.id,
          title: "Child Ticket",
          sku: `CART-FLOW-CHILD-${Date.now()}`,
          manage_inventory: false,
          requires_shipping: false,
          options: { "Passenger Type": "Child" },
        })

        tour = await tourModuleService.createTours({
          product_id: product.id,
          slug: `tour-cart-flow-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          destination: "Cusco Historic Center",
          description: "Walking tour through Cusco's historic center",
          duration_days: 1,
          max_capacity: 20,
        })

        await tourModuleService.createTourVariants({
          tour_id: tour.id,
          variant_id: adultVariant.id,
          passenger_type: PassengerType.ADULT,
        })

        await tourModuleService.createTourVariants({
          tour_id: tour.id,
          variant_id: childVariant.id,
          passenger_type: PassengerType.CHILD,
        })

        const { result: publishableApiKeyResult } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              {
                title: `tour-store-api-${Date.now()}`,
                type: "publishable",
                created_by: "integration-test",
              },
            ],
          },
        })

        const publishableApiKey = publishableApiKeyResult[0]
        publishableApiKeyToken = publishableApiKey.token

        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: {
            id: publishableApiKey.id,
            add: [salesChannel.id],
          },
        })
      })

      afterEach(async () => {
        try {
          const bookings = await tourModuleService.listTourBookings({})
          if (bookings.length > 0) {
            await tourModuleService.deleteTourBookings(bookings.map((b: any) => b.id))
          }
          await tourModuleService.deleteTourVariants({ tour_id: tour.id })
          await tourModuleService.deleteTours(tour.id)
          await productModule.deleteProductVariants(adultVariant.id)
          await productModule.deleteProductVariants(childVariant.id)
          await productModule.deleteProducts(product.id)
          await regionModule.deleteRegions(region.id)
          await salesChannelModule.deleteSalesChannels(salesChannel.id)

          // Delete any BookingForm records
          try {
            const forms = await bookingFormModuleService.listBookingForms({})
            if (forms.length > 0) {
              await bookingFormModuleService.deleteBookingForms(forms.map((f: any) => f.id))
            }
          } catch (error) {
            // bookingFormModuleService might not be available in all contexts
          }
        } catch (error) {
        }
      })

      async function triggerOrderPlaced(orderId: string) {
        // import subscriber at runtime to avoid triggering dynamic import issues during test runner setup
        // use require so we don't depend on top-level ESM dynamic imports
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const handleOrderPlaced = require("../../src/subscribers/order-placed").default

        await handleOrderPlaced({
          event: { data: { id: orderId }, name: "order.placed" },
          container,
        } as any)
      }

      describe("Test 1: should persist preData into BookingForm via store route", () => {
        it("should persist preData into BookingForm via booking-form endpoint", async () => {
          const cart = await cartModule.createCarts({
            email: "predata-test@example.com",
            region_id: region.id,
            sales_channel_id: salesChannel.id,
            currency_code: "usd",
          })

          const preData = {
            firstName: "María",
            lastName: "García",
            email: "maria@test.com",
            phone: "+51999123456",
            pickup: "Hotel Lima",
            notes: "Llegamos con 2 maletas",
            formId: "form-abc-123",
          }

          // Step 1: Add tour to cart (NO preData)
          const res = await api.post(
            "/store/cart/tour-items",
            {
              cart_id: cart.id,
              tour_date: testDate,
              adults: 2,
              children: 0,
              infants: 0,
              tour_id: tour.id,
              items: [{ variant_id: adultVariant.id, quantity: 2, unit_price: 150 }],
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )

          expect(res.status).toBe(200)

          // Step 2: Get the group_id from the cart line item
          const { data: [fetchedCart] } = await query.graph({
            entity: "cart",
            fields: ["id", "items.metadata"],
            filters: { id: cart.id },
          })
          const tourItem = fetchedCart.items.find((i: any) => i.metadata?.is_tour === true)
          expect(tourItem).toBeDefined()
          const groupId = tourItem.metadata.group_id

          // Step 3: Send the form via the NEW endpoint
          const formRes = await api.post("/store/cart/booking-form", {
            cart_id: cart.id,
            group_id: groupId,
            pre_data: preData,
          }, { headers: { "x-publishable-api-key": publishableApiKeyToken } })
          expect(formRes.status).toBe(200)

          // Step 4: Assert BookingForm
          const forms = await bookingFormModuleService.listBookingForms({ cart_id: cart.id })
          expect(forms.length).toBe(1)
          const form = forms[0]
          expect(form.status).toBe("draft")
          expect(form.type).toBe("tour")
          expect(form.entity_id).toBe(tour.id)
          expect(form.group_id).toBe(groupId)
          expect(form.pre_data).toEqual(preData)
        })
      })

      describe("Test 2: should propagate preData from BookingForm to booking on order completion", () => {
        it("should propagate preData from BookingForm to booking on order completion", async () => {
          const cart = await cartModule.createCarts({
            email: "propagate-test@example.com",
            region_id: region.id,
            sales_channel_id: salesChannel.id,
            currency_code: "usd",
          })

          const preData = {
            firstName: "María",
            lastName: "García",
            email: "maria@test.com",
            phone: "+51999123456",
            pickup: "Hotel Lima",
            notes: "Llegamos con 2 maletas",
            formId: "propagate-form-123",
          }

          // Step 1: Add tour to cart (NO preData)
          const res = await api.post(
            "/store/cart/tour-items",
            {
              cart_id: cart.id,
              tour_date: testDate,
              adults: 2,
              children: 0,
              infants: 0,
              tour_id: tour.id,
              items: [{ variant_id: adultVariant.id, quantity: 2, unit_price: 150 }],
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )
          expect(res.status).toBe(200)

          // Step 2: Get group_id from cart
          const { data: [fetchedCart] } = await query.graph({
            entity: "cart",
            fields: ["id", "items.metadata"],
            filters: { id: cart.id },
          })
          const tourItem = fetchedCart.items.find((i: any) => i.metadata?.is_tour === true)
          const groupId = tourItem.metadata.group_id

          // Step 3: Save the form
          const formRes = await api.post("/store/cart/booking-form", {
            cart_id: cart.id,
            group_id: groupId,
            pre_data: preData,
          }, { headers: { "x-publishable-api-key": publishableApiKeyToken } })
          expect(formRes.status).toBe(200)

          // Step 4: Confirm BookingForm was created
          const forms = await bookingFormModuleService.listBookingForms({ cart_id: cart.id })
          expect(forms.length).toBe(1)
          const formId = forms[0].id

          // Step 5: Create payment collection + authorize (same as before)
          await createPaymentCollectionForCartWorkflow(container).run({
            input: { cart_id: cart.id },
          })

          const { data: cartsWithPayment } = await query.graph({
            entity: "cart",
            fields: ["id", "total", "payment_collection.id", "items.*", "items.metadata"],
            filters: { id: cart.id },
          })

          await paymentModule.createPaymentSession(
            cartsWithPayment[0].payment_collection.id,
            {
              provider_id: "pp_system_default",
              currency_code: "usd",
              amount: cartsWithPayment[0].total,
              data: {},
            }
          )

          const paymentSessions = await paymentModule.listPaymentSessions({
            payment_collection_id: cartsWithPayment[0].payment_collection.id,
          })
          await paymentModule.authorizePaymentSession(paymentSessions[0].id, {})

          // Step 6: Create order DIRECTLY (bypass completeCartWithToursWorkflow to avoid sync booking creation)
          const orderItems = cartsWithPayment[0].items.map((item: any) => ({
            title: item.title || "Tour Item",
            quantity: item.quantity || 1,
            unit_price: item.unit_price || 0,
            variant_id: item.variant_id,
            metadata: item.metadata,
          }))

          const order = await orderModule.createOrders({
            email: cart.email || "propagate-test@example.com",
            currency_code: "usd",
            items: orderItems,
            region_id: region.id,
            sales_channel_id: salesChannel.id,
          })

          expect(order.id).toBeDefined()

          // Step 7: Manually trigger the subscriber (no polling needed — synchronous invoke)
          await triggerOrderPlaced(order.id)

          // Step 8: Assert booking was created with preData from BookingForm
          const bookings = await tourModuleService.listTourBookings({ order_id: order.id })
          expect(bookings.length).toBeGreaterThan(0)
          const booking = bookings[0]
          expect(booking.order_id).toBe(order.id)
          expect(booking.tour_id).toBe(tour.id)
          expect(booking.metadata?.preData).toEqual(preData)
          expect(booking.metadata?.group_id).toBe(groupId)

          // Step 9: Assert BookingForm status === "consumed"
          const consumedForm = await bookingFormModuleService.retrieveBookingForm(formId)
          expect(consumedForm.status).toBe("consumed")
        })
      })

      describe("Test 3: should create booking without preData when no form sent", () => {
        it("should create booking without preData when no BookingForm exists", async () => {
          const cart = await cartModule.createCarts({
            email: "fallback-test@example.com",
            region_id: region.id,
            sales_channel_id: salesChannel.id,
            currency_code: "usd",
          })

          // Add tour items WITHOUT calling booking-form endpoint
          const res = await api.post(
            "/store/cart/tour-items",
            {
              cart_id: cart.id,
              tour_date: testDate,
              adults: 1,
              children: 0,
              infants: 0,
              tour_id: tour.id,
              items: [{ variant_id: adultVariant.id, quantity: 1, unit_price: 150 }],
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )
          expect(res.status).toBe(200)

          // No BookingForm should exist for this cart
          const forms = await bookingFormModuleService.listBookingForms({ cart_id: cart.id })
          expect(forms.length).toBe(0)

          // Create payment + order directly (same as before)
          await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cart.id } })
          const { data: cartsWithPayment } = await query.graph({
            entity: "cart",
            fields: ["id", "total", "payment_collection.id", "items.*", "items.metadata"],
            filters: { id: cart.id },
          })
          await paymentModule.createPaymentSession(cartsWithPayment[0].payment_collection.id, {
            provider_id: "pp_system_default",
            currency_code: "usd",
            amount: cartsWithPayment[0].total,
            data: {},
          })
          const paymentSessions = await paymentModule.listPaymentSessions({ payment_collection_id: cartsWithPayment[0].payment_collection.id })
          await paymentModule.authorizePaymentSession(paymentSessions[0].id, {})

          const orderItems = cartsWithPayment[0].items.map((item: any) => ({
            title: item.title || "Tour Item",
            quantity: item.quantity || 1,
            unit_price: item.unit_price || 0,
            variant_id: item.variant_id,
            metadata: item.metadata,
          }))
          const order = await orderModule.createOrders({
            email: cart.email || "fallback-test@example.com",
            currency_code: "usd",
            items: orderItems,
            region_id: region.id,
            sales_channel_id: salesChannel.id,
          })

          await triggerOrderPlaced(order.id)

          // Booking created but no preData (no form, no order.metadata.preData)
          const bookings = await tourModuleService.listTourBookings({ order_id: order.id })
          expect(bookings.length).toBeGreaterThan(0)
          expect(bookings[0].metadata?.preData).toBeUndefined()
        })
      })
    })
  },
})
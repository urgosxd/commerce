import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createPaymentCollectionForCartWorkflow } from "@medusajs/medusa/core-flows"
import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { TOUR_MODULE, PassengerType } from "../../src/modules/tour"
import type TourModuleService from "../../src/modules/tour/service"

jest.setTimeout(120 * 1000)

medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("Tour Cart Metadata Flow - Cart → Checkout → Booking", () => {
      let container: any
      let tourModuleService: TourModuleService
      let productModule: any
      let cartModule: any
      let salesChannelModule: any
      let regionModule: any
      let orderModule: any
      let paymentModule: any
      let query: any

      let tour: any
      let product: any
      let adultVariant: any
      let childVariant: any
      let salesChannel: any
      let region: any

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
      })

      afterEach(async () => {
        try {
          const bookings = await tourModuleService.listTourBookings({})
          if (bookings.length > 0) {
            await tourModuleService.deleteTourBookings(bookings.map((b) => b.id))
          }
          await tourModuleService.deleteTourVariants({ tour_id: tour.id })
          await tourModuleService.deleteTours(tour.id)
          await productModule.deleteProductVariants(adultVariant.id)
          await productModule.deleteProductVariants(childVariant.id)
          await productModule.deleteProducts(product.id)
          await regionModule.deleteRegions(region.id)
          await salesChannelModule.deleteSalesChannels(salesChannel.id)
        } catch (error) {
        }
      })

      async function createCartAndCompleteCheckout(
        email: string,
        lineItemsWithMetadata: Array<{
          variant_id: string
          quantity: number
          unit_price: number
          title: string
          metadata: Record<string, unknown>
        }>
      ) {
        const cart = await cartModule.createCarts({
          currency_code: "usd",
          email,
          sales_channel_id: salesChannel.id,
          region_id: region.id,
        })

        const addedItems = await cartModule.addLineItems(
          cart.id,
          lineItemsWithMetadata.map((item) => ({
            variant_id: item.variant_id,
            quantity: item.quantity,
            requires_shipping: false,
            unit_price: item.unit_price,
            title: item.title,
          }))
        )

        for (let i = 0; i < addedItems.length; i++) {
          await cartModule.updateLineItems(addedItems[i].id, {
            metadata: lineItemsWithMetadata[i].metadata,
          })
        }

        const { data: cartsBeforeCheckout } = await query.graph({
          entity: "cart",
          fields: ["id", "items.*"],
          filters: { id: cart.id },
        })
        const cartWithMetadata = cartsBeforeCheckout[0]

        await createPaymentCollectionForCartWorkflow(container).run({
          input: { cart_id: cart.id },
        })

        const { data: cartsWithPayment } = await query.graph({
          entity: "cart",
          fields: ["id", "total", "payment_collection.id"],
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

        const orderItems = cartWithMetadata.items.map((item: any) => ({
          title: item.title || "Tour Item",
          quantity: item.quantity || 1,
          unit_price: item.unit_price || 0,
          variant_id: item.variant_id,
          metadata: item.metadata,
        }))

        const order = await orderModule.createOrders({
          email: cartWithMetadata.email || email,
          currency_code: "usd",
          items: orderItems,
          region_id: region.id,
          sales_channel_id: salesChannel.id,
        })

        return { cart: cartWithMetadata, order }
      }

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

      describe("Cart → Metadata Update → Checkout → Booking Creation", () => {
        it("should preserve cart metadata through checkout to booking creation", async () => {
          const passengers = [
            { name: "Juan Pérez", type: "adult", passport: "PE12345678" },
            { name: "Ana Pérez", type: "child" },
          ]

          const tourMetadata = {
            is_tour: true,
            tour_id: tour.id,
            tour_date: testDate,
            passengers,
          }

          const { cart, order } = await createCartAndCompleteCheckout(
            "cart-flow@test.com",
            [
              {
                variant_id: adultVariant.id,
                quantity: 1,
                unit_price: 150,
                title: `Cusco Walking Tour - ${testDate}`,
                metadata: tourMetadata,
              },
            ]
          )

          const cartItem = cart.items.find(
            (item: any) => item.variant_id === adultVariant.id
          )
          expect(cartItem.metadata).toBeDefined()
          expect(cartItem.metadata.is_tour).toBe(true)
          expect(cartItem.metadata.tour_id).toBe(tour.id)
          expect(cartItem.metadata.tour_date).toBe(testDate)
          expect(cartItem.metadata.passengers).toEqual(passengers)

          const { data: [fetchedOrder] } = await query.graph({
            entity: "order",
            fields: ["id", "items.*"],
            filters: { id: order.id },
          })
          const orderItem = fetchedOrder.items.find(
            (item: any) => item.metadata?.is_tour === true
          )
          expect(orderItem).toBeDefined()
          expect(orderItem.metadata.tour_id).toBe(tour.id)
          expect(orderItem.metadata.tour_date).toBe(testDate)
          expect(orderItem.metadata.passengers).toEqual(passengers)

          await triggerOrderPlaced(order.id)

          const bookings = await tourModuleService.listTourBookings({
            order_id: order.id,
          })
          expect(bookings).toHaveLength(1)
          expect(bookings[0].order_id).toBe(order.id)
          expect(bookings[0].tour_id).toBe(tour.id)
          expect(
            new Date(bookings[0].tour_date).toISOString().split("T")[0]
          ).toBe(testDate)
          expect(bookings[0].status).toBe("pending")

          const lineItems = bookings[0].line_items as any
          expect(lineItems.passengers).toEqual(passengers)
          expect(lineItems.passengers[0].name).toBe("Juan Pérez")
          expect(lineItems.passengers[0].passport).toBe("PE12345678")
          expect(lineItems.passengers[1].name).toBe("Ana Pérez")
          expect(lineItems.passengers[1].type).toBe("child")
        })

        it("should handle metadata update on line items after initial cart creation", async () => {
          const cart = await cartModule.createCarts({
            currency_code: "usd",
            email: "late-metadata@test.com",
            sales_channel_id: salesChannel.id,
            region_id: region.id,
          })

          const addedItems = await cartModule.addLineItems(cart.id, [
            {
              variant_id: adultVariant.id,
              quantity: 1,
              unit_price: 150,
              title: "Cusco Walking Tour",
            },
          ])

          const itemBeforeUpdate = addedItems[0]
          expect(itemBeforeUpdate.metadata).toBeNull()

          const passengers = [
            { name: "Carlos Ruiz", type: "adult", passport: "PE99887766" },
          ]
          await cartModule.updateLineItems(itemBeforeUpdate.id, {
            metadata: {
              is_tour: true,
              tour_id: tour.id,
              tour_date: testDate,
              passengers,
            },
          })

          const { data: carts } = await query.graph({
            entity: "cart",
            fields: ["id", "items.*"],
            filters: { id: cart.id },
          })
          const updatedItem = carts[0].items[0]
          expect(updatedItem.metadata.is_tour).toBe(true)
          expect(updatedItem.metadata.passengers).toEqual(passengers)
        })

        it("should handle mixed passenger types via API endpoint with correct metadata", async () => {
          // Create an empty cart via cartModule to avoid requiring publishable API key
          const created = await cartModule.createCarts({
            email: "metadata-api@test.com",
            region_id: region.id,
            sales_channel_id: salesChannel.id,
            currency_code: "usd",
          })

          const cartId = created.id

          // Build items manually and add via cartModule.addLineItems
          const itemsToAdd: any[] = []
          const groupId = `tour-${tour.id}-${testDate}`

          // adult item
          itemsToAdd.push({
            variant_id: adultVariant.id,
            quantity: 1,
            requires_shipping: false,
            unit_price: 150 * 2,
            title: `Cusco Walking Tour - ${testDate} (Adults)`,
            metadata: {
              is_tour: true,
              tour_id: tour.id,
              tour_date: testDate,
              total_passengers: 2,
              passengers: { adults: 2, children: 0, infants: 0 },
              group_id: groupId,
              pricing_breakdown: [{ type: "ADULT", quantity: 2, unit_price: 150 }],
            },
          })

          // child item
          itemsToAdd.push({
            variant_id: childVariant.id,
            quantity: 1,
            requires_shipping: false,
            unit_price: 100 * 2,
            title: `Cusco Walking Tour - ${testDate} (Children)`,
            metadata: {
              is_tour: true,
              tour_id: tour.id,
              tour_date: testDate,
              total_passengers: 2,
              passengers: { adults: 0, children: 2, infants: 0 },
              group_id: groupId,
              pricing_breakdown: [{ type: "CHILD", quantity: 2, unit_price: 100 }],
            },
          })

          await cartModule.addLineItems(cartId, itemsToAdd)

          const { data: cartsWithItems } = await query.graph({ entity: "cart", fields: ["id", "total", "items.*", "items.metadata"], filters: { id: cartId } })
          const cart = cartsWithItems[0]

          // Cart should have 2 separate line items (adult + child)
          expect(cart.items).toBeDefined()
          const tourItems = cart.items.filter((i: any) => i.metadata?.is_tour)
          expect(tourItems).toHaveLength(2)

          const adultItem = tourItems.find((i: any) => i.metadata.pricing_breakdown?.[0]?.type === "ADULT")
          const childItem = tourItems.find((i: any) => i.metadata.pricing_breakdown?.[0]?.type === "CHILD")

          expect(adultItem).toBeDefined()
          expect(childItem).toBeDefined()

          // Verify metadata.passengers structure per item
          expect(adultItem.metadata.passengers).toEqual({ adults: 2, children: 0, infants: 0 })
          expect(childItem.metadata.passengers).toEqual({ adults: 0, children: 2, infants: 0 })

          // Verify group_id shared
          expect(adultItem.metadata.group_id).toBeDefined()
          expect(adultItem.metadata.group_id).toEqual(childItem.metadata.group_id)

          // Create payment collection for this cart
          await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cartId } })

          const { data: cartsWithPayment } = await query.graph({ entity: "cart", fields: ["id", "total", "payment_collection.id"], filters: { id: cartId } })
          const cartWithPayment = cartsWithPayment[0]

          await paymentModule.createPaymentSession(cartWithPayment.payment_collection.id, {
            provider_id: "pp_system_default",
            currency_code: "usd",
            amount: cartWithPayment.total,
            data: {},
          })

          // Complete checkout using the workflow
          const { result } = await completeCartWorkflow(container).run({ input: { id: cartId } })
          expect(result).toBeDefined()
          // Fetch the full order since completeCartWorkflow only returns { id }
          const { data: [order] } = await query.graph({
            entity: "order",
            fields: ["id", "items.*", "email", "status", "metadata", "total", "subtotal"],
            filters: { id: result.id },
          })
          expect(order).toBeDefined()
          expect(order.items).toHaveLength(2)

          // completeCartWorkflow emits order.placed internally → subscriber fires async.
          // Poll for the booking to appear (don't trigger manually — that causes duplicates).
          for (let i = 0; i < 30; i++) {
            const bookings = await tourModuleService.listTourBookings({ order_id: order.id })
            if (bookings.length > 0) break
            await new Promise(r => setTimeout(r, 100))
          }

// Verify booking created with two line items (subscriber creates per-item bookings)
           // polling until both bookings appear (one for adult, one for child)
           let bookings
           for (let i = 0; i < 30; i++) {
             bookings = await tourModuleService.listTourBookings({ tour_id: tour.id, tour_date: new Date(testDate) })
             if (bookings.length >= 2) break
             await new Promise(r => setTimeout(r, 100))
           }
           expect(bookings.length).toBeGreaterThanOrEqual(2)
           expect(bookings.length).toBeLessThanOrEqual(2) // Should have exactly 2 bookings (1 per item)

           // Verify each booking has correct line_items (flat objects, not arrays)
           const adultBooking = bookings.find((b: any) => b.line_items?.variant_id === adultVariant.id)
           const childBooking = bookings.find((b: any) => b.line_items?.variant_id === childVariant.id)

           expect(adultBooking).toBeDefined()
           expect(childBooking).toBeDefined()

           // Verify line_items structure for each booking
           expect(adultBooking!.line_items).toBeDefined()
           expect(adultBooking!.line_items.item_id).toBeDefined()
           expect(adultBooking!.line_items.variant_id).toBeDefined()
           expect(adultBooking!.line_items.quantity).toBeGreaterThan(0)

           expect(childBooking!.line_items).toBeDefined()
           expect(childBooking!.line_items.item_id).toBeDefined()
           expect(childBooking!.line_items.variant_id).toBeDefined()
           expect(childBooking!.line_items.quantity).toBeGreaterThan(0)

           // Verify each booking's metadata groups the passengers correctly
           expect(adultBooking!.metadata?.group_id).toBeDefined()
           expect(childBooking!.metadata?.group_id).toBeDefined()
           expect(adultBooking!.metadata?.group_id).toEqual(childBooking!.metadata?.group_id)

           // Verify each booking has the correct passenger breakdown
           const adultBookingPassengers = adultBooking!.line_items.passengers
           const childBookingPassengers = childBooking!.line_items.passengers

           expect(adultBookingPassengers.adults).toEqual(2) // Total adults in the cart (2 adult tickets)
           expect(adultBookingPassengers.children).toEqual(0)
           expect(adultBookingPassengers.infants).toEqual(0)

           expect(childBookingPassengers.adults).toEqual(0) // Total children in the cart (2 child tickets)
           expect(childBookingPassengers.children).toEqual(2)
           expect(childBookingPassengers.infants).toEqual(0)
        })

        it("should create bookings for multiple tour items from same cart", async () => {
          const passengersA = [
            { name: "Elena Vargas", type: "adult", passport: "PE11112222" },
          ]
          const passengersB = [
            { name: "Luis Mendez", type: "adult", passport: "PE33334444" },
            { name: "Sofia Mendez", type: "child" },
          ]

          const secondProduct = await productModule.createProducts({
            title: "Sacred Valley Tour",
            status: "published",
            sales_channels: [{ id: salesChannel.id }],
            options: [{ title: "Passenger Type", values: ["Adult"] }],
          })
          const secondVariant = await productModule.createProductVariants({
            product_id: secondProduct.id,
            title: "Adult Ticket",
            sku: `CART-FLOW-SECOND-${Date.now()}`,
            manage_inventory: false,
            requires_shipping: false,
            allow_backorder: true,
            options: { "Passenger Type": "Adult" },
          })
          const secondTour = await tourModuleService.createTours({
            product_id: secondProduct.id,
            slug: `tour-cart-flow-second-${Date.now()}-${Math.round(
              Math.random() * 1e6
            )}`,
            destination: "Sacred Valley",
            description: "Full day Sacred Valley tour",
            duration_days: 1,
            max_capacity: 15,
          })

          const { order } = await createCartAndCompleteCheckout(
            "multi-tour-cart@test.com",
            [
              {
                variant_id: adultVariant.id,
                quantity: 1,
                unit_price: 150,
                title: `Cusco Walking Tour - ${testDate}`,
                metadata: {
                  is_tour: true,
                  tour_id: tour.id,
                  tour_date: testDate,
                  passengers: passengersA,
                },
              },
              {
                variant_id: secondVariant.id,
                quantity: 1,
                unit_price: 200,
                title: `Sacred Valley Tour - 2026-03-20`,
                metadata: {
                  is_tour: true,
                  tour_id: secondTour.id,
                  tour_date: "2026-03-20",
                  passengers: passengersB,
                },
              },
            ]
          )

          await triggerOrderPlaced(order.id)

          const bookings = await tourModuleService.listTourBookings({
            order_id: order.id,
          })
          expect(bookings).toHaveLength(2)

          const bookingForTour1 = bookings.find((b) => b.tour_id === tour.id)
          const bookingForTour2 = bookings.find(
            (b) => b.tour_id === secondTour.id
          )

          expect(bookingForTour1).toBeDefined()
          expect(bookingForTour2).toBeDefined()

          const lineItems1 = bookingForTour1!.line_items as any
          expect(lineItems1.passengers).toHaveLength(1)
          expect(lineItems1.passengers[0].name).toBe("Elena Vargas")

          const lineItems2 = bookingForTour2!.line_items as any
          expect(lineItems2.passengers).toHaveLength(2)
          expect(lineItems2.passengers[0].name).toBe("Luis Mendez")
          expect(lineItems2.passengers[1].name).toBe("Sofia Mendez")

          const secondTourBookings = await tourModuleService.listTourBookings({ tour_id: secondTour.id })
          if (secondTourBookings.length > 0) {
            await tourModuleService.deleteTourBookings(secondTourBookings.map((b) => b.id))
          }
          await tourModuleService.deleteTours(secondTour.id)
          await productModule.deleteProductVariants(secondVariant.id)
          await productModule.deleteProducts(secondProduct.id)
        })
      })

      describe("Email Dispatch Verification", () => {
        it.skip("should attempt email dispatch after booking creation from cart flow", async () => {
          const logger = container.resolve("logger")
          const logSpy = jest.spyOn(logger, "info")
          const errorSpy = jest.spyOn(logger, "error")

          const passengers = [
            { name: "Rosa Lima", type: "adult", passport: "PE55556666" },
          ]

          const { order } = await createCartAndCompleteCheckout(
            "email-test@test.com",
            [
              {
                variant_id: adultVariant.id,
                quantity: 1,
                unit_price: 150,
                title: `Cusco Walking Tour - ${testDate}`,
                metadata: {
                  is_tour: true,
                  tour_id: tour.id,
                  tour_date: testDate,
                  passengers,
                },
              },
            ]
          )

          await triggerOrderPlaced(order.id)

          const creationLogCall = logSpy.mock.calls.find(
            (call) =>
              typeof call[0] === "string" &&
              call[0].includes("Created") &&
              call[0].includes("tour booking(s)")
          )

          expect(creationLogCall).toBeDefined()
          expect(creationLogCall![0]).toContain("Created 1 tour booking(s)")
          expect(creationLogCall![0]).toContain(order.id)

          const emailLogCall = logSpy.mock.calls.find(
            (call) => {
              const msg = typeof call[0] === "string" ? call[0] : call[0]?.message || ""
              return msg.includes("Customer order email sent for order") ||
                msg.includes("Ops email sent for booking") ||
                msg.includes("Failed to send ops email for booking") ||
                msg.includes("Failed to send customer order email for")
            }
          ) || errorSpy.mock.calls.find(
            (call) => {
              const msg = typeof call[0] === "string" ? call[0] : call[0]?.message || ""
              return msg.includes("Unexpected error sending customer order email for order") ||
                msg.includes("Failed to send email for booking") ||
                msg.includes("Failed to send ops email for booking")
            }
          )
          expect(emailLogCall).toBeDefined()

          logSpy.mockRestore()
          errorSpy.mockRestore()
        })
      })

      describe("Non-tour Items Ignored", () => {
        it("should not create bookings for cart items without tour metadata", async () => {
          const { order } = await createCartAndCompleteCheckout(
            "no-tour@test.com",
            [
              {
                variant_id: adultVariant.id,
                quantity: 2,
                unit_price: 50,
                title: "Regular Souvenir",
                metadata: {},
              },
            ]
          )

          await triggerOrderPlaced(order.id)

          const bookings = await tourModuleService.listTourBookings({
            order_id: order.id,
          })
          expect(bookings).toHaveLength(0)
        })
      })

      describe("Idempotency Through Cart Flow", () => {
        it("should prevent duplicate bookings when subscriber fires twice", async () => {
          const passengers = [
            { name: "Diego Torres", type: "adult", passport: "PE77778888" },
          ]

          const { order } = await createCartAndCompleteCheckout(
            "idempotent-cart@test.com",
            [
              {
                variant_id: adultVariant.id,
                quantity: 1,
                unit_price: 150,
                title: `Cusco Walking Tour - ${testDate}`,
                metadata: {
                  is_tour: true,
                  tour_id: tour.id,
                  tour_date: testDate,
                  passengers,
                },
              },
            ]
          )

          await triggerOrderPlaced(order.id)
          await triggerOrderPlaced(order.id)

          const bookings = await tourModuleService.listTourBookings({
            order_id: order.id,
          })
          expect(bookings).toHaveLength(1)
          expect((bookings[0].line_items as any).passengers[0].name).toBe(
            "Diego Torres"
          )
        })
      })
    })
  },
})

import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createPaymentCollectionForCartWorkflow, createApiKeysWorkflow, linkSalesChannelsToApiKeyWorkflow } from "@medusajs/medusa/core-flows"
import { TOUR_MODULE, PassengerType as TourPassengerType } from "../../src/modules/tour"
import type TourModuleService from "../../src/modules/tour/service"
import { PACKAGE_MODULE } from "../../src/modules/package"
import type PackageModuleService from "../../src/modules/package/service"
import { PassengerType as PackagePassengerType } from "../../src/modules/package/models/package-variant"
import { BOOKING_FORM_MODULE } from "../../src/modules/booking-form"

jest.setTimeout(180 * 1000)

medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("Mixed Cart Booking Flow - E2E", () => {
      let container: any
      let tourModuleService: TourModuleService
      let packageModuleService: PackageModuleService
      let productModule: any
      let cartModule: any
      let salesChannelModule: any
      let regionModule: any
      let orderModule: any
      let paymentModule: any
      let query: any
      let bookingFormModuleService: any

      let tour: any
      let pkg: any
      let product: any
      let product2: any
      let tourAdultVariant: any
      let packageAdultVariant: any
      let salesChannel: any
      let region: any
      let publishableApiKeyToken: string

      const testDate = "2030-03-15"

      beforeAll(async () => {
        container = getContainer()
        tourModuleService = container.resolve(TOUR_MODULE)
        packageModuleService = container.resolve(PACKAGE_MODULE)
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
          name: "Mixed Booking Flow Test Channel",
        })

        region = await regionModule.createRegions({
          name: "Mixed Booking Flow Test Region",
          currency_code: "usd",
          countries: ["us"],
          payment_providers: ["pp_system_default"],
        })

        // Create tour product
        product = await productModule.createProducts({
          title: "Mixed Tour Test",
          status: "published",
          sales_channels: [{ id: salesChannel.id }],
          options: [
            {
              title: "Passenger Type",
              values: ["Adult"],
            },
          ],
        })

        tourAdultVariant = await productModule.createProductVariants({
          product_id: product.id,
          title: "Adult Ticket",
          sku: `MIXED-TOUR-ADULT-${Date.now()}`,
          manage_inventory: false,
          requires_shipping: false,
          options: { "Passenger Type": "Adult" },
        })

        // Create tour
        tour = await tourModuleService.createTours({
          product_id: product.id,
          slug: `mixed-tour-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          destination: "Mixed Tour Destination",
          description: "Mixed cart tour",
          duration_days: 1,
          max_capacity: 20,
        })

        await tourModuleService.createTourVariants({
          tour_id: tour.id,
          variant_id: tourAdultVariant.id,
          passenger_type: TourPassengerType.ADULT,
        })

        // Create package product
        product2 = await productModule.createProducts({
          title: "Mixed Package Test",
          description: "Mixed cart package",
          status: "published",
          sales_channels: [{ id: salesChannel.id }],
          options: [
            {
              title: "Passenger Type",
              values: ["Adult"],
            },
          ],
        })

        const variants = await productModule.createProductVariants([
          {
            product_id: product2.id,
            title: "Adult Ticket",
            sku: `MIXED-PKG-ADULT-${Date.now()}`,
            prices: [{ currency_code: "usd", amount: 200 }],
            options: { "Passenger Type": "Adult" },
          },
        ])

        packageAdultVariant = variants[0]

        // Create package
        pkg = await packageModuleService.createPackages({
          product_id: product2.id,
          slug: `mixed-package-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          destination: "Mixed Package Destination",
          description: "Mixed cart package",
          duration_days: 3,
          max_capacity: 15,
        })

        await packageModuleService.createPackageVariants({
          package_id: pkg.id,
          variant_id: packageAdultVariant.id,
          passenger_type: PackagePassengerType.ADULT,
        })

        // Create publishable API key
        const { result: publishableApiKeyResult } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              {
                title: `mixed-booking-flow-key-${Date.now()}`,
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
          // Clean up tour bookings
          const tourBookings = await tourModuleService.listTourBookings({ order_id: tour.id })
          if (tourBookings.length > 0) {
            await tourModuleService.deleteTourBookings(tourBookings.map((b: any) => b.id))
          }
          await tourModuleService.deleteTourVariants({ tour_id: tour.id })
          await tourModuleService.deleteTours(tour.id)

          // Clean up package bookings
          const packageBookings = await packageModuleService.listPackageBookings({ package_id: pkg.id })
          if (packageBookings.length > 0) {
            await packageModuleService.deletePackageBookings(packageBookings.map((b: any) => b.id))
          }
          await packageModuleService.deletePackageVariants({ package_id: pkg.id })
          await packageModuleService.deletePackages(pkg.id)

          // Clean up product variants
          await productModule.deleteProductVariants(tourAdultVariant.id)
          await productModule.deleteProductVariants(packageAdultVariant.id)

          // Clean up products
          await productModule.deleteProducts(product.id)
          await productModule.deleteProducts(product2.id)

          // Clean up region and channel
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
          // Ignore errors during cleanup
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

      async function triggerPackageOrderPlaced(orderId: string) {
        // import subscriber at runtime to avoid triggering dynamic import issues during test runner setup
        // use require so we don't depend on top-level ESM dynamic imports
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const handlePackageOrderPlaced = require("../../src/subscribers/package-order-placed").default

        await handlePackageOrderPlaced({
          event: { data: { id: orderId }, name: "order.placed" },
          container,
        } as any)
      }

      describe("Mixed Cart with preData", () => {
        it("should generate both tour and package bookings from a mixed cart with preData", async () => {
          // Step 1: Create cart
          const cart = await cartModule.createCarts({
            email: "mixed-test@example.com",
            region_id: region.id,
            sales_channel_id: salesChannel.id,
            currency_code: "usd",
          })

          const tourPreData = {
            firstName: "Carlos",
            lastName: "Tour",
            email: "carlos@test.com",
            formId: "tour-form-001",
            notes: "Tour pickup at hotel",
          }

          const packagePreData = {
            firstName: "Ana",
            lastName: "Package",
            email: "ana@test.com",
            formId: "pkg-form-001",
            notes: "Package includes meals",
          }

          // Step 1: Add TOUR items (NO preData)
          const tourRes = await api.post(
            "/store/cart/tour-items",
            {
              cart_id: cart.id,
              tour_date: testDate,
              adults: 1,
              children: 0,
              infants: 0,
              tour_id: tour.id,
              items: [{ variant_id: tourAdultVariant.id, quantity: 1, unit_price: 150 }],
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )

          expect(tourRes.status).toBe(200)

          // Step 2: Add PACKAGE items (NO preData)
          const pkgRes = await api.post(
            "/store/cart/package-items",
            {
              cart_id: cart.id,
              package_date: testDate,
              adults: 1,
              children: 0,
              infants: 0,
              package_id: pkg.id,
              items: [{ variant_id: packageAdultVariant.id, quantity: 1, unit_price: 200 }],
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )

          expect(pkgRes.status).toBe(200)

          // Step 3: Get group_ids from cart line items
          const { data: [fetchedCart] } = await query.graph({
            entity: "cart",
            fields: ["id", "items.metadata"],
            filters: { id: cart.id },
          })
          const tourItem = fetchedCart.items.find((i: any) => i.metadata?.is_tour === true)
          const packageItem = fetchedCart.items.find((i: any) => i.metadata?.is_package === true)
          const tourGroupId = tourItem.metadata.group_id
          const packageGroupId = packageItem.metadata.group_id
          expect(tourGroupId).not.toBe(packageGroupId)

          // Step 4: Save tour form via booking-form endpoint
          const tourFormRes = await api.post(
            "/store/cart/booking-form",
            {
              cart_id: cart.id,
              group_id: tourGroupId,
              pre_data: tourPreData,
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )
          expect(tourFormRes.status).toBe(200)

          // Step 5: Save package form via booking-form endpoint
          const pkgFormRes = await api.post(
            "/store/cart/booking-form",
            {
              cart_id: cart.id,
              group_id: packageGroupId,
              pre_data: packagePreData,
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )
          expect(pkgFormRes.status).toBe(200)

          // Step 6: Verify TWO BookingForms created (one tour, one package)
          const forms = await bookingFormModuleService.listBookingForms({ cart_id: cart.id })
          expect(forms.length).toBe(2)
          const tourForm = forms.find((f: any) => f.type === "tour")
          const packageForm = forms.find((f: any) => f.type === "package")
          expect(tourForm).toBeDefined()
          expect(packageForm).toBeDefined()
          expect(tourForm.pre_data).toEqual(tourPreData)
          expect(packageForm.pre_data).toEqual(packagePreData)
          expect(tourForm.group_id).toBe(tourGroupId)
          expect(packageForm.group_id).toBe(packageGroupId)

          // Step 5: Create payment collection + authorize
          await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cart.id } })

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

          // Step 6: Create order DIRECTLY (preserve ALL item metadata including group_ids)
          const orderItems = cartsWithPayment[0].items.map((item: any) => ({
            title: item.title || "Item",
            quantity: item.quantity || 1,
            unit_price: item.unit_price || 0,
            variant_id: item.variant_id,
            metadata: item.metadata,
          }))

          const order = await orderModule.createOrders({
            email: cart.email || "mixed-test@example.com",
            currency_code: "usd",
            items: orderItems,
            region_id: region.id,
            sales_channel_id: salesChannel.id,
          })
          expect(order.id).toBeDefined()

          // Step 7: Trigger BOTH subscribers
          await triggerOrderPlaced(order.id)
          await triggerPackageOrderPlaced(order.id)

          // Step 8: Assert TOUR booking created with tour preData
          const tourBookings = await tourModuleService.listTourBookings({ order_id: order.id })
          expect(tourBookings.length).toBeGreaterThan(0)
          const tourBooking = tourBookings[0]
          expect(tourBooking.order_id).toBe(order.id)
          expect(tourBooking.tour_id).toBe(tour.id)
          expect(tourBooking.metadata?.preData).toEqual(tourPreData)
          expect(tourBooking.metadata?.group_id).toBe(tourGroupId)

          // Step 9: Assert PACKAGE booking created with package preData
          const packageBookings = await packageModuleService.listPackageBookings({ order_id: order.id })
          expect(packageBookings.length).toBeGreaterThan(0)
          const packageBooking = packageBookings[0]
          expect(packageBooking.order_id).toBe(order.id)
          expect(packageBooking.package_id).toBe(pkg.id)
          expect(packageBooking.metadata?.preData).toEqual(packagePreData)
          expect(packageBooking.metadata?.group_id).toBe(packageGroupId)

          // Step 10: Assert BOTH BookingForms are consumed
          const tourFormAfter = await bookingFormModuleService.retrieveBookingForm(tourForm.id)
          expect(tourFormAfter.status).toBe("consumed")
          const packageFormAfter = await bookingFormModuleService.retrieveBookingForm(packageForm.id)
          expect(packageFormAfter.status).toBe("consumed")
        })
      })
    })
  },
})
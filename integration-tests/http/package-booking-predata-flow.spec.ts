import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createPaymentCollectionForCartWorkflow, createApiKeysWorkflow, linkSalesChannelsToApiKeyWorkflow } from "@medusajs/medusa/core-flows"
import { PACKAGE_MODULE, PassengerType } from "../../src/modules/package"
import type PackageModuleService from "../../src/modules/package/service"
import { BOOKING_FORM_MODULE } from "../../src/modules/booking-form"
import { StoreSaveBookingFormBodyType } from "../../src/api/store/cart/booking-form/validators"

jest.setTimeout(180 * 1000)

medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("Package Booking preData Flow - E2E", () => {
      let container: any
      let packageModuleService: PackageModuleService
      let productModule: any
      let cartModule: any
      let salesChannelModule: any
      let regionModule: any
      let orderModule: any
      let paymentModule: any
      let query: any
      let bookingFormModuleService: any

      let pkg: any
      let product: any
      let adultVariant: any
      let childVariant: any
      let salesChannel: any
      let region: any
      let publishableApiKeyToken: string

      const testDate = "2030-03-15"

      beforeAll(async () => {
        container = getContainer()
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
          name: "Cart Flow Test Channel",
        })

        region = await regionModule.createRegions({
          name: "Cart Flow Test Region",
          currency_code: "usd",
          countries: ["us"],
          payment_providers: ["pp_system_default"],
        })

        product = await productModule.createProducts({
          title: "Peru Adventure Package",
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

        pkg = await packageModuleService.createPackages({
          product_id: product.id,
          slug: `package-cart-flow-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          destination: "Cusco & Sacred Valley",
          description: "Adventure tour through Peru",
          duration_days: 3,
          thumbnail: "https://example.com/package.jpg",
          max_capacity: 20,
        })

        await packageModuleService.createPackageVariants({
          package_id: pkg.id,
          variant_id: adultVariant.id,
          passenger_type: PassengerType.ADULT,
        })

        await packageModuleService.createPackageVariants({
          package_id: pkg.id,
          variant_id: childVariant.id,
          passenger_type: PassengerType.CHILD,
        })

        const { result: publishableApiKeyResult } = await createApiKeysWorkflow(
          container
        ).run({
          input: {
            api_keys: [
              {
                title: `package-store-api-${Date.now()}`,
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
          const bookings = await packageModuleService.listPackageBookings({})
          if (bookings.length > 0) {
            await packageModuleService.deletePackageBookings(bookings.map((b: any) => b.id))
          }
          await packageModuleService.deletePackageVariants({ package_id: pkg.id })
          await packageModuleService.deletePackages(pkg.id)
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

      describe("Test 1: should persist preData into BookingForm via store route for packages", () => {
        it("should persist preData into BookingForm via booking-form endpoint", async () => {
          const cart = await cartModule.createCarts({
            email: "predata-test@example.com",
            region_id: region.id,
            sales_channel_id: salesChannel.id,
            currency_code: "usd",
          })

          // Step 1: Add package items via store route (gets group_id in line items metadata, no preData yet)
          const res = await api.post(
            "/store/cart/package-items",
            {
              cart_id: cart.id,
              package_id: pkg.id,
              package_date: testDate,
              adults: 2,
              children: 0,
              infants: 0,
              items: [{ variant_id: adultVariant.id, quantity: 2, unit_price: 100 }],
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )

          expect(res.status).toBe(200)
          expect(res.data?.cart?.items?.length).toBeGreaterThan(0)

          // Get group_id from cart line items
          const { data: [fetchedCart] } = await query.graph({
            entity: "cart",
            fields: ["id", "items.metadata"],
            filters: { id: cart.id },
          })
          const packageItem = fetchedCart.items.find((i: any) => i.metadata?.is_package === true)
          expect(packageItem).toBeDefined()
          const groupId = packageItem.metadata.group_id
          expect(groupId).toBeDefined()

          // Step 2: Save form via NEW booking-form endpoint
          const preData = {
            firstName: "María",
            lastName: "García",
            email: "maria@test.com",
            phone: "+51999123456",
            pickup: "Hotel Lima",
            notes: "Llegamos con 2 maletas",
            formId: "form-abc-123",
          }
          const formRes = await api.post(
            "/store/cart/booking-form",
            {
              cart_id: cart.id,
              group_id: groupId,
              pre_data: preData,
            } as StoreSaveBookingFormBodyType,
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )

          expect(formRes.status).toBe(200)

          // Step 3: Assert BookingForm
          const forms = await bookingFormModuleService.listBookingForms({ cart_id: cart.id })
          expect(forms.length).toBe(1)
          const form = forms[0]
          expect(form.status).toBe("draft")
          expect(form.type).toBe("package")
          expect(form.entity_id).toBe(pkg.id)
          expect(form.group_id).toBe(groupId)
          expect(form.pre_data).toEqual(preData)
        })
      })

      describe("Test 2: should propagate preData from BookingForm to package booking on order completion", () => {
        it("should propagate preData from BookingForm to booking on order completion", async () => {
          const cart = await cartModule.createCarts({
            email: "propagate-test@example.com",
            region_id: region.id,
            sales_channel_id: salesChannel.id,
            currency_code: "usd",
          })

          // Step 1: Add package items via store route (gets group_id in line items metadata, no preData yet)
          const res = await api.post(
            "/store/cart/package-items",
            {
              cart_id: cart.id,
              package_id: pkg.id,
              package_date: testDate,
              adults: 2,
              children: 0,
              infants: 0,
              items: [{ variant_id: adultVariant.id, quantity: 2, unit_price: 100 }],
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )
          expect(res.status).toBe(200)

          // Get group_id from cart line items
          const { data: [fetchedCart] } = await query.graph({
            entity: "cart",
            fields: ["id", "items.metadata"],
            filters: { id: cart.id },
          })
          const packageItem = fetchedCart.items.find((i: any) => i.metadata?.is_package === true)
          expect(packageItem).toBeDefined()
          const groupId = packageItem.metadata.group_id
          expect(groupId).toBeDefined()

          // Step 1.5: Save form via booking-form endpoint
          const preData = {
            firstName: "María",
            lastName: "García",
            email: "maria@test.com",
            phone: "+51999123456",
            pickup: "Hotel Lima",
            notes: "Llegamos con 2 maletas",
            formId: "propagate-form-123",
          }
          const formRes = await api.post(
            "/store/cart/booking-form",
            {
              cart_id: cart.id,
              group_id: groupId,
              pre_data: preData,
            } as StoreSaveBookingFormBodyType,
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )
          expect(formRes.status).toBe(200)

          // Confirm BookingForm was created
          const forms = await bookingFormModuleService.listBookingForms({ cart_id: cart.id })
          expect(forms.length).toBe(1)
          const formId = forms[0].id

          // Step 2: Create payment collection + authorize (mirror tour-cart-metadata-flow helper)
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

          // Step 3: Create order DIRECTLY (bypass completeCartWithPackagesWorkflow to avoid sync booking creation)
          const orderItems = cartsWithPayment[0].items.map((item: any) => ({
            title: item.title || "Package Item",
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

          // Step 4: Manually trigger the subscriber (no polling needed — synchronous invoke)
          await triggerPackageOrderPlaced(order.id)

          // Step 5: Assert booking was created with preData from BookingForm
          const bookings = await packageModuleService.listPackageBookings({ order_id: order.id })
          expect(bookings.length).toBeGreaterThan(0)
          const booking = bookings[0]
          expect(booking.order_id).toBe(order.id)
          expect(booking.package_id).toBe(pkg.id)
          expect(booking.metadata?.preData).toEqual(preData)
          expect(booking.metadata?.group_id).toBe(groupId)

          // Step 6: Assert BookingForm was marked consumed
          const consumedForm = await bookingFormModuleService.retrieveBookingForm(formId)
          expect(consumedForm.status).toBe("consumed")
        })
      })

      describe("Test 3: should create package booking without preData when no form sent", () => {
        it("should create package booking without preData when no BookingForm exists", async () => {
          const cart = await cartModule.createCarts({
            email: "fallback-test@example.com",
            region_id: region.id,
            sales_channel_id: salesChannel.id,
            currency_code: "usd",
          })

          // Add package items WITHOUT preData
          const res = await api.post(
            "/store/cart/package-items",
            {
              cart_id: cart.id,
              package_id: pkg.id,
              package_date: testDate,
              adults: 1,
              children: 0,
              infants: 0,
              items: [{ variant_id: adultVariant.id, quantity: 1, unit_price: 100 }],
              // NO preData field
            },
            { headers: { "x-publishable-api-key": publishableApiKeyToken } }
          )
          expect(res.status).toBe(200)

          // No BookingForm should exist for this cart
          const forms = await bookingFormModuleService.listBookingForms({ cart_id: cart.id })
          expect(forms.length).toBe(0)

          // Create payment + order directly (same as Test 2 steps 2-3)
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
            title: item.title || "Package Item",
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

          await triggerPackageOrderPlaced(order.id)

          // Booking created but no preData (no form, no order.metadata.preData)
          const bookings = await packageModuleService.listPackageBookings({ order_id: order.id })
          expect(bookings.length).toBeGreaterThan(0)
          expect(bookings[0].metadata?.preData).toBeUndefined()
        })
      })
    })
  },
})
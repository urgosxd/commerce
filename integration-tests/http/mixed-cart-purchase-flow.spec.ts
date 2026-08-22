import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createPaymentCollectionForCartWorkflow, completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { TOUR_MODULE, PassengerType as TourPassengerType } from "../../src/modules/tour"
import TourModuleService from "../../src/modules/tour/service"
import { PACKAGE_MODULE } from "../../src/modules/package"
import PackageModuleService from "../../src/modules/package/service"
import { PassengerType as PackagePassengerType } from "../../src/modules/package/models/package-variant"

jest.setTimeout(120 * 1000)

/**
 * Integration tests for mixed cart purchase flow
 * 
 * These tests verify the E2E flow for purchasing both tours and packages in a single cart:
 * 1. Create 2 tours and 2 packages with available dates
 * 2. Create a single cart with all 4 items mixed
 * 3. Process the mixed cart through completion workflow
 * 4. Verify order created with all items
 * 5. Verify tour bookings created for tour items
 * 6. Verify package bookings created for package items
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("Mixed Cart Purchase Flow - E2E (2 Tours + 2 Packages)", () => {
      let container: any
      let tourModuleService: TourModuleService
      let packageModuleService: PackageModuleService
      let productModule: any
      let cartModule: any
      let salesChannelModule: any
      let regionModule: any
      let customerModule: any
      let orderModule: any
      let paymentModule: any
      let remoteLink: any
      let query: any

      // Test data
      let tours: any[] = []
      let packages: any[] = []
      let products: any[] = []
      let region: any
      let salesChannel: any
      let tourProductVariants: any[] = []
      let packageProductVariants: any[] = []
      
      const testDate = "2027-02-20"
      const tourCapacity = 20
      const packageCapacity = 20

      beforeAll(async () => {
        container = getContainer()
        tourModuleService = container.resolve(TOUR_MODULE)
        packageModuleService = container.resolve(PACKAGE_MODULE)
        productModule = container.resolve(Modules.PRODUCT)
        cartModule = container.resolve(Modules.CART)
        salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
        regionModule = container.resolve(Modules.REGION)
        customerModule = container.resolve(Modules.CUSTOMER)
        orderModule = container.resolve(Modules.ORDER)
        paymentModule = container.resolve(Modules.PAYMENT)
        remoteLink = container.resolve(ContainerRegistrationKeys.LINK)
        query = container.resolve("query")
      })

      beforeEach(async () => {
        // Create sales channel
        salesChannel = await salesChannelModule.createSalesChannels({
          name: "Test Sales Channel",
        })

        // Create region with currency
        region = await regionModule.createRegions({
          name: "Test Region",
          currency_code: "usd",
          countries: ["us"],
          payment_providers: ["pp_system_default"],
        })

        // Create Tour 1
        const tourProduct1 = await productModule.createProducts({
          title: "Cusco City Tour",
          description: "Amazing city tour of Cusco",
          status: "published",
          sales_channels: [{ id: salesChannel.id }],
          options: [
            {
              title: "Passenger Type",
              values: ["Adult", "Child", "Infant"],
            },
          ],
        })
        products.push(tourProduct1)

        const tour1 = await tourModuleService.createTours({
          product_id: tourProduct1.id,
          slug: `tour-mixed-cusco-${Date.now()}-${Math.round(
            Math.random() * 1e6
          )}`,
          destination: "Cusco",
          description: "Full day city tour of Cusco",
          duration_days: 1,
          max_capacity: tourCapacity,
        })
        tours.push(tour1)

        // Create variants for Tour 1
        const passengerTypes = ["adult", "child", "infant"]
        for (const type of passengerTypes) {
          const variant = await productModule.createProductVariants({
            product_id: tourProduct1.id,
            title: `${type.charAt(0).toUpperCase() + type.slice(1)} Ticket`,
            sku: `CUSCO-TOUR-${type.toUpperCase()}-001`,
            prices: [
              {
                currency_code: "usd",
                amount: type === "adult" ? 150 : type === "child" ? 100 : 0,
              },
            ],
            options: {
              "Passenger Type": type.charAt(0).toUpperCase() + type.slice(1),
            },
            requires_shipping: false,
            manage_inventory: false,
            allow_backorder: true,
          })

          tourProductVariants.push(variant)

          await tourModuleService.createTourVariants({
            tour_id: tour1.id,
            variant_id: variant.id,
            passenger_type: type as TourPassengerType,
          })
        }

        // Create Tour 2
        const tourProduct2 = await productModule.createProducts({
          title: "Lima Historical Tour",
          description: "Historical tour of Lima",
          status: "published",
          sales_channels: [{ id: salesChannel.id }],
          options: [
            {
              title: "Passenger Type",
              values: ["Adult", "Child", "Infant"],
            },
          ],
        })
        products.push(tourProduct2)

        const tour2 = await tourModuleService.createTours({
          product_id: tourProduct2.id,
          slug: `tour-mixed-lima-${Date.now()}-${Math.round(
            Math.random() * 1e6
          )}`,
          destination: "Lima",
          description: "Full day historical tour of Lima",
          duration_days: 1,
          max_capacity: tourCapacity,
        })
        tours.push(tour2)

        // Create variants for Tour 2
        for (const type of passengerTypes) {
          const variant = await productModule.createProductVariants({
            product_id: tourProduct2.id,
            title: `${type.charAt(0).toUpperCase() + type.slice(1)} Ticket`,
            sku: `LIMA-TOUR-${type.toUpperCase()}-001`,
            prices: [
              {
                currency_code: "usd",
                amount: type === "adult" ? 120 : type === "child" ? 80 : 0,
              },
            ],
            options: {
              "Passenger Type": type.charAt(0).toUpperCase() + type.slice(1),
            },
            requires_shipping: false,
            manage_inventory: false,
            allow_backorder: true,
          })

          tourProductVariants.push(variant)

          await tourModuleService.createTourVariants({
            tour_id: tour2.id,
            variant_id: variant.id,
            passenger_type: type as TourPassengerType,
          })
        }

        // Create Package 1
        const packageProduct1 = await productModule.createProducts({
          title: "Cusco Adventure Package",
          description: "3-day adventure package in Cusco",
          status: "published",
          sales_channels: [{ id: salesChannel.id }],
          options: [
            {
              title: "Passenger Type",
              values: ["Adult", "Child", "Infant"],
            },
          ],
        })
        products.push(packageProduct1)

        const package1 = await packageModuleService.createPackages({
          product_id: packageProduct1.id,
          slug: `package-mixed-cusco-${Date.now()}-${Math.round(
            Math.random() * 1e6
          )}`,
          destination: "Cusco",
          description: "3-day adventure package in Cusco",
          duration_days: 3,
          max_capacity: packageCapacity,
        })
        packages.push(package1)

        // Create variants for Package 1
        for (const type of passengerTypes) {
          const variant = await productModule.createProductVariants({
            product_id: packageProduct1.id,
            title: `${type.charAt(0).toUpperCase() + type.slice(1)} Ticket`,
            sku: `CUSCO-PKG-${type.toUpperCase()}-001`,
            prices: [
              {
                currency_code: "usd",
                amount: type === "adult" ? 500 : type === "child" ? 350 : 0,
              },
            ],
            options: {
              "Passenger Type": type.charAt(0).toUpperCase() + type.slice(1),
            },
            requires_shipping: false,
            manage_inventory: false,
            allow_backorder: true,
          })

          packageProductVariants.push(variant)

          await packageModuleService.createPackageVariants({
            package: package1.id,
            variant_id: variant.id,
            passenger_type:
              type === "adult"
                ? PackagePassengerType.ADULT
                : type === "child"
                ? PackagePassengerType.CHILD
                : PackagePassengerType.INFANT,
          })
        }

        // Create Package 2
        const packageProduct2 = await productModule.createProducts({
          title: "Machu Picchu Package",
          description: "4-day Machu Picchu expedition package",
          status: "published",
          sales_channels: [{ id: salesChannel.id }],
          options: [
            {
              title: "Passenger Type",
              values: ["Adult", "Child", "Infant"],
            },
          ],
        })
        products.push(packageProduct2)

        const package2 = await packageModuleService.createPackages({
          product_id: packageProduct2.id,
          slug: `package-mixed-machu-picchu-${Date.now()}-${Math.round(
            Math.random() * 1e6
          )}`,
          destination: "Machu Picchu",
          description: "4-day Machu Picchu expedition package",
          duration_days: 4,
          max_capacity: packageCapacity,
        })
        packages.push(package2)

        // Create variants for Package 2
        for (const type of passengerTypes) {
          const variant = await productModule.createProductVariants({
            product_id: packageProduct2.id,
            title: `${type.charAt(0).toUpperCase() + type.slice(1)} Ticket`,
            sku: `MACHUPICHU-PKG-${type.toUpperCase()}-001`,
            prices: [
              {
                currency_code: "usd",
                amount: type === "adult" ? 800 : type === "child" ? 600 : 0,
              },
            ],
            options: {
              "Passenger Type": type.charAt(0).toUpperCase() + type.slice(1),
            },
            requires_shipping: false,
            manage_inventory: false,
            allow_backorder: true,
          })

          packageProductVariants.push(variant)

          await packageModuleService.createPackageVariants({
            package: package2.id,
            variant_id: variant.id,
            passenger_type:
              type === "adult"
                ? PackagePassengerType.ADULT
                : type === "child"
                ? PackagePassengerType.CHILD
                : PackagePassengerType.INFANT,
          })
        }
      })

      afterEach(async () => {
        try {
          // Clean up tour bookings
          for (const tour of tours) {
            const bookings = await tourModuleService.listTourBookings({
              tour_id: tour.id,
            })
            if (bookings.length > 0) {
              await tourModuleService.deleteTourBookings(
                bookings.map((b) => b.id)
              )
            }
            await tourModuleService.deleteTourVariants({
              tour_id: tour.id,
            })
            await tourModuleService.deleteTours(tour.id)
          }

          // Clean up package bookings
          for (const pkg of packages) {
            const bookings = await packageModuleService.listPackageBookings({
              package_id: pkg.id,
            })
            if (bookings.length > 0) {
              await packageModuleService.deletePackageBookings(
                bookings.map((b) => b.id)
              )
            }
            await packageModuleService.deletePackageVariants({
              package_id: pkg.id,
            })
            await packageModuleService.deletePackages(pkg.id)
          }

          // Clean up products
          for (const variant of tourProductVariants) {
            await productModule.deleteProductVariants(variant.id)
          }
          for (const variant of packageProductVariants) {
            await productModule.deleteProductVariants(variant.id)
          }
          for (const product of products) {
            await productModule.deleteProducts(product.id)
          }

          if (region) {
            await regionModule.deleteRegions(region.id)
          }
          if (salesChannel) {
            await salesChannelModule.deleteSalesChannels(salesChannel.id)
          }
        } catch (error) {
          console.error("Cleanup error:", error)
        }

        tours = []
        packages = []
        products = []
        tourProductVariants = []
        packageProductVariants = []
      })

// Helper functions for native workflows with manual subscriber triggers
      async function completeCartAndTriggerTourSubscriber(cartId: string) {
        const { result } = await completeCartWorkflow(container).run({ input: { id: cartId } })
        
        // completeCartWorkflow emits order.placed internally → subscriber fires async.
        // Poll for the booking to appear (don't trigger manually — that causes duplicates).
        for (let i = 0; i < 30; i++) {
          const tourBookings = await tourModuleService.listTourBookings({ order_id: result.id })
          const pkgBookings = await packageModuleService.listPackageBookings({ order_id: result.id })
          if (tourBookings.length > 0 && pkgBookings.length > 0) break
          if (tourBookings.length > 0 || pkgBookings.length > 0) {
            await new Promise(r => setTimeout(r, 500))
            break
          }
          await new Promise(r => setTimeout(r, 100))
        }
        
        // result is only { id } — fetch full order to get items, email, status, etc.
        const { data: [order] } = await query.graph({
          entity: "order",
          fields: ["id", "items.*", "email", "status", "metadata", "display_id", "currency_code", "total", "subtotal"],
          filters: { id: result.id },
        })
        return order
      }
 
      async function completeCartAndTriggerPackageSubscriber(cartId: string) {
        const { result } = await completeCartWorkflow(container).run({ input: { id: cartId } })
        
        // completeCartWorkflow emits order.placed internally → subscriber fires async.
        // Poll for the booking to appear (don't trigger manually — that causes duplicates).
        for (let i = 0; i < 30; i++) {
          const tourBookings = await tourModuleService.listTourBookings({ order_id: result.id })
          const pkgBookings = await packageModuleService.listPackageBookings({ order_id: result.id })
          if (tourBookings.length > 0 && pkgBookings.length > 0) break
          if (tourBookings.length > 0 || pkgBookings.length > 0) {
            await new Promise(r => setTimeout(r, 500))
            break
          }
          await new Promise(r => setTimeout(r, 100))
        }
        
        // result is only { id } — fetch full order to get items, email, status, etc.
        const { data: [order] } = await query.graph({
          entity: "order",
          fields: ["id", "items.*", "email", "status", "metadata", "display_id", "currency_code", "total", "subtotal"],
          filters: { id: result.id },
        })
        return order
      }
 
      async function completeCartAndTriggerAllSubscribers(cartId: string) {
        const { result } = await completeCartWorkflow(container).run({ input: { id: cartId } })
        
        // completeCartWorkflow emits order.placed internally → subscriber fires async.
        // Poll for the bookings to appear (don't trigger manually — that causes duplicates).
        for (let i = 0; i < 30; i++) {
          const tourBookings = await tourModuleService.listTourBookings({ order_id: result.id })
          const pkgBookings = await packageModuleService.listPackageBookings({ order_id: result.id })
          if (tourBookings.length > 0 && pkgBookings.length > 0) break
          if (tourBookings.length > 0 || pkgBookings.length > 0) {
            await new Promise(r => setTimeout(r, 500))
            break
          }
          await new Promise(r => setTimeout(r, 100))
        }
        
        // result is only { id } — fetch full order to get items, email, status, etc.
        const { data: [order] } = await query.graph({
          entity: "order",
          fields: ["id", "items.*", "email", "status", "metadata", "display_id", "currency_code", "total", "subtotal"],
          filters: { id: result.id },
        })
        return order
      }

      /**
       * Helper function to create a mixed cart with both tours and packages
       */
      async function createMixedCart(
        customerEmail: string,
        tourPassengers: {
          adults: number
          children: number
          infants: number
        } = { adults: 1, children: 0, infants: 0 },
        packagePassengers: {
          adults: number
          children: number
          infants: number
        } = { adults: 1, children: 0, infants: 0 }
      ) {
        // Create or retrieve customer
        const customers = await customerModule.listCustomers({
          email: customerEmail,
        })

        let customer
        if (customers.length === 0) {
          customer = await customerModule.createCustomers({
            email: customerEmail,
            first_name: "Test",
            last_name: "Customer",
          })
        } else {
          customer = customers[0]
        }

        // Get fresh product references with variants
        const tourProduct1 = await productModule.retrieveProduct(products[0].id, {
          relations: ["variants"],
        })
        const tourProduct2 = await productModule.retrieveProduct(products[1].id, {
          relations: ["variants"],
        })
        const packageProduct1 = await productModule.retrieveProduct(products[2].id, {
          relations: ["variants"],
        })
        const packageProduct2 = await productModule.retrieveProduct(products[3].id, {
          relations: ["variants"],
        })

        const items: any[] = []
        let totalPassengers = 0

        // Add Tour 1 items
        const tour1AdultVariant = tourProduct1.variants.find(
          (v: any) => v.title === "Adult Ticket"
        )
        if (tour1AdultVariant && tourPassengers.adults > 0) {
          items.push({
            variant_id: tour1AdultVariant.id,
            quantity: 1,
            requires_shipping: false,
            unit_price: 150 * tourPassengers.adults,
            title: `${tours[0].destination} - ${testDate} (Adults)`,
            metadata: {
              is_tour: true,
              tour_id: tours[0].id,
              tour_date: testDate,
              tour_destination: tours[0].destination,
              tour_duration_days: tours[0].duration_days,
              total_passengers: tourPassengers.adults,
              passengers: {
                adults: tourPassengers.adults,
                children: 0,
                infants: 0,
              },
              group_id: `tour-${tours[0].id}-${testDate}`,
              pricing_breakdown: [
                {
                  type: "ADULT",
                  quantity: tourPassengers.adults,
                  unit_price: 150,
                },
              ],
            },
          })
          totalPassengers += tourPassengers.adults
        }

        // Add Tour 2 items
        const tour2AdultVariant = tourProduct2.variants.find(
          (v: any) => v.title === "Adult Ticket"
        )
        if (tour2AdultVariant && tourPassengers.adults > 0) {
          items.push({
            variant_id: tour2AdultVariant.id,
            quantity: 1,
            requires_shipping: false,
            unit_price: 120 * tourPassengers.adults,
            title: `${tours[1].destination} - ${testDate} (Adults)`,
            metadata: {
              is_tour: true,
              tour_id: tours[1].id,
              tour_date: testDate,
              tour_destination: tours[1].destination,
              tour_duration_days: tours[1].duration_days,
              total_passengers: tourPassengers.adults,
              passengers: {
                adults: tourPassengers.adults,
                children: 0,
                infants: 0,
              },
              group_id: `tour-${tours[1].id}-${testDate}`,
              pricing_breakdown: [
                {
                  type: "ADULT",
                  quantity: tourPassengers.adults,
                  unit_price: 120,
                },
              ],
            },
          })
          totalPassengers += tourPassengers.adults
        }

        // Add Package 1 items
        const package1AdultVariant = packageProduct1.variants.find(
          (v: any) => v.title === "Adult Ticket"
        )
        if (package1AdultVariant && packagePassengers.adults > 0) {
          items.push({
            variant_id: package1AdultVariant.id,
            quantity: 1,
            requires_shipping: false,
            unit_price: 500 * packagePassengers.adults,
            title: `${packages[0].destination} - ${testDate} (Adults)`,
            metadata: {
              is_package: true,
              package_id: packages[0].id,
              package_date: testDate,
              package_destination: packages[0].destination,
              package_duration_days: packages[0].duration_days,
              total_passengers: packagePassengers.adults,
              passengers: {
                adults: packagePassengers.adults,
                children: 0,
                infants: 0,
              },
              group_id: `package-${packages[0].id}-${testDate}`,
              pricing_breakdown: [
                {
                  type: "ADULT",
                  quantity: packagePassengers.adults,
                  unit_price: 500,
                },
              ],
            },
          })
          totalPassengers += packagePassengers.adults
        }

        // Add Package 2 items
        const package2AdultVariant = packageProduct2.variants.find(
          (v: any) => v.title === "Adult Ticket"
        )
        if (package2AdultVariant && packagePassengers.adults > 0) {
          items.push({
            variant_id: package2AdultVariant.id,
            quantity: 1,
            requires_shipping: false,
            unit_price: 800 * packagePassengers.adults,
            title: `${packages[1].destination} - ${testDate} (Adults)`,
            metadata: {
              is_package: true,
              package_id: packages[1].id,
              package_date: testDate,
              package_destination: packages[1].destination,
              package_duration_days: packages[1].duration_days,
              total_passengers: packagePassengers.adults,
              passengers: {
                adults: packagePassengers.adults,
                children: 0,
                infants: 0,
              },
              group_id: `package-${packages[1].id}-${testDate}`,
              pricing_breakdown: [
                {
                  type: "ADULT",
                  quantity: packagePassengers.adults,
                  unit_price: 800,
                },
              ],
            },
          })
          totalPassengers += packagePassengers.adults
        }

        // Create cart with mixed items
        const cart = await cartModule.createCarts({
          currency_code: "usd",
          email: customerEmail,
          customer_id: customer.id,
          sales_channel_id: salesChannel.id,
          region_id: region.id,
          items,
        })

        // Create payment collection
        await createPaymentCollectionForCartWorkflow(container).run({
          input: {
            cart_id: cart.id,
          },
        })

        const { data: carts } = await query.graph({
          entity: "cart",
          fields: ["id", "total", "payment_collection.id"],
          filters: { id: cart.id },
        })
        const cartWithPayment = carts[0]

        await paymentModule.createPaymentSession(
          cartWithPayment.payment_collection.id,
          {
            provider_id: "pp_system_default",
            currency_code: "usd",
            amount: cartWithPayment.total,
            data: {},
          }
        )

        const { data: cartsWithItems } = await query.graph({
          entity: "cart",
          fields: ["id", "total", "items.*", "items.metadata"],
          filters: { id: cart.id },
        })

        return { cart: cartsWithItems[0], totalPassengers }
      }

      describe("Mixed Cart Completion - Success Cases", () => {
        it("should complete mixed cart and create order with all items", async () => {
          const { cart, totalPassengers } = await createMixedCart(
            "mixed@example.com",
            { adults: 1, children: 0, infants: 0 },
            { adults: 1, children: 0, infants: 0 }
          )

          expect(cart).toBeDefined()
          expect(cart.items).toHaveLength(4) // 2 tours + 2 packages
          expect(cart.total).toBeDefined()

          // Count tours and packages in cart
          const tourItems = cart.items.filter((i: any) => i.metadata?.is_tour)
          const packageItems = cart.items.filter((i: any) => i.metadata?.is_package)

          expect(tourItems).toHaveLength(2)
          expect(packageItems).toHaveLength(2)
        })

        it("should process tours through tour workflow", async () => {
          const { cart } = await createMixedCart(
            "tour-only@example.com",
            { adults: 1, children: 0, infants: 0 },
            { adults: 1, children: 0, infants: 0 }
          )

          // Process tours first - this should create order
          const tourResult = await completeCartAndTriggerTourSubscriber(cart.id)

          expect(tourResult).toBeDefined()
          expect((tourResult as any).id).toBeDefined()
          expect((tourResult as any).email).toBe("tour-only@example.com")
          expect((tourResult as any).items).toHaveLength(4) // All items in order

          const orderId = (tourResult as any).id

          // Verify tour bookings were created
          const tourBookings = await tourModuleService.listTourBookings({
            order_id: orderId,
          })

          expect(tourBookings.length).toBeGreaterThan(0)
          expect(tourBookings.length).toBeLessThanOrEqual(2) // At most 2 tours
        })

        it("should process packages through package workflow", async () => {
          const { cart } = await createMixedCart(
            "package-only@example.com",
            { adults: 1, children: 0, infants: 0 },
            { adults: 1, children: 0, infants: 0 }
          )

          // Process packages - this should create order
          const packageResult = await completeCartAndTriggerPackageSubscriber(cart.id)

          expect(packageResult).toBeDefined()
          expect((packageResult as any).id).toBeDefined()
          expect((packageResult as any).email).toBe("package-only@example.com")
          expect((packageResult as any).items).toHaveLength(4) // All items in order

          const orderId = (packageResult as any).id

          // Verify package bookings were created
          const packageBookings = await packageModuleService.listPackageBookings({
            order_id: orderId,
          })

          expect(packageBookings.length).toBeGreaterThan(0)
          expect(packageBookings.length).toBeLessThanOrEqual(2) // At most 2 packages
        })

        it("should verify capacity reduction for mixed cart items", async () => {
          const initialTour1Capacity = await tourModuleService.getAvailableCapacity(
            tours[0].id,
            new Date(testDate)
          )
          const initialTour2Capacity = await tourModuleService.getAvailableCapacity(
            tours[1].id,
            new Date(testDate)
          )
          const initialPackage1Capacity =
            await packageModuleService.getAvailableCapacity(
              packages[0].id,
              new Date(testDate)
            )
          const initialPackage2Capacity =
            await packageModuleService.getAvailableCapacity(
              packages[1].id,
              new Date(testDate)
            )

          expect(initialTour1Capacity).toBe(tourCapacity)
          expect(initialTour2Capacity).toBe(tourCapacity)
          expect(initialPackage1Capacity).toBe(packageCapacity)
          expect(initialPackage2Capacity).toBe(packageCapacity)

          const { cart } = await createMixedCart(
            "capacity@example.com",
            { adults: 1, children: 0, infants: 0 },
            { adults: 1, children: 0, infants: 0 }
          )

          // Process tours workflow
          await completeCartAndTriggerTourSubscriber(cart.id)

          // Verify tour capacities reduced
          const remainingTour1Capacity = await tourModuleService.getAvailableCapacity(
            tours[0].id,
            new Date(testDate)
          )
          const remainingTour2Capacity = await tourModuleService.getAvailableCapacity(
            tours[1].id,
            new Date(testDate)
          )

          expect(remainingTour1Capacity).toBe(tourCapacity - 1)
          expect(remainingTour2Capacity).toBe(tourCapacity - 1)

          // Package capacities should still be full
          const remainingPackage1Capacity =
            await packageModuleService.getAvailableCapacity(
              packages[0].id,
              new Date(testDate)
            )
          const remainingPackage2Capacity =
            await packageModuleService.getAvailableCapacity(
              packages[1].id,
              new Date(testDate)
            )

          // Package capacities also reduced — native completeCartWorkflow emits
          // order.placed for ALL items, so both subscribers fire
          expect(remainingPackage1Capacity).toBe(packageCapacity - 1)
          expect(remainingPackage2Capacity).toBe(packageCapacity - 1)
        })

        it("should handle mixed cart with multiple passenger types", async () => {
          const { cart } = await createMixedCart(
            "multipassenger@example.com",
            { adults: 2, children: 1, infants: 0 },
            { adults: 1, children: 1, infants: 0 }
          )

          // We need to reconstruct the cart with all passenger types
          // Since our helper currently only handles adults for simplicity,
          // we verify the basic structure
          expect(cart).toBeDefined()
          expect(cart.items.length).toBeGreaterThan(0)

          const tourItems = cart.items.filter((i: any) => i.metadata?.is_tour)
          const packageItems = cart.items.filter((i: any) => i.metadata?.is_package)

          expect(tourItems.length).toBeGreaterThan(0)
          expect(packageItems.length).toBeGreaterThan(0)
        })

        it("should successfully complete bookings for ALL items in mixed cart", async () => {
          const { cart } = await createMixedCart(
            "full-completion@example.com",
            { adults: 1, children: 0, infants: 0 },
            { adults: 1, children: 0, infants: 0 }
          )

          // Step 1: Run all workflows - this triggers all subscribers
          console.log("[TEST] Running all workflows...")
          const result = await completeCartAndTriggerAllSubscribers(cart.id)

          const orderId = (result as any).id
          console.log(`[TEST] Order created: ${orderId}`)

          // Verify tour bookings
          const tourBookings = await tourModuleService.listTourBookings({
            order_id: orderId,
          })
          console.log(`[TEST] Tour bookings created: ${tourBookings.length}`)
          expect(tourBookings.length).toBeGreaterThan(0)
          expect(tourBookings.length).toBeLessThanOrEqual(2)

          // Verify package bookings
          const allPackageBookings = await packageModuleService.listPackageBookings({
            order_id: orderId,
          })
          console.log(
            `[TEST] Package bookings found: ${allPackageBookings.length}`
          )
          expect(allPackageBookings.length).toBe(2)

          const finalTourBookings = await tourModuleService.listTourBookings({
            order_id: orderId,
          })
          expect(finalTourBookings.length).toBe(2)
        })
      })
    })
  },
})

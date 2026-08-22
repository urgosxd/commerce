import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  createApiKeysWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
} from "@medusajs/medusa/core-flows"
import { PACKAGE_MODULE } from "../../src/modules/package"
import PackageModuleService from "../../src/modules/package/service"
import { PassengerType } from "../../src/modules/package/models/package-variant"

jest.setTimeout(120 * 1000)

medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("Package Items Endpoint", () => {
      let container: any
      let packageModuleService: PackageModuleService
      let productModule: any
      let cartModule: any
      let salesChannelModule: any
      let regionModule: any
      let publishableApiKeyToken: string
      let query: any

      let pkg: any
      let product: any
      let region: any
      let salesChannel: any
      const testDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
      const packageCapacity = 20

      beforeAll(async () => {
        container = getContainer()
        packageModuleService = container.resolve(PACKAGE_MODULE)
        productModule = container.resolve(Modules.PRODUCT)
        cartModule = container.resolve(Modules.CART)
        salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
        regionModule = container.resolve(Modules.REGION)
        query = container.resolve(ContainerRegistrationKeys.QUERY)
      })

      beforeEach(async () => {
        salesChannel = await salesChannelModule.createSalesChannels({
          name: "Package Endpoint Channel",
        })

        region = await regionModule.createRegions({
          name: "Package Endpoint Region",
          currency_code: "usd",
          countries: ["us"],
          payment_providers: ["pp_system_default"],
        })

        product = await productModule.createProducts({
          title: "Endpoint Test Package",
          status: "published",
          sales_channels: [{ id: salesChannel.id }],
          options: [
            {
              title: "Passenger Type",
              values: ["Adult", "Child"],
            },
          ],
        })

        pkg = await packageModuleService.createPackages({
          product_id: product.id,
          slug: `package-endpoint-test-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          destination: "Test Destination",
          duration_days: 5,
          thumbnail: "https://example.com/test.jpg",
          max_capacity: packageCapacity,
        })

        const variants = await productModule.createProductVariants([
          {
            product_id: product.id,
            title: "Adult Ticket",
            sku: "TEST-ADULT",
            prices: [{ currency_code: "usd", amount: 200 }],
            options: { "Passenger Type": "Adult" },
          },
          {
            product_id: product.id,
            title: "Child Ticket",
            sku: "TEST-CHILD",
            prices: [{ currency_code: "usd", amount: 100 }],
            options: { "Passenger Type": "Child" },
          }
        ])

        const adultVariant = variants.find((v: any) => v.title === "Adult Ticket")
        const childVariant = variants.find((v: any) => v.title === "Child Ticket")

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

        product = await productModule.retrieveProduct(product.id, {
          relations: ["variants"],
        })

        const { result: publishableApiKeyResult } = await createApiKeysWorkflow(container).run({
          input: {
            api_keys: [
              {
                title: `pkg-endpoint-key-${Date.now()}`,
                type: "publishable",
                created_by: "test",
              },
            ],
          },
        })

        publishableApiKeyToken = publishableApiKeyResult[0].token

        await linkSalesChannelsToApiKeyWorkflow(container).run({
          input: {
            id: publishableApiKeyResult[0].id,
            add: [salesChannel.id],
          },
        })
      })

      it("should add package items using the endpoint", async () => {
        const cart = await cartModule.createCarts({
          email: "endpoint@test.com",
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: "usd",
        })

        const adultVariant = product.variants.find((v: any) => v.title === "Adult Ticket")
        const childVariant = product.variants.find((v: any) => v.title === "Child Ticket")

        const response = await api.post(
          "/store/cart/package-items",
          {
            cart_id: cart.id,
            package_date: testDate,
            items: [
              {
                variant_id: adultVariant.id,
                quantity: 2,
                unit_price: 200,
              },
              {
                variant_id: childVariant.id,
                quantity: 1,
                unit_price: 100,
              }
            ]
          },
          {
            headers: {
              "x-publishable-api-key": publishableApiKeyToken,
            },
          }
        )

        expect(response.status).toBe(200)
        expect(response.data.summary.total_passengers).toBe(3)
        expect(response.data.summary.package_id).toBe(pkg.id)

        const updatedCart = await cartModule.retrieveCart(cart.id, { relations: ["items"] })
        expect(updatedCart.items).toHaveLength(2)

        const adultItem = updatedCart.items.find((i: any) => i.unit_price === 200)
        expect(adultItem.quantity).toBe(2)
        expect(adultItem.metadata.is_package).toBe(true)
        expect(adultItem.requires_shipping).toBe(false)
        expect(updatedCart.items.every((i: any) => i.requires_shipping === false)).toBe(true)
      })

      it("should return prices with quantities after adding multivariant package items", async () => {
        const created = await cartModule.createCarts({
          email: "multivariant-prices@test.com",
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: "usd",
        })

        const cartId = created.id

        const adultProductVariant = product.variants.find(
          (v: any) => v.title === "Adult Ticket"
        )
        const childProductVariant = product.variants.find(
          (v: any) => v.title === "Child Ticket"
        )

        expect(adultProductVariant).toBeDefined()
        expect(childProductVariant).toBeDefined()

        const variantPriceById = new Map<string, number>([
          [adultProductVariant.id, 200],
          [childProductVariant.id, 100],
        ])

        const addRes = await api.post(
          "/store/cart/package-items",
          {
            cart_id: cartId,
            package_date: testDate,
            items: [
              {
                variant_id: adultProductVariant.id,
                quantity: 3,
                unit_price: 200,
                metadata: { package_date: testDate },
              },
              {
                variant_id: childProductVariant.id,
                quantity: 2,
                unit_price: 100,
                metadata: { package_date: testDate },
              },
            ],
          },
          {
            headers: {
              "x-publishable-api-key": publishableApiKeyToken,
            },
          }
        )

        expect(addRes.status).toBe(200)

        const { data: cartsWithItems } = await query.graph({
          entity: "cart",
          fields: [
            "id",
            "item_subtotal",
            "items.id",
            "items.thumbnail",
            "items.quantity",
            "items.unit_price",
            "items.total",
            "items.subtotal",
            "items.metadata",
          ],
          filters: { id: cartId },
        })

        const cart = cartsWithItems[0]
        const packageItems = cart.items.filter((i: any) => i.metadata?.is_package)

        expect(packageItems).toHaveLength(2)

        const adultItem = packageItems.find(
          (i: any) => i.metadata?.passenger_type === "ADULT"
        )
        const childItem = packageItems.find(
          (i: any) => i.metadata?.passenger_type === "CHILD"
        )

        expect(adultItem).toBeDefined()
        expect(childItem).toBeDefined()

        expect(adultItem.quantity).toBe(3)
        expect(childItem.quantity).toBe(2)

        const resolveLineTotal = (item: any) => {
          if (item.subtotal !== undefined && item.subtotal !== null) {
            return Number(item.subtotal)
          }

          if (item.total !== undefined && item.total !== null) {
            return Number(item.total)
          }

          throw new Error(`Line item ${item.id} does not expose subtotal/total`)
        }

        const adultLineTotal = resolveLineTotal(adultItem)
        const childLineTotal = resolveLineTotal(childItem)

        expect(adultLineTotal).toBe(200 * 3)
        expect(childLineTotal).toBe(100 * 2)
        expect(Number(cart.item_subtotal)).toBe(adultLineTotal + childLineTotal)
      })

      it("should inherit package thumbnail when no override provided", async () => {
        const created = await cartModule.createCarts({
          email: "thumbnail-inherit@test.com",
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: "usd",
        })

        const cartId = created.id

        const adultProductVariant = product.variants.find(
          (v: any) => v.title === "Adult Ticket"
        )

        expect(adultProductVariant).toBeDefined()

        // Add items WITHOUT providing thumbnail override
        const addRes = await api.post(
          "/store/cart/package-items",
          {
            cart_id: cartId,
            package_date: testDate,
            items: [
              {
                variant_id: adultProductVariant.id,
                quantity: 1,
                unit_price: 200,
                metadata: { package_date: testDate },
              },
            ],
          },
          {
            headers: {
              "x-publishable-api-key": publishableApiKeyToken,
            },
          }
        )

        expect(addRes.status).toBe(200)

        const { data: cartsWithItems } = await query.graph({
          entity: "cart",
          fields: ["id", "items.*", "items.metadata"],
          filters: { id: cartId },
        })

        const cart = cartsWithItems[0]
        const packageItems = cart.items.filter((i: any) => i.metadata?.is_package)

        expect(packageItems).toHaveLength(1)
        const adultItem = packageItems[0]

        // The cart item should inherit the package's thumbnail
        expect(adultItem.thumbnail).toBe(pkg.thumbnail)
        expect(adultItem.thumbnail).toBe("https://example.com/test.jpg")
      })

      it("should validate custom thumbnails in cart retrieval", async () => {
        const created = await cartModule.createCarts({
          email: "variant-thumbnails@test.com",
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: "usd",
        })

        const cartId = created.id

        const adultProductVariant = product.variants.find(
          (v: any) => v.title === "Adult Ticket"
        )
        const childProductVariant = product.variants.find(
          (v: any) => v.title === "Child Ticket"
        )

        const customAdultThumbnail = "https://example.com/custom-adult.jpg"
        const customChildThumbnail = "https://example.com/custom-child.jpg"

        expect(adultProductVariant).toBeDefined()
        expect(childProductVariant).toBeDefined()

        // Add items WITH custom thumbnail overrides
        const addRes = await api.post(
          "/store/cart/package-items",
          {
            cart_id: cartId,
            package_date: testDate,
            items: [
              {
                variant_id: adultProductVariant.id,
                quantity: 1,
                unit_price: 200,
                thumbnail: customAdultThumbnail,
                metadata: { package_date: testDate },
              },
              {
                variant_id: childProductVariant.id,
                quantity: 1,
                unit_price: 100,
                thumbnail: customChildThumbnail,
                metadata: { package_date: testDate },
              },
            ],
          },
          {
            headers: {
              "x-publishable-api-key": publishableApiKeyToken,
            },
          }
        )

        expect(addRes.status).toBe(200)

        // Retrieve cart with item details
        const { data: cartsWithDetails } = await query.graph({
          entity: "cart",
          fields: [
            "id",
            "items.*",
            "items.thumbnail",
            "items.metadata",
          ],
          filters: { id: cartId },
        })

        const cart = cartsWithDetails[0]
        const packageItems = cart.items.filter((i: any) => i.metadata?.is_package)

        expect(packageItems).toHaveLength(2)

        const adultItem = packageItems.find(
          (i: any) => i.metadata?.passenger_type === "ADULT"
        )
        const childItem = packageItems.find(
          (i: any) => i.metadata?.passenger_type === "CHILD"
        )

        expect(adultItem).toBeDefined()
        expect(childItem).toBeDefined()

        // Cart item thumbnails should use the custom overrides
        expect(adultItem.thumbnail).toBe(customAdultThumbnail)
        expect(childItem.thumbnail).toBe(customChildThumbnail)
      })

      it("should handle mixed passenger types via API endpoint with correct metadata", async () => {
        const created = await cartModule.createCarts({
          email: "metadata-api@test.com",
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: "usd",
        })

        const cartId = created.id

        const adultProductVariant = product.variants.find(
          (v: any) => v.title === "Adult Ticket"
        )
        const childProductVariant = product.variants.find(
          (v: any) => v.title === "Child Ticket"
        )

        expect(adultProductVariant).toBeDefined()
        expect(childProductVariant).toBeDefined()

        const groupId = `package-${pkg.id}-${testDate}`

        const addRes = await api.post(
          "/store/cart/package-items",
          {
            cart_id: cartId,
            package_date: testDate,
            items: [
              {
                variant_id: adultProductVariant.id,
                quantity: 2,
                unit_price: 200,
                metadata: {
                  is_package: true,
                  package_id: pkg.id,
                  package_date: testDate,
                  total_passengers: 2,
                  passengers: { adults: 2, children: 0 },
                  group_id: groupId,
                },
              },
              {
                variant_id: childProductVariant.id,
                quantity: 1,
                unit_price: 100,
                metadata: {
                  is_package: true,
                  package_id: pkg.id,
                  package_date: testDate,
                  total_passengers: 2,
                  passengers: { adults: 0, children: 1 },
                  group_id: groupId,
                },
              },
            ],
          },
          {
            headers: {
              "x-publishable-api-key": publishableApiKeyToken,
            },
          }
        )

        expect(addRes.status).toBe(200)

        const { data: cartsWithItems } = await query.graph({
          entity: "cart",
          fields: ["id", "total", "items.*", "items.metadata"],
          filters: { id: cartId },
        })
        const cart = cartsWithItems[0]

        // Cart should have 2 separate line items (adult + child)
        expect(cart.items).toBeDefined()
        const packageItems = cart.items.filter((i: any) => i.metadata?.is_package)
        expect(packageItems).toHaveLength(2)

        const adultItem = packageItems.find((i: any) => i.metadata.passengers?.adults === 2)
        const childItem = packageItems.find((i: any) => i.metadata.passengers?.children === 1)

        expect(adultItem).toBeDefined()
        expect(childItem).toBeDefined()

        // Verify metadata.passengers structure per item
        expect(adultItem.metadata.passengers).toEqual({ adults: 2, children: 0, infants: 0 })
        expect(childItem.metadata.passengers).toEqual({ adults: 0, children: 1, infants: 0 })

        // Verify other package metadata
        expect(adultItem.metadata.is_package).toBe(true)
        expect(adultItem.metadata.package_id).toBe(pkg.id)
        expect(adultItem.metadata.package_date).toBe(testDate)
        expect(adultItem.metadata.total_passengers).toBe(3)

        // Verify group_id shared
        expect(adultItem.metadata.group_id).toBeDefined()
        expect(adultItem.metadata.group_id).toEqual(childItem.metadata.group_id)
      })
    })
  }
})

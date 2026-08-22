import {
  createWorkflow,
  WorkflowResponse,
  when,
  transform,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  CartWorkflowEvents,
  PromotionActions,
  Modules,
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils"
import { QueryContext } from "@medusajs/framework/utils"
import { generateEntityId } from "@medusajs/utils"
import {
  acquireLockStep,
  releaseLockStep,
  createLineItemsStep,
  refreshCartShippingMethodsWorkflow,
  updateCartPromotionsWorkflow,
  refreshPaymentCollectionForCartWorkflow,
  emitEventStep,
} from "@medusajs/core-flows"
import { conditionalCartFetchStep, invalidateCartCacheStep } from "./steps/conditional-cart-fetch"
import { TOUR_MODULE } from "../modules/tour"
import { PACKAGE_MODULE } from "../modules/package"
import { PassengerType } from "../modules/tour/models/tour-variant"
import TourModuleService from "../modules/tour/service"
import PackageModuleService from "../modules/package/service"
import { refetchAddToCartResultOptimized } from "../api/store/cart/refetch-cart"
import type { TrackingItem } from "../utils/conversion-tracking"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BookingType = "tour" | "package"

export type BookingInput = {
  cart_id: string
  type: BookingType
  id: string // tour_id or package_id
  date: string // tour_date or package_date
  adults: number
  children: number
  infants: number
  customer?: {
    name: string
    email?: string
    phone?: string
    formId?: any
  }
items?: Array<{
     variant_id: string
     quantity?: number
     unit_price?: number
     thumbnail?: string
     metadata?: Record<string, unknown>
   }>
 }

export type PassengerBreakdown = {
  type: "ADULT" | "CHILD" | "INFANT"
  variant_id: string
  quantity: number
  unit_price: number
  line_total: number
}

export type PricingBreakdown = {
  type: "ADULT" | "CHILD" | "INFANT"
  quantity: number
  unit_price: number
}

export type PreparedBooking = {
  line_items: Array<{
    id?: string
    variant_id: string
    title: string
    quantity: number
    unit_price: number
    thumbnail: string
    requires_shipping: false
    metadata: Record<string, unknown>
  }>
  total_price: number
  currency_code: string
  group_id: string
  tracking_items: TrackingItem[]
}

// ---------------------------------------------------------------------------
// META config map
// ---------------------------------------------------------------------------

const META = {
  tour: {
    flag: "is_tour",
    idKey: "tour_id",
    dateKey: "tour_date",
    destKey: "tour_destination",
    durKey: "tour_duration_days",
  },
  package: {
    flag: "is_package",
    idKey: "package_id",
    dateKey: "package_date",
    destKey: "package_destination",
    durKey: "package_duration_days",
  },
} as const

// ---------------------------------------------------------------------------
// Step: Prepare booking
// ---------------------------------------------------------------------------

/**
 * Validates input, fetches cart, validates booking availability,
 * calculates prices, and builds line items.
 *
 * This is a read-only step with no compensation function.
 */
const prepareBookingStep = createStep(
  "booking-bed-prepare",
  async (input: any, { container }) => {
    const { type, cart_id, id, date, adults: adultsInput, children: childrenInput, infants: infantsInput, customer: customerInput, items } = input

    const tourModuleService = type === "tour"
        ? container.resolve(TOUR_MODULE) as TourModuleService
        : undefined
    const packageModuleService = type === "package"
        ? container.resolve(PACKAGE_MODULE) as PackageModuleService
        : undefined

    const moduleService = type === "tour" ? tourModuleService : packageModuleService

    const throwInvalidData = (message: string, code?: string): never => {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, message, code)
    }

    // VALIDATE: Input shape, passenger counts
    if (!cart_id) {
      throwInvalidData("Missing required field: cart_id")
    }

    const ensuresCartId = cart_id as string
    const ensuresId = id as string | undefined
    const ensuresDate = date as string | undefined

    const cartModule = container.resolve(Modules.CART)
    const pricingModule = container.resolve(Modules.PRICING)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Check if items are provided (items list is available from input)
    const hasNativeLikeItems = Array.isArray(items) && items!.length > 0

    // uniqueVariantIds is needed for listTourVariants; compute early from raw items.
    const uniqueVariantIds: string[] = hasNativeLikeItems
      ? [...new Set((items as any[]).map((item: any) => item.variant_id))]
      : []

    // PHASE 1: Fetch cart, entity, and variant links IN PARALLEL.
    // - When items AND id are both provided, entity (with variants) is fetched here
    //   and reused for validateBooking + variantMap (skips later listVariants).
    // - When items are provided WITHOUT id, listVariants resolves the entity id;
    //   entity is fetched in the resolution block below.
    // - When no items, neither listVariants nor entity runs here.
    const [earlyEntity, cart, preLinkedVariants] = await Promise.all([
      hasNativeLikeItems && ensuresId && moduleService
        ? (type === "tour"
            ? (moduleService as TourModuleService).retrieveTourCached(ensuresId, { relations: ["variants"] })
            : (moduleService as PackageModuleService).retrievePackageCached(ensuresId, { relations: ["variants"] }))
        : Promise.resolve(null),
      cartModule.retrieveCart(ensuresCartId),
      (hasNativeLikeItems && moduleService)
        ? (type === "tour"
            ? (moduleService as TourModuleService).listTourVariants({ variant_id: uniqueVariantIds })
            : (moduleService as PackageModuleService).listPackageVariants({ variant_id: uniqueVariantIds }))
        : Promise.resolve([]),
    ])

    // OPTIMIZATION #1: when earlyEntity already has variants (path items+id), reuse
    // them instead of the listVariants result — the fetch was still needed to run in
    // parallel but we prefer the richer entity.variants (has full tour context).
    const earlyEntityVariants = (earlyEntity as any)?.variants
    const linkedVariants = (earlyEntityVariants && earlyEntityVariants.length > 0)
      ? earlyEntityVariants
      : preLinkedVariants

    // bookingEntity is null when items path derives the entity from variants.
    // It is set later after listTourVariants/listPackageVariants resolves the tour/package.
    // Use non-null assertion at usage sites — the code flow guarantees it is set by then.
    let entity: any = earlyEntity

    // Local variables for module-specific reasoning
    let adults = Number(adultsInput || 0)
    let children = Number(childrenInput || 0)
    let infants = Number(infantsInput || 0)
    let customer = customerInput
    let inputOverridesByVariant = new Map<string, { unit_price?: number; thumbnail?: string }>()

// Normalize items from metadata (if present)
    let normalizedItems: any[] = []

    if (hasNativeLikeItems) {
      normalizedItems = items!
        .map((item: any) => ({
          variant_id: item.variant_id,
          quantity: Number(item.quantity ?? 1),
          unit_price:
            item.unit_price !== undefined && Number.isFinite(Number(item.unit_price))
              ? Number(item.unit_price)
              : undefined,
          thumbnail_input: item.thumbnail,
          thumbnail: typeof item.thumbnail === "string" ? item.thumbnail : undefined,
          metadata: item.metadata,
        }))

      const invalidItem = normalizedItems.find((item: any) => {
        const hasInvalidQuantity = !item.variant_id || !Number.isFinite(item.quantity) || item.quantity <= 0
        const hasInvalidUnitPrice = item.unit_price !== undefined && item.unit_price < 0
        const hasInvalidThumbnail =
          item.thumbnail_input !== undefined && typeof item.thumbnail_input !== "string"
        return hasInvalidQuantity || hasInvalidUnitPrice || hasInvalidThumbnail
      })

      if (invalidItem) {
        throwInvalidData(
          "Each item must include variant_id, quantity > 0, optional unit_price >= 0, and optional thumbnail as string"
        )
      }

      for (const item of normalizedItems) {
        const existingOverride = inputOverridesByVariant.get(item.variant_id)

        if (
          existingOverride?.unit_price !== undefined &&
          item.unit_price !== undefined &&
          existingOverride.unit_price !== item.unit_price
        ) {
          throwInvalidData(`Conflicting unit_price for same variant_id: ${item.variant_id}`)
        }

        if (
          existingOverride?.thumbnail !== undefined &&
          item.thumbnail !== undefined &&
          existingOverride.thumbnail !== item.thumbnail
        ) {
          throwInvalidData(`Conflicting thumbnail for same variant_id: ${item.variant_id}`)
        }

        inputOverridesByVariant.set(item.variant_id, {
          unit_price: item.unit_price ?? existingOverride?.unit_price,
          thumbnail: item.thumbnail ?? existingOverride?.thumbnail,
        })
      }
    }

    // --- Resolve booking id, date, passengers, and entity from items or input ---
    let resolvedId = ensuresId
    let resolvedDate = ensuresDate

    if (hasNativeLikeItems) {
      // Reuse linkedVariants fetched in Phase 1 (already in parallel with retrieveCart).
      const variantByVariantId = new Map<string, { bookingId: string; passenger_type: PassengerType }>()
      for (const v of linkedVariants as any[]) {
        variantByVariantId.set(v.variant_id, {
          bookingId: type === "tour" ? v.tour_id : v.package_id,
          passenger_type: v.passenger_type,
        })
      }

      const missingVariantIds = uniqueVariantIds.filter((vid: string) => !variantByVariantId.has(vid))
      if (missingVariantIds.length > 0) {
        throwInvalidData(`Some variants are not linked to any ${type}: ${missingVariantIds.join(", ")}`)
      }

      const derivedIds = [...new Set(uniqueVariantIds.map((vid: string) => variantByVariantId.get(vid)!.bookingId))]
      if (derivedIds.length !== 1) {
        throwInvalidData(`All items must belong to the same ${type}`)
      }

      const derivedId = derivedIds[0]
      if (resolvedId && resolvedId !== derivedId) {
        throwInvalidData(`${META[type].idKey} does not match the provided variants`)
      }
      resolvedId = derivedId

      // Derive date from item metadata if not explicitly provided
      const itemDates = normalizedItems
        .map((item: any) => {
          const value = item.metadata?.[META[type].dateKey]
          return typeof value === "string" ? value : undefined
        })
        .filter((value: any): value is string => Boolean(value))

      if (!resolvedDate && itemDates.length > 0) {
        resolvedDate = itemDates[0]
      }
      if (!resolvedDate) {
        throwInvalidData(`Missing required field: ${META[type].dateKey}`)
      }
      if (itemDates.some((d: string) => d !== resolvedDate)) {
        throwInvalidData(`All items metadata.${META[type].dateKey} must match the requested ${META[type].dateKey}`)
      }

      // Derive customer from metadata if not provided
      if (!customer) {
        const customerMetadata = normalizedItems
          .map((item: any) => item.metadata || {})
          .find((meta: any) =>
            typeof meta.customer_name === "string" ||
            typeof meta.customer_email === "string" ||
            typeof meta.customer_phone === "string" ||
            typeof meta.formId === "number"
          )
        if (customerMetadata) {
          customer = {
            name: (customerMetadata.customer_name as string) || "",
            email: typeof customerMetadata.customer_email === "string" ? (customerMetadata.customer_email as string) : undefined,
            phone: typeof customerMetadata.customer_phone === "string" ? (customerMetadata.customer_phone as string) : undefined,
            formId: customerMetadata.formId,
          }
        }
      }

      // Recalculate passenger counts from variant passenger_types
      adults = 0
      children = 0
      infants = 0
      for (const item of normalizedItems) {
        const linked = variantByVariantId.get(item.variant_id)!
        if (linked.passenger_type === PassengerType.ADULT) {
          adults += item.quantity
        } else if (linked.passenger_type === PassengerType.CHILD) {
          children += item.quantity
        } else if (linked.passenger_type === PassengerType.INFANT) {
          infants += item.quantity
        }
      }
    } else {
      if (!resolvedId || !resolvedDate) {
        throwInvalidData(`Missing required fields: ${META[type].idKey}, ${META[type].dateKey}`)
      }
    }

    const totalPassengers = adults + children + infants
    if (totalPassengers === 0) {
      throwInvalidData("At least one passenger is required")
    }

    const ensuredId = resolvedId as string
    const ensuredDate = resolvedDate as string

    // Resolve the booking entity. Prefer earlyEntity (fetched in Phase 1 with variants).
    // Otherwise fetch it now. When we have linkedVariants (items path), fetch WITHOUT
    // relations — variantMap is built from linkedVariants, saving 1 DB query. When we
    // don't (no-items path), fetch WITH relations so entity.variants populates variantMap.
    if (!entity) {
      const needRelations = !(linkedVariants as any[])?.length
      entity = earlyEntity ?? (moduleService
        ? type === "tour"
          ? await (moduleService as TourModuleService).retrieveTourCached(ensuredId, needRelations ? { relations: ["variants"] } : {})
          : await (moduleService as PackageModuleService).retrievePackageCached(ensuredId, needRelations ? { relations: ["variants"] } : {})
        : null)
    }

    // Map variants by passenger type and collect needed variant IDs.
    // Prefer entity.variants (full records); fall back to linkedVariants from Phase 1
    // (both have variant_id + passenger_type, so variantMap can be built from either).
    const variantSource = (entity?.variants && entity.variants.length > 0) ? entity.variants : (linkedVariants as any[])
    const variantMap = new Map<PassengerType, any>()
    const variantIdsNeeded: string[] = []
    for (const variant of variantSource || []) {
      if (variant.variant_id) {
        variantMap.set(variant.passenger_type, variant)
      }
    }

    const adultVariant = variantMap.get(PassengerType.ADULT)
    const childVariant = variantMap.get(PassengerType.CHILD)
    const infantVariant = variantMap.get(PassengerType.INFANT)

    if (adults > 0) {
      if (!adultVariant?.variant_id) {
        throwInvalidData("Adult variant not found")
      }
      variantIdsNeeded.push(adultVariant.variant_id)
    }
    if (children > 0) {
      if (!childVariant?.variant_id) {
        throwInvalidData("Child variant not found")
      }
      variantIdsNeeded.push(childVariant.variant_id)
    }
    if (infants > 0) {
      if (!infantVariant?.variant_id) {
        throwInvalidData("Infant variant not found")
      }
      variantIdsNeeded.push(infantVariant.variant_id)
    }

    // Build pricing context from request context + cart
    const pricingContext = {
      ...((input as any).pricing_context || {}),
      currency_code: (cart.currency_code || "usd").toLowerCase(),
      region_id: cart.region_id,
    }

    const priceMap = new Map<string, number>()

    // Seed price map from item overrides
    if (hasNativeLikeItems) {
      for (const [variantId, override] of inputOverridesByVariant.entries()) {
        if (override.unit_price !== undefined) {
          priceMap.set(variantId, override.unit_price)
        }
      }
    }

    // PHASE 3: Run validateBooking and calculatePrices IN PARALLEL.
    // Both only depend on data available now (entity for validateBooking;
    // variantIdsNeeded + pricingContext for calculatePrices).
    const [validationResult, calculatedPrices] = await Promise.all([
      moduleService
        ? (moduleService as any).validateBooking(
            ensuredId,
            new Date(ensuredDate),
            totalPassengers,
            entity
          )
        : Promise.resolve({ valid: true }),
      (async () => {
        try {
          return await pricingModule.calculatePrices(
            { id: variantIdsNeeded },
            { context: pricingContext }
          )
        } catch (pricingError) {
          console.warn("Could not pre-calculate variant prices for metadata", pricingError)
          return [] as any[]
        }
      })(),
    ])

    if (!validationResult.valid) {
      throwInvalidData(validationResult.reason || `${type} not available`)
    }

    for (const cp of (calculatedPrices as any[]) || []) {
      const amount = Number(cp.calculated_amount)
      if (Number.isFinite(amount) && amount >= 0) {
        priceMap.set(cp.id, amount)
      }
    }

    const unresolvedVariantIds = variantIdsNeeded.filter((vid: string) => !priceMap.has(vid))

    if (unresolvedVariantIds.length > 0) {
      const [priceSetResult, calculatedPriceResult] = await Promise.all([
        query.graph({
          entity: "product_variant",
          fields: ["id", "price_set.prices.*"],
          filters: {
            id: unresolvedVariantIds,
          },
        }).catch(() => ({ data: [] })),
        query.graph({
          entity: "product_variant",
          fields: ["id", "calculated_price.*"],
          filters: {
            id: unresolvedVariantIds,
          },
          context: {
            calculated_price: QueryContext({
              currency_code: pricingContext.currency_code,
              region_id: pricingContext.region_id,
            }),
          },
        }).catch(() => ({ data: [] })),
      ])

      for (const variantData of priceSetResult.data || []) {
        const prices = variantData?.price_set?.prices || []
        const matchingPrice = prices.find(
          (price: any) => price?.currency_code?.toLowerCase() === pricingContext.currency_code
        )

        if (!matchingPrice) {
          continue
        }

        const amount = Number(matchingPrice.amount)
        if (Number.isFinite(amount) && amount >= 0) {
          priceMap.set(variantData.id, amount)
        }
      }

      for (const variantData of calculatedPriceResult.data || []) {
        const variantAny = variantData as any
        const amount = Number(variantAny?.calculated_price?.calculated_amount)
        if (Number.isFinite(amount) && amount >= 0) {
          priceMap.set(variantAny.id, amount)
        }
      }
    }

    const missingPriceVariantIds = variantIdsNeeded.filter((vid: string) => !priceMap.has(vid))

    if (missingPriceVariantIds.length > 0) {
      throwInvalidData(
        `Missing variant prices for cart currency ${pricingContext.currency_code}: ${missingPriceVariantIds.join(", ")}`
      )
    }

    // BUILD: Add cart_id to items, group breakdown, create items
    const groupId = generateEntityId(undefined, type === "tour" ? "tour" : "pkg")

    const getUnitPrice = (variantId: string): number => {
      const resolved = priceMap.get(variantId)
      if (resolved === undefined) {
        throw new Error(`Missing price for variant ${variantId}`)
      }
      return resolved
    }

    const variantBreakdown: PassengerBreakdown[] = []

    if (adults > 0 && adultVariant) {
      const unitPrice = getUnitPrice(adultVariant.variant_id)
      variantBreakdown.push({
        type: "ADULT",
        variant_id: adultVariant.variant_id,
        quantity: adults,
        unit_price: unitPrice,
        line_total: unitPrice * adults,
      })
    }

    if (children > 0 && childVariant) {
      const unitPrice = getUnitPrice(childVariant.variant_id)
      variantBreakdown.push({
        type: "CHILD",
        variant_id: childVariant.variant_id,
        quantity: children,
        unit_price: unitPrice,
        line_total: unitPrice * children,
      })
    }

    if (infants > 0 && infantVariant) {
      const unitPrice = getUnitPrice(infantVariant.variant_id)
      variantBreakdown.push({
        type: "INFANT",
        variant_id: infantVariant.variant_id,
        quantity: infants,
        unit_price: unitPrice,
        line_total: unitPrice * infants,
      })
    }

    const pricingBreakdown: PricingBreakdown[] = variantBreakdown.map((entry) => ({
      type: entry.type,
      quantity: entry.quantity,
      unit_price: entry.unit_price,
    }))

    let totalPrice = variantBreakdown.reduce((sum, entry) => sum + entry.line_total, 0)

    // Create items with cart_id added (required by createLineItemsStep)
    const itemsToAdd = variantBreakdown.map((entry) => {
      const passengers = {
        adults: entry.type === "ADULT" ? entry.quantity : 0,
        children: entry.type === "CHILD" ? entry.quantity : 0,
        infants: entry.type === "INFANT" ? entry.quantity : 0,
      }

      return {
        cart_id: ensuresCartId,
        variant_id: entry.variant_id,
        quantity: entry.quantity,
        requires_shipping: false,
        unit_price: entry.unit_price,
        thumbnail: inputOverridesByVariant.get(entry.variant_id)?.thumbnail || entity?.thumbnail || undefined,
        title: `${entity?.destination} (${entry.type})`,
        metadata: {
          [META[type].flag]: true,
          [META[type].idKey]: entity?.id,
          [META[type].dateKey]: ensuredDate,
          [META[type].destKey]: entity?.destination,
          [META[type].durKey]: entity?.duration_days,
          passenger_type: entry.type,
          total_passengers: adults + children + infants,
          line_passengers: entry.quantity,
          passengers,
          group_id: groupId,
          customer_name: customer?.name,
          customer_email: customer?.email,
          customer_phone: customer?.phone,
          formId: customer?.formId,
        },
      }
    })

    if (itemsToAdd.length === 0) {
      throwInvalidData("No passenger variants found to add")
    }

    const trackingItems: TrackingItem[] = variantBreakdown.map((entry) => ({
      contentId: entry.variant_id,
      contentType: type,
      contentCategory: type,
      contentName: entity?.destination,
      quantity: entry.quantity,
      price: entry.unit_price,
    }))

    return new StepResponse({
      line_items: itemsToAdd.map((item) => ({ ...item })),
      total_price: totalPrice,
      currency_code: pricingContext.currency_code,
      group_id: groupId,
      tracking_items: trackingItems,
      adults,
      children,
      infants,
      total_passengers: adults + children + infants,
      destination: entity?.destination,
      entity_id: entity?.id,
      entity_date: ensuredDate,
    })
  }
)

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/**
 * Adds tour or package booking items to a cart.
 *
 * Replaces both /api/store/cart/tour-items and /api/store/cart/package-items.
 *
 * @param input - Booking request with cart_id, type ("tour"|"package"), booking details, and optional items
 */
export const addBookingToCartWorkflow = createWorkflow(
  {
    name: "add-booking-to-cart",
    idempotent: false,
  },
  function (input: any & { cart: any }) {
    // Use the prepared cart (from conditional fetch) or just the cart object
    const cart = input.cart

    // ==================== Acquire lock ====================
    acquireLockStep({
      key: input.cart_id,
      timeout: 2,
      ttl: 10,
    })

    // ==================== Prepare booking ====================
    const prepared = prepareBookingStep(input)

// ==================== Create line items ====================
     createLineItemsStep({
       id: input.cart_id,
       items: prepared.line_items as any,
     })

    // Invalidate cart cache so GET /store/carts/:id returns fresh data
    invalidateCartCacheStep({ cart_id: input.cart_id })

    // ==================== Conditional cart fetch (two-phase) ====================
    const cartFetched = conditionalCartFetchStep({ cart_id: input.cart_id }).config({ name: "booking-cart-fetch" })

    // ==================== Shipping refresh (when cart has shipping methods) ====================
    when("booking-refresh-shipping", { cart: cartFetched }, ({ cart }) => {
      return !!cart.shipping_methods?.length || false
    }).then(() => {
      refreshCartShippingMethodsWorkflow.runAsStep({
        input: {
          cart: cartFetched,
          additional_data: {},
        },
      })
    })

    // ==================== Promotions refresh (when cart has promotions) ====================
    when("booking-refresh-promotions", { cart: cartFetched }, ({ cart }) => {
      return !!cart.promotions?.length || false
    }).then(() => {
      const promoCodes = transform({ cart: cartFetched }, ({ cart }) => {
        return (cart?.promotions ?? []).map((p: any) => p?.code).filter(Boolean)
      })

      updateCartPromotionsWorkflow.runAsStep({
        input: {
          cart: cartFetched,
          promo_codes: promoCodes,
          action: PromotionActions.REPLACE,
          force_refresh_payment_collection: false,
        },
      })
    })

    // ==================== Payment collection refresh (when cart has payment) ====================
    when("booking-refresh-payment", { cart: cartFetched }, ({ cart }) => {
      return !!cart.payment_collection || false
    }).then(() => {
      refreshPaymentCollectionForCartWorkflow.runAsStep({
        input: { cart: cartFetched },
      })
    })

    // ==================== Emit event ====================
    emitEventStep({
      eventName: CartWorkflowEvents.UPDATED,
      data: { id: input.cart_id },
    })

    // ==================== Release lock ====================
    releaseLockStep({
      key: input.cart_id,
    })

    // ==================== Return response ====================
    const summary = transform({ prepared, type: input.type },
      (data) => {
        const lineItems = (data.prepared as any)?.line_items || []
        const preparedData = data.prepared as any
        return {
          [data.type === "tour" ? "tour_id" : "package_id"]: lineItems[0]?.metadata?.[META[data.type].idKey] || "",
          destination: lineItems[0]?.metadata?.[META[data.type].destKey] || "",
          [data.type === "tour" ? "tour_date" : "package_date"]: lineItems[0]?.metadata?.[META[data.type].dateKey] || "",
          adults: preparedData.adults ?? 0,
          children: preparedData.children ?? 0,
          infants: preparedData.infants ?? 0,
          total_passengers: preparedData.total_passengers ?? 0,
        }
      }
    )

    return new WorkflowResponse({
      cart: cartFetched,
      summary,
      group_id: prepared.group_id,
      total_price: prepared.total_price,
      currency_code: prepared.currency_code,
      tracking_items: prepared.tracking_items,
    })
  }
)

export default addBookingToCartWorkflow
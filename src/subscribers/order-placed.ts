import type { SubscriberArgs, SubscriberConfig } from "@medusajs/medusa"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { TOUR_MODULE } from "../modules/tour"
import { BOOKING_FORM_MODULE } from "../modules/booking-form"
import type TourModuleService from "../modules/tour/service"
import { findExistingBooking } from "../utils/booking-idempotency"
import { getBookingStatusFromPaymentStatus } from "../utils/booking-payment-status"
import { resend } from "../utils/email"
import { getOrderNotificationEmails } from "../utils/order-notification-emails"
import { trackCommerceEvent, type TrackingItem } from "../utils/conversion-tracking"
import { EVENTS_MODULE } from "../modules/events"
import type EventModuleService from "../modules/events/service"

type TravelBookingNotificationEmailFn =
  typeof import("../emails/travel-booking-notification.js").TravelBookingNotificationEmail

type AdminBookingNotificationEmailFn =
  typeof import("../emails/admin-booking-notification.js").AdminBookingNotificationEmail

let travelBookingNotificationEmail:
  | TravelBookingNotificationEmailFn
  | null = null

let adminBookingNotificationEmail:
  | AdminBookingNotificationEmailFn
  | null = null

const isTestRuntime = process.env.NODE_ENV === "test" || !!process.env.TEST_TYPE

async function getTravelBookingNotificationEmail(): Promise<TravelBookingNotificationEmailFn> {
  if (travelBookingNotificationEmail) {
    return travelBookingNotificationEmail
  }

  if (isTestRuntime) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("../emails/travel-booking-notification.tsx") as {
      TravelBookingNotificationEmail: TravelBookingNotificationEmailFn
    }
    travelBookingNotificationEmail = module.TravelBookingNotificationEmail
    return module.TravelBookingNotificationEmail
  }

  const module = await import("../emails/travel-booking-notification.js")
  travelBookingNotificationEmail = module.TravelBookingNotificationEmail
  return module.TravelBookingNotificationEmail
}

async function getAdminBookingNotificationEmail(): Promise<AdminBookingNotificationEmailFn> {
  if (adminBookingNotificationEmail) {
    return adminBookingNotificationEmail
  }

  if (isTestRuntime) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("../emails/admin-booking-notification.tsx") as {
      AdminBookingNotificationEmail: AdminBookingNotificationEmailFn
    }
    adminBookingNotificationEmail = module.AdminBookingNotificationEmail
    return module.AdminBookingNotificationEmail
  }

  const module = await import("../emails/admin-booking-notification.js")
  adminBookingNotificationEmail = module.AdminBookingNotificationEmail
  return module.AdminBookingNotificationEmail
}

export default async function handleOrderPlaced({
  event,
  container,
}: SubscriberArgs<{ id: string }>) {
  const orderId = event.data.id

  try {
    const existingBookings = await findExistingBooking(orderId, container)
    const hasExistingBookings = existingBookings.length > 0

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: [order] } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "display_id",
        "email",
        "metadata",
        "payment_status",
        "currency_code",
        "total",
        "items.*",
        "customer.first_name",
        "customer.last_name",
        "customer.email",
      ],
      filters: { id: orderId },
    })

    if (!order) {
      return
    }

    const bookableItems = (order.items || []).filter(
      (item: any) => item.metadata?.is_tour === true || item.metadata?.is_package === true
    )

    if (bookableItems.length > 0) {
      const trackingItems = bookableItems.reduce<TrackingItem[]>((acc, item: any) => {
        const contentId =
          typeof item.variant_id === "string"
            ? item.variant_id
            : typeof item.id === "string"
              ? item.id
              : undefined

        if (!contentId) {
          return acc
        }

        const rawQuantity = Number(item.quantity)
        const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1
        const rawUnitPrice = Number(item.unit_price)
        const unitPrice = Number.isFinite(rawUnitPrice)
          ? rawUnitPrice
          : Number(item.total) / quantity
        const contentType = item.metadata?.is_tour === true
          ? "tour"
          : item.metadata?.is_package === true
            ? "package"
            : "product"

        acc.push({
          contentId,
          contentType,
          contentCategory: contentType,
          contentName: typeof item.title === "string" ? item.title : undefined,
          quantity,
          ...(Number.isFinite(unitPrice) ? { price: unitPrice } : {}),
        })

        return acc
      }, [])

      await trackCommerceEvent({
        eventName: "Purchase",
        eventId: `purchase:${orderId}`,
        trigger: "subscriber.order.placed",
        currency: typeof order.currency_code === "string" ? order.currency_code : undefined,
        value: Number(order.total),
        orderId: String(order.display_id || order.id || orderId),
        items: trackingItems,
        user: {
          email:
            typeof order.email === "string"
              ? order.email
              : typeof order.customer?.email === "string"
                ? order.customer.email
                : undefined,
          firstName:
            typeof order.customer?.first_name === "string"
              ? order.customer.first_name
              : undefined,
          lastName:
            typeof order.customer?.last_name === "string"
              ? order.customer.last_name
              : undefined,
        },
      })
    }

    const tourItems = (order.items || []).filter(
      (item: any) => item.metadata?.is_tour === true
    )

    if (tourItems.length === 0) {
      return
    }

    const tourModuleService = container.resolve(
      TOUR_MODULE
    ) as TourModuleService

    const bookingFormModuleService = container.resolve(
      BOOKING_FORM_MODULE
    ) as unknown as any

    const orderPreDataRaw =
      order?.metadata && typeof order.metadata === "object"
        ? (order.metadata as Record<string, any>).preData
        : undefined
    const orderPreData = orderPreDataRaw == null ? undefined : orderPreDataRaw
    const orderPaymentStatus =
      (order as { payment_status?: unknown }).payment_status
    const bookingStatus = getBookingStatusFromPaymentStatus(orderPaymentStatus)

    let createdBookings: any[] = existingBookings

    if (hasExistingBookings) {
    } else {
      // Collect unique group_ids from tour items to fetch related booking forms
      const groupIds = [
        ...new Set(
          tourItems
            .map((i: any) => i.metadata?.group_id)
            .filter((g: any) => typeof g === "string")
        ),
      ]

      const formByGroup = new Map<string, any>()
      if (groupIds.length > 0) {
        const forms = await bookingFormModuleService.listBookingForms({
          group_id: groupIds,
        })
        ;(forms as any[]).forEach((f: any) => {
          if (f.group_id && !formByGroup.has(f.group_id)) {
            formByGroup.set(f.group_id, f)
          }
        })
      }

      const bookingsToCreate = tourItems.map((item: any) => {
        const bookingMetadata: Record<string, any> = {}

        if (typeof item.metadata?.group_id === "string") {
          bookingMetadata.group_id = item.metadata.group_id
        }

        const form = item.metadata?.group_id
          ? formByGroup.get(item.metadata.group_id)
          : undefined
        const formPreData = form?.pre_data
        const effectivePreData = formPreData != null ? formPreData : orderPreData
        if (effectivePreData !== undefined) {
          bookingMetadata.preData = structuredClone(effectivePreData)
        }

        const passengers = item.metadata?.passengers || {}
        const reservedPassengers = (Number(passengers.adults) || 0) + (Number(passengers.children) || 0)

        return {
          order_id: orderId,
          tour_id: item.metadata.tour_id,
          tour_date: new Date(item.metadata.tour_date),
          status: bookingStatus,
          metadata: Object.keys(bookingMetadata).length > 0 ? bookingMetadata : undefined,
          line_items: {
            item_id: item.id,
            variant_id: item.variant_id,
            title: item.title,
            quantity: item.quantity,
            passengers: item.metadata.passengers || [],
          },
          reserved_passengers: reservedPassengers,
        }
      })

      const createdBookingsRaw =
        await tourModuleService.createTourBookings(bookingsToCreate)
      // createdBookingsRaw might be a single object or an array depending on implementation
      createdBookings = Array.isArray(createdBookingsRaw)
        ? createdBookingsRaw
        : [createdBookingsRaw]

      // Mark consumed booking forms (use the form RECORD ids, not group_ids)
      try {
        const usedForms = [...formByGroup.values()].filter((form) =>
          tourItems.some(
            (item: any) => item.metadata?.group_id === form.group_id
          )
        )
        if (usedForms.length > 0) {
          await bookingFormModuleService.updateBookingForms(
            usedForms.map((form) => ({ id: form.id, status: "consumed" }))
          )
        }
      } catch (updateError) {
        // Best-effort: failure to update booking form status should not break booking creation
      }
    }

    try {
      const eventModuleService = container.resolve(EVENTS_MODULE) as EventModuleService

      await eventModuleService.publishEvent({
        type: "integration",
        aggregateType: "order",
        action: "placed",
        version: 1,
        payload: {
          id: order.id,
          status: String((order as { payment_status?: unknown }).payment_status ?? "pending"),
          email: order.email ?? order.customer?.email ?? "",
          displayId: Number(order.display_id ?? 0),
          currencyCode: String(order.currency_code ?? "USD"),
          total: Number(order.total ?? 0),
          items: (order.items || []).map((item: any) => ({
            id: item.id,
            title: item.title,
            quantity: item.quantity,
            unit_price: item.unit_price,
            metadata: item.metadata,
          })),
          metadata: order.metadata ?? null,
        },
        causationId: `medusa:order.placed:${orderId}`,
      })

      for (const booking of createdBookings) {
        await eventModuleService.publishEvent({
          type: "notification",
          aggregateType: "booking",
          action: "confirmation",
          version: 1,
          payload: {
            id: booking.id,
            orderId: orderId,
            entityId: booking.tour_id ?? "",
            entityType: "tour" as const,
            tourDate: booking.tour_date ? new Date(booking.tour_date).toISOString() : undefined,
            lineItems: booking.line_items ?? null,
            status: booking.status ?? "pending",
            metadata: booking.metadata ?? null,
          },
          causationId: `medusa:order.placed:${orderId}`,
        })
      }
    } catch (edaError) {
    }

    const notificationRecipients = await getOrderNotificationEmails(container)

    if (notificationRecipients.length === 0) {
    }

    const customerEmailRaw =
      (typeof order.email === "string" && order.email) ||
      (typeof order.customer?.email === "string" && order.customer.email) ||
      null
    const customerEmail =
      typeof customerEmailRaw === "string" && customerEmailRaw.trim().length > 0
        ? customerEmailRaw.trim()
        : null

    const customerFirstName =
      typeof order.customer?.first_name === "string"
        ? order.customer.first_name.trim()
        : ""
    const customerLastName =
      typeof order.customer?.last_name === "string"
        ? order.customer.last_name.trim()
        : ""
    const customerName =
      [customerFirstName, customerLastName].filter(Boolean).join(" ") || "Viajero"

    if (!customerEmail) {
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || "bookings@yourdomain.com"

    const customerBookableItems = (order.items || []).filter(
      (item: any) => item.metadata?.is_tour === true || item.metadata?.is_package === true
    )
    const hasPackageItemsForCustomer = customerBookableItems.some(
      (item: any) => item.metadata?.is_package === true
    )
    const customerReservationType: "Tour" | "Package" | "Mixed" = hasPackageItemsForCustomer
      ? "Mixed"
      : "Tour"

    const customerCartItems = customerBookableItems.map((item: any) => {
      const rawQuantity = Number(item.quantity)
      const quantity = Number.isFinite(rawQuantity) ? Math.max(0, rawQuantity) : 0

      const rawTotal = [item.total, item.subtotal, item.unit_price]
        .map((value) => Number(value))
        .find((value) => Number.isFinite(value))

      const destinationRaw =
        item.metadata?.tour_destination ?? item.metadata?.package_destination ?? item.title
      const destination = typeof destinationRaw === "string" ? destinationRaw : null

      return {
        groupId: typeof item.metadata?.group_id === "string" ? item.metadata.group_id : null,
        metadata: {
          group_id: typeof item.metadata?.group_id === "string" ? item.metadata.group_id : null,
          passengers: item.metadata?.passengers ?? null,
        },
        name: destination,
        date: item.metadata?.tour_date ?? item.metadata?.package_date ?? null,
        quantity,
        total: rawTotal ?? 0,
        imageUrl: typeof item.thumbnail === "string" ? item.thumbnail : null,
        passengers: item.metadata?.passengers ?? null,
      }
    })

    const customerPassengers = customerBookableItems.flatMap((item: any) =>
      Array.isArray(item.metadata?.passengers) ? item.metadata.passengers : []
    )
    const bookingReference =
      createdBookings
        .map((booking: any) => String(booking?.id || ""))
        .filter((bookingId: string) => bookingId.length > 0)
        .join(", ") || "N/A"

    if (resend && customerEmail) {
      try {
        const customerSubject = hasPackageItemsForCustomer
          ? "Nueva reserva de viaje"
          : "Nueva reserva de tour"
        const TravelBookingNotificationEmail =
          await getTravelBookingNotificationEmail()
        const customerRes = await resend.emails.send({
          from: fromEmail,
          to: [customerEmail],
          subject: customerSubject,
          react: TravelBookingNotificationEmail({
            reservationType: customerReservationType,
            orderId: String(orderId),
            bookingId: bookingReference,
            recipientName: customerName,
            destination:
              typeof customerCartItems[0]?.name === "string" ? customerCartItems[0].name : null,
            imageUrl:
              typeof customerCartItems[0]?.imageUrl === "string"
                ? customerCartItems[0].imageUrl
                : null,
            travelDate: customerCartItems[0]?.date,
            price: typeof customerCartItems[0]?.total === "number" ? customerCartItems[0].total : null,
            currencyCode: typeof order.currency_code === "string" ? order.currency_code : null,
            cartItems: customerCartItems,
            passengers: customerPassengers,
          }),
          tags: [
            { name: "category", value: "tour_booking" },
            { name: "audience", value: "customer" },
            { name: "order_id", value: String(orderId) },
          ],
          headers: {
            "Idempotency-Key": `tour-booking-customer-${orderId}`,
          },
        })

        if (customerRes?.error) {
        } else {
        }
      } catch (customerSendError) {
      }
    }

    if (resend && notificationRecipients.length > 0) {
      try {
        const opsSubject = hasPackageItemsForCustomer
          ? "Nueva reserva de viaje"
          : "Nueva reserva de tour"

        const AdminBookingNotificationEmail = await getAdminBookingNotificationEmail()
        const opsRes = await resend.emails.send({
          from: fromEmail,
          to: notificationRecipients,
          subject: opsSubject,
          react: AdminBookingNotificationEmail({
            reservationType: customerReservationType,
            orderId: String(orderId),
            bookingId: bookingReference,
            customerName: customerName,
            customerEmail: customerEmail,
            destination: typeof customerCartItems[0]?.name === "string" ? customerCartItems[0].name : null,
            imageUrl: typeof customerCartItems[0]?.imageUrl === "string" ? customerCartItems[0].imageUrl : null,
            travelDate: customerCartItems[0]?.date,
            price: typeof customerCartItems[0]?.total === "number" ? customerCartItems[0].total : null,
            currencyCode: typeof order.currency_code === "string" ? order.currency_code : null,
            cartItems: customerCartItems,
            passengers: customerPassengers,
          }),
          tags: [
            { name: "category", value: "tour_booking" },
            { name: "audience", value: "ops" },
            { name: "order_id", value: String(orderId) },
          ],
          headers: {
            "Idempotency-Key": `tour-booking-ops-${orderId}`,
          },
        })

        if (opsRes?.error) {
        } else {
        }
      } catch (opsSendError) {
      }
    } else if (!resend) {
    }
  } catch (error) {
    console.error(
      `[order.placed] Failed to create tour bookings for order ${orderId}:`,
      error
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
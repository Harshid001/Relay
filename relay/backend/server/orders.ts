/**
 * Relay Store mock order catalogue.
 *
 * A tiny, purely in-memory stand-in for a real order system so the assistant
 * can demonstrate one tool call ("look up an order by number") with stable,
 * personalized data. Nothing here touches the network or the database, and no
 * real customer data exists: every order, carrier and tracking number below is
 * fictional.
 */

export interface MockOrder {
  orderId: string;
  status: 'processing' | 'in_transit' | 'out_for_delivery' | 'delivered';
  carrier: string;
  trackingNumber: string;
  eta: string;
  lastUpdate: string;
  items: string;
}

export const MOCK_ORDERS: MockOrder[] = [];

export function findOrderById(orderId: string): MockOrder | undefined {
  return MOCK_ORDERS.find((order) => order.orderId === orderId);
}

/** Pulls an order number out of free text: "#4471", "order 4471", or a bare 4-6 digit number. */
export function extractOrderNumber(text: string): string | null {
  const match = /#(\d{3,6})\b|\b(\d{4,6})\b/.exec(String(text ?? ''));
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/** One-sentence live status, used to enrich live replies. */
export function orderStatusSentence(order: MockOrder): string {
  switch (order.status) {
    case 'processing':
      return `Live status for order ${order.orderId}: it ${order.lastUpdate} and should ship ${order.eta}. No tracking number yet.`;
    case 'in_transit':
      return `Live status for order ${order.orderId}: it ${order.lastUpdate} and is expected ${order.eta}. Carrier ${order.carrier}, tracking ${order.trackingNumber}.`;
    case 'out_for_delivery':
      return `Live status for order ${order.orderId}: it ${order.lastUpdate} and should arrive ${order.eta}. Carrier ${order.carrier}, tracking ${order.trackingNumber}.`;
    case 'delivered':
      return `Live status for order ${order.orderId}: it ${order.lastUpdate}. Carrier ${order.carrier}, tracking ${order.trackingNumber}. If it has not turned up, check with neighbours first — a human agent can start a carrier trace if it is still missing.`;
  }
}

/** Full customer-facing reply. */
export function orderLookupReply(order: MockOrder): string {
  const intro: Record<MockOrder['status'], string> = {
    processing: `Good news — I found your order. Order ${order.orderId} (${order.items}) ${order.lastUpdate}.`,
    in_transit: `Good news — I found your order. Order ${order.orderId} (${order.items}) ${order.lastUpdate}.`,
    out_for_delivery: `Good news — I found your order. Order ${order.orderId} (${order.items}) ${order.lastUpdate}.`,
    delivered: `Good news — I found your order. Order ${order.orderId} (${order.items}) ${order.lastUpdate}.`,
  };

  const detail: Record<MockOrder['status'], string> = {
    processing: `It should ship ${order.eta}.`,
    in_transit: `It is expected ${order.eta}. Carrier: ${order.carrier}, tracking number ${order.trackingNumber}.`,
    out_for_delivery: `It should arrive ${order.eta}. Carrier: ${order.carrier}, tracking number ${order.trackingNumber}.`,
    delivered: `If the parcel is not where you expected it, check with neighbours and your building office first.`,
  };

  return `${intro[order.status]} ${detail[order.status]} Anything else you want me to check on this order?`;
}

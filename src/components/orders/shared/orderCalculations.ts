import { CartItem, CompanySettings } from '../../../types';

// Fallback delivery charge constants if settings/general does not specify Dhaka zone rates
export const DELIVERY_CHARGE_INSIDE_DHAKA = 70;
export const DELIVERY_CHARGE_OUTSIDE_DHAKA = 120;

export interface CartCustomerDetails {
  name: string;
  mobile: string;
  altMobile: string;
  divisionId: string;
  divisionName: string;
  districtId: string;
  districtName: string;
  upazilaId: string;
  upazilaName: string;
  address: string;
  courierNote: string;
}

export const EMPTY_CUSTOMER_DETAILS: CartCustomerDetails = {
  name: '',
  mobile: '',
  altMobile: '',
  divisionId: '',
  divisionName: '',
  districtId: '',
  districtName: '',
  upazilaId: '',
  upazilaName: '',
  address: '',
  courierNote: '',
};

export interface OrderSuccessData {
  primaryOrderNumber: string;
  orderNumbers: string[];
  totalProducts: number;
  totalPieces: number;
  customerName: string;
  customerPayable: number;
  codAmount: number;
  estimatedProfit: number;
}

export interface SavedCustomerProfile {
  id: string;
  name: string;
  mobile: string;
  altMobile: string;
  divisionId: string;
  divisionName: string;
  districtId: string;
  districtName: string;
  upazilaId: string;
  upazilaName: string;
  address: string;
  courierNote: string;
  source: 'saved' | 'recent';
  lastOrderedAtMs?: number;
}

export const BD_PHONE_REGEX = /^(?:\+?88)?01[3-9]\d{8}$/;

export function normalizeBdPhone(val: string): string {
  return val.replace(/[\s-]/g, '').trim();
}

export function normalizeBdPhoneKey(val: string): string {
  const digits = val.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length >= 13) {
    return digits.slice(2);
  }
  return digits;
}

export function isValidBdPhone(val: string): boolean {
  return BD_PHONE_REGEX.test(normalizeBdPhone(val));
}

export function getItemCost(item: CartItem): number {
  const vAdj = item.variant ? item.variant.priceAdjustment || 0 : 0;
  return (item.product.resellerPrice || 0) + vAdj;
}

export function getItemSuggestedPrice(item: CartItem): number {
  const vAdj = item.variant ? item.variant.priceAdjustment || 0 : 0;
  const cost = getItemCost(item);
  return Math.max(cost, (item.product.retailPrice || 0) + vAdj);
}

export function getItemStockLimit(item: CartItem): number {
  return item.variant ? item.variant.stock || 0 : item.product.stock || 0;
}

export interface OrderTotalsSummary {
  productCount: number;
  pieceCount: number;
  totalWholesaleCost: number;
  totalSellingSubtotal: number;
  totalEstimatedProfit: number;
  isInsideDhaka: boolean;
  deliveryCharge: number;
  customerPaysTotal: number;
  clampedAdvance: number;
  codPayableOnDelivery: number;
  hasInvalidPrices: boolean;
  hasInvalidStock: boolean;
}

export function computeOrderTotals(
  items: CartItem[],
  districtName: string,
  advanceDraft: string,
  companySettings: CompanySettings | null
): OrderTotalsSummary {
  const productCount = items.length;
  const pieceCount = items.reduce((acc, item) => acc + item.quantity, 0);

  const totalWholesaleCost = items.reduce(
    (acc, item) => acc + getItemCost(item) * item.quantity,
    0
  );

  const totalSellingSubtotal = items.reduce(
    (acc, item) => acc + item.sellingPrice * item.quantity,
    0
  );

  const totalEstimatedProfit = items.reduce(
    (acc, item) =>
      acc + (item.sellingPrice - getItemCost(item)) * item.quantity,
    0
  );

  const isInsideDhaka = districtName.trim().toLowerCase() === 'dhaka';
  const insideDhakaRate =
    typeof companySettings?.insideDhakaDeliveryCharge === 'number' &&
    companySettings.insideDhakaDeliveryCharge >= 0
      ? companySettings.insideDhakaDeliveryCharge
      : DELIVERY_CHARGE_INSIDE_DHAKA;
  const outsideDhakaRate =
    typeof companySettings?.outsideDhakaDeliveryCharge === 'number' &&
    companySettings.outsideDhakaDeliveryCharge >= 0
      ? companySettings.outsideDhakaDeliveryCharge
      : typeof companySettings?.defaultDeliveryCharge === 'number' &&
        companySettings.defaultDeliveryCharge > 0
      ? companySettings.defaultDeliveryCharge
      : DELIVERY_CHARGE_OUTSIDE_DHAKA;

  const deliveryCharge = isInsideDhaka ? insideDhakaRate : outsideDhakaRate;
  const customerPaysTotal = totalSellingSubtotal + deliveryCharge;
  const parsedAdvance = Math.max(0, parseFloat(advanceDraft) || 0);
  const clampedAdvance = Math.min(customerPaysTotal, parsedAdvance);
  const codPayableOnDelivery = Math.max(0, customerPaysTotal - clampedAdvance);

  const hasInvalidPrices = items.some(
    (item) => item.sellingPrice < getItemCost(item)
  );
  const hasInvalidStock = items.some((item) => {
    const limit = getItemStockLimit(item);
    return limit <= 0 || item.quantity > limit || item.quantity < 1;
  });

  return {
    productCount,
    pieceCount,
    totalWholesaleCost,
    totalSellingSubtotal,
    totalEstimatedProfit,
    isInsideDhaka,
    deliveryCharge,
    customerPaysTotal,
    clampedAdvance,
    codPayableOnDelivery,
    hasInvalidPrices,
    hasInvalidStock,
  };
}

export function validateCustomerDetailsMap(
  customer: CartCustomerDetails
): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!customer.name.trim()) {
    errs.name = 'Customer name is required.';
  }
  if (!isValidBdPhone(customer.mobile)) {
    errs.mobile = 'Enter a valid BD mobile (01[3-9]XXXXXXXX).';
  }
  if (customer.altMobile.trim() && !isValidBdPhone(customer.altMobile)) {
    errs.altMobile = 'Enter a valid alternate BD mobile (01[3-9]XXXXXXXX).';
  }
  if (!customer.divisionId || !customer.divisionName) {
    errs.division = 'Select a division.';
  }
  if (!customer.districtId || !customer.districtName) {
    errs.district = 'Select a district.';
  }
  if (!customer.upazilaId || !customer.upazilaName) {
    errs.upazila = 'Select an upazila / thana.';
  }
  if (customer.address.trim().length < 5) {
    errs.address = 'Enter full delivery address (min 5 characters).';
  }
  return errs;
}

export function buildCustomerQuoteText(params: {
  shopTitle: string;
  items: CartItem[];
  customer: CartCustomerDetails;
  isInsideDhaka: boolean;
  deliveryCharge: number;
  totalSellingSubtotal: number;
  customerPaysTotal: number;
  clampedAdvance: number;
  codPayableOnDelivery: number;
}): string {
  const {
    shopTitle,
    items,
    customer,
    isInsideDhaka,
    deliveryCharge,
    totalSellingSubtotal,
    customerPaysTotal,
    clampedAdvance,
    codPayableOnDelivery,
  } = params;

  const lines = items.map((item, i) => {
    const variantLabel = item.variant ? ` (${item.variant.colorName})` : '';
    const lineTotal = item.sellingPrice * item.quantity;
    return `${i + 1}. ${item.product.name}${variantLabel} — ${item.quantity} pc${
      item.quantity > 1 ? 's' : ''
    } × ৳${item.sellingPrice.toLocaleString('en-BD')} = ৳${lineTotal.toLocaleString(
      'en-BD'
    )}`;
  });

  const summaryLines = [
    `${shopTitle} — Price Quote`,
    `------------------------`,
    ...lines,
    `------------------------`,
    `Products Subtotal: ৳${totalSellingSubtotal.toLocaleString('en-BD')}`,
    `Delivery (${
      customer.districtName
        ? isInsideDhaka
          ? 'Inside Dhaka'
          : `Outside Dhaka · ${customer.districtName}`
        : 'Outside Dhaka'
    }): ৳${deliveryCharge.toLocaleString('en-BD')}`,
    `Total Payable: ৳${customerPaysTotal.toLocaleString('en-BD')}`,
  ];

  if (clampedAdvance > 0) {
    summaryLines.push(
      `Advance Received: ৳${clampedAdvance.toLocaleString('en-BD')}`,
      `Cash on Delivery: ৳${codPayableOnDelivery.toLocaleString('en-BD')}`
    );
  }

  return summaryLines.join('\n');
}

const SAVED_CUSTOMERS_KEY = (uid: string) => `saved_customers_${uid}`;

export function loadSavedCustomers(uid: string): SavedCustomerProfile[] {
  try {
    const raw = localStorage.getItem(SAVED_CUSTOMERS_KEY(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c: any) => ({
      ...EMPTY_CUSTOMER_DETAILS,
      ...c,
      id: String(c.id || c.mobile || Math.random()),
      source: 'saved' as const,
    }));
  } catch {
    return [];
  }
}

export function upsertSavedCustomer(
  uid: string,
  customer: CartCustomerDetails
): SavedCustomerProfile[] {
  const existing = loadSavedCustomers(uid);
  const phoneKey = normalizeBdPhoneKey(customer.mobile);
  const entry: SavedCustomerProfile = {
    ...customer,
    mobile: normalizeBdPhone(customer.mobile),
    altMobile: customer.altMobile.trim()
      ? normalizeBdPhone(customer.altMobile)
      : '',
    id: phoneKey || `${customer.name.trim()}_${Date.now()}`,
    source: 'saved',
    lastOrderedAtMs: Date.now(),
  };

  const next = [
    entry,
    ...existing.filter((item) => normalizeBdPhoneKey(item.mobile) !== phoneKey),
  ].slice(0, 40);

  try {
    localStorage.setItem(SAVED_CUSTOMERS_KEY(uid), JSON.stringify(next));
  } catch {
    // ignore storage limits
  }
  return next;
}

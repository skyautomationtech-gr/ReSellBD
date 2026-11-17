import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import {
  CartItem,
  CompanySettings,
  Product,
  UserProfile,
} from '../../types';
import {
  BdDivision,
  BdDistrict,
  BdUpazilaThana,
  getDivisions,
  getDistricts,
  getUpazilasAndThanas,
} from '../../data/bd/geocodeService';
import { useNetwork } from '../../context/NetworkContext';
import { createAppNotification } from '../../lib/notificationHelper';
import { triggerHaptic } from '../../lib/nativeFeedback';
import {
  DELIVERY_CHARGE_INSIDE_DHAKA,
  DELIVERY_CHARGE_OUTSIDE_DHAKA,
  CartCustomerDetails,
  EMPTY_CUSTOMER_DETAILS,
  OrderSuccessData,
  normalizeBdPhone,
  getItemCost,
  getItemSuggestedPrice,
  getItemStockLimit,
  computeOrderTotals,
  validateCustomerDetailsMap,
  buildCustomerQuoteText,
} from '../orders/shared/orderCalculations';
import { CustomerDeliveryForm } from '../orders/shared/CustomerDeliveryForm';
import {
  WalletCoverageRow,
  OrderConfirmModalSheet,
  OrderSuccessCard,
} from '../orders/shared/OrderConfirmAndSuccess';
import {
  ArrowLeft,
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  Lock,
  Minus,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Share2,
  ShoppingBag,
  SlidersHorizontal,
  Trash2,
  Truck,
  WifiOff,
  X,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';

export { DELIVERY_CHARGE_INSIDE_DHAKA, DELIVERY_CHARGE_OUTSIDE_DHAKA };
export type { CartCustomerDetails };

interface YourCartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile;
  cart: CartItem[];
  savedForLater: CartItem[];
  products: Product[];
  walletBalance: number;
  companySettings: CompanySettings | null;
  loading?: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
  canAccessFullApp?: boolean;
  onOpenLockedModal?: (featureName?: string) => void;
  onUpdateQuantity: (id: string, newQty: number) => void;
  onUpdateSellingPrice: (id: string, newPrice: number) => void;
  onBulkUpdateSellingPrices: (updater: (item: CartItem) => number) => void;
  onRemoveItem: (id: string) => void;
  onRestoreItem: (item: CartItem, index: number) => void;
  onClearCart: () => void;
  onSaveForLater: (item: CartItem) => void;
  onMoveToCart: (item: CartItem) => void;
  onRemoveSavedItem: (id: string) => void;
  onOrderSuccessCleanup: () => void;
  onViewOrders: () => void;
  removalNotices?: string[];
  onDismissRemovalNotices?: () => void;
}

interface CartRowCardProps {
  item: CartItem;
  index: number;
  reducedMotion: boolean;
  onUpdateQuantity: (id: string, newQty: number) => void;
  onUpdateSellingPrice: (id: string, newPrice: number) => void;
  onSwipeRemove: (item: CartItem, index: number) => void;
  onSaveForLater: (item: CartItem) => void;
}

const CartRowCard: React.FC<CartRowCardProps> = ({
  item,
  index,
  reducedMotion,
  onUpdateQuantity,
  onUpdateSellingPrice,
  onSwipeRemove,
  onSaveForLater,
}) => {
  const costPrice = getItemCost(item);
  const stockLimit = getItemStockLimit(item);
  const lineCost = costPrice * item.quantity;
  const lineSelling = item.sellingPrice * item.quantity;
  const lineProfit = (item.sellingPrice - costPrice) * item.quantity;
  const marginPct =
    item.sellingPrice > 0
      ? ((item.sellingPrice - costPrice) / item.sellingPrice) * 100
      : 0;

  const isPriceBelowMin = item.sellingPrice < costPrice;
  const isOverStock = item.quantity > stockLimit || stockLimit <= 0;
  const isLowMargin = !isPriceBelowMin && marginPct < 5;

  // Local text drafts so typing numbers feels natural without jumping
  const [qtyDraft, setQtyDraft] = useState<string>(String(item.quantity));
  const [priceDraft, setPriceDraft] = useState<string>(String(item.sellingPrice));
  const [priceFocused, setPriceFocused] = useState(false);

  useEffect(() => {
    setQtyDraft(String(item.quantity));
  }, [item.quantity]);

  useEffect(() => {
    if (!priceFocused) {
      setPriceDraft(String(item.sellingPrice));
    }
  }, [item.sellingPrice, priceFocused]);

  // Long-press stepper refs
  const repeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const didRepeatRef = useRef(false);
  const qtyRef = useRef(item.quantity);
  qtyRef.current = item.quantity;

  const clearStepperTimers = () => {
    if (repeatTimeoutRef.current) {
      clearTimeout(repeatTimeoutRef.current);
      repeatTimeoutRef.current = null;
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
  };

  useEffect(() => clearStepperTimers, []);

  const stepQuantity = (delta: number) => {
    const current = qtyRef.current;
    const next = current + delta;
    if (delta < 0) {
      if (current <= 1) return;
      triggerHaptic('light');
      onUpdateQuantity(item.id, Math.max(1, next));
    } else {
      if (stockLimit <= 0 || current >= stockLimit) {
        triggerHaptic('medium');
        return;
      }
      triggerHaptic('light');
      onUpdateQuantity(item.id, Math.min(stockLimit, next));
    }
  };

  const handleStepperPointerDown = (delta: number) => {
    clearStepperTimers();
    didRepeatRef.current = false;
    repeatTimeoutRef.current = setTimeout(() => {
      didRepeatRef.current = true;
      stepQuantity(delta);
      repeatIntervalRef.current = setInterval(() => {
        stepQuantity(delta);
      }, 110);
    }, 380);
  };

  const handleStepperClick = (delta: number) => {
    if (didRepeatRef.current) {
      didRepeatRef.current = false;
      return;
    }
    stepQuantity(delta);
  };

  // Swipe-left to remove (axis-locked so vertical scrolling works smoothly)
  const [swipeX, setSwipeX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const touchMetaRef = useRef<{
    startX: number;
    startY: number;
    axis: 'x' | 'y' | null;
  } | null>(null);

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    touchMetaRef.current = { startX: t.clientX, startY: t.clientY, axis: null };
    setIsSwiping(false);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const meta = touchMetaRef.current;
    if (!meta) return;
    const t = e.touches[0];
    const dx = t.clientX - meta.startX;
    const dy = t.clientY - meta.startY;

    if (!meta.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      meta.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }

    if (meta.axis === 'x') {
      setIsSwiping(true);
      const clamped = Math.min(0, Math.max(-116, dx));
      setSwipeX(clamped);
    }
  };

  const handleTouchEnd = () => {
    if (swipeX <= -78) {
      triggerHaptic('medium');
      setSwipeX(0);
      setIsSwiping(false);
      touchMetaRef.current = null;
      onSwipeRemove(item, index);
      return;
    }
    setSwipeX(0);
    setIsSwiping(false);
    touchMetaRef.current = null;
  };

  const quickPresets = [
    { label: 'Min', value: costPrice },
    { label: '+10%', value: Math.round(costPrice * 1.1) },
    { label: '+20%', value: Math.round(costPrice * 1.2) },
    { label: '+30%', value: Math.round(costPrice * 1.3) },
  ];

  const coverUrl =
    item.variant?.images?.[0]?.url || item.product.images?.[0]?.url || '';

  return (
    <div className={`relative rounded-xl overflow-hidden ${swipeX < -2 ? 'bg-rose-500' : 'bg-transparent'}`}>
      {/* Revealed Swipe Action Background */}
      <div
        aria-hidden="true"
        className={`absolute inset-y-0 right-0 w-28 flex items-center justify-end pr-4 text-white text-xs font-semibold gap-1.5 select-none transition-opacity ${
          swipeX < -2 ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <Trash2 className="w-4 h-4 shrink-0" />
        <span>Remove</span>
      </div>

      {/* Foreground Compact Row-Card */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: isSwiping || reducedMotion ? 'none' : 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
        className={`relative bg-white border rounded-xl p-3 space-y-2.5 ${
          isPriceBelowMin || isOverStock
            ? 'border-rose-300'
            : 'border-slate-200/90'
        }`}
      >
        {/* Top Row: 56px Image + Name (2 lines max) + Category & Stock */}
        <div className="flex items-start gap-2.5 min-h-[64px]">
          <div className="w-14 h-14 rounded-xl bg-slate-100 border border-slate-200/80 overflow-hidden shrink-0">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={item.product.name}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-400">
                <Package className="w-5 h-5" />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 space-y-1">
            <h4
              title={item.product.name}
              className="text-[13px] font-semibold text-slate-900 leading-snug line-clamp-2"
            >
              {item.product.name}
            </h4>

            <div className="flex items-center flex-wrap gap-1.5 text-[11px]">
              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium truncate max-w-[120px]">
                {item.product.categoryName || 'General'}
              </span>

              {item.variant && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-medium">
                  <span
                    className="w-2 h-2 rounded-full border border-slate-300 shrink-0"
                    style={{ backgroundColor: item.variant.colorName.toLowerCase() }}
                  />
                  <span className="truncate max-w-[80px]">{item.variant.colorName}</span>
                </span>
              )}

              <span
                className={`px-1.5 py-0.5 rounded font-semibold tabular-nums ${
                  isOverStock
                    ? 'bg-rose-50 text-rose-700'
                    : stockLimit <= 5
                    ? 'bg-amber-50 text-amber-800'
                    : 'bg-emerald-50 text-emerald-700'
                }`}
              >
                {stockLimit} in stock
              </span>
            </div>
          </div>
        </div>

        {/* Middle Controls: Stepper + Selling Price Input */}
        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2.5 pt-1 border-t border-slate-100 items-start">
          {/* Quantity Stepper (Min 1, Max = stock, Long-Press + Typed Input) */}
          <div className="space-y-1">
            <label
              htmlFor={`cart-qty-${item.id}`}
              className="text-[11px] font-medium text-slate-500 block"
            >
              Quantity
            </label>
            <div className="flex items-center border border-slate-200 rounded-xl h-[40px] bg-slate-50/70 overflow-hidden max-w-[136px]">
              <button
                type="button"
                aria-label="Decrease quantity"
                disabled={item.quantity <= 1}
                onPointerDown={() => handleStepperPointerDown(-1)}
                onPointerUp={clearStepperTimers}
                onPointerLeave={clearStepperTimers}
                onPointerCancel={clearStepperTimers}
                onClick={() => handleStepperClick(-1)}
                className="w-10 h-full flex items-center justify-center text-slate-600 hover:bg-slate-200/60 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>

              <input
                id={`cart-qty-${item.id}`}
                type="text"
                inputMode="numeric"
                aria-label={`Quantity for ${item.product.name}`}
                value={qtyDraft}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, '');
                  setQtyDraft(digits);
                  const parsed = parseInt(digits, 10);
                  if (!isNaN(parsed) && parsed >= 1) {
                    onUpdateQuantity(item.id, parsed);
                  }
                }}
                onBlur={() => {
                  const parsed = parseInt(qtyDraft, 10);
                  if (isNaN(parsed) || parsed < 1) {
                    setQtyDraft('1');
                    onUpdateQuantity(item.id, 1);
                  } else {
                    setQtyDraft(String(parsed));
                  }
                }}
                className="w-full min-w-[36px] text-center bg-transparent text-[13px] font-bold text-slate-900 tabular-nums outline-none"
              />

              <button
                type="button"
                aria-label="Increase quantity"
                disabled={item.quantity >= stockLimit}
                onPointerDown={() => handleStepperPointerDown(1)}
                onPointerUp={clearStepperTimers}
                onPointerLeave={clearStepperTimers}
                onPointerCancel={clearStepperTimers}
                onClick={() => handleStepperClick(1)}
                className="w-10 h-full flex items-center justify-center text-slate-600 hover:bg-slate-200/60 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {isOverStock && (
              <p className="text-[11px] font-semibold text-rose-600 tabular-nums">
                Only {stockLimit} available
              </p>
            )}
          </div>

          {/* Selling Price Input + Min Hint */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-1 text-[11px]">
              <label
                htmlFor={`cart-price-${item.id}`}
                className="font-medium text-slate-500"
              >
                Selling price
              </label>
              <span className="text-slate-400 font-medium tabular-nums">
                Min ৳{costPrice.toLocaleString('en-BD')}
              </span>
            </div>

            <div className="relative h-[40px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[13px] font-semibold text-slate-400 pointer-events-none">
                ৳
              </span>
              <input
                id={`cart-price-${item.id}`}
                type="number"
                inputMode="decimal"
                min={0}
                value={priceDraft}
                onFocus={() => setPriceFocused(true)}
                onChange={(e) => {
                  const val = e.target.value;
                  setPriceDraft(val);
                  const parsed = parseFloat(val);
                  onUpdateSellingPrice(
                    item.id,
                    isNaN(parsed) ? 0 : Math.max(0, parsed)
                  );
                }}
                onBlur={() => {
                  setPriceFocused(false);
                  const parsed = parseFloat(priceDraft);
                  const safe = isNaN(parsed) ? 0 : Math.max(0, parsed);
                  setPriceDraft(String(safe));
                  onUpdateSellingPrice(item.id, safe);
                }}
                className={`w-full h-full pl-7 pr-2.5 rounded-xl border text-[13px] font-bold text-slate-900 tabular-nums outline-none transition-colors ${
                  isPriceBelowMin
                    ? 'border-rose-400 bg-rose-50/40 focus:border-rose-500'
                    : 'border-slate-200 bg-white focus:border-blue-500'
                }`}
              />
            </div>

            {isPriceBelowMin && (
              <p className="text-[11px] font-semibold text-rose-600 tabular-nums">
                Must be at least ৳{costPrice.toLocaleString('en-BD')}
              </p>
            )}
            {isLowMargin && (
              <p className="text-[11px] font-medium text-amber-700 tabular-nums">
                Low margin ({marginPct.toFixed(1).replace(/\.0$/, '')}% — under 5%)
              </p>
            )}
          </div>
        </div>

        {/* Quick Set Price Chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-slate-400 mr-0.5">Set:</span>
          {quickPresets.map((preset) => {
            const isActive = Math.round(item.sellingPrice) === preset.value;
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onUpdateSellingPrice(item.id, preset.value);
                  setPriceDraft(String(preset.value));
                }}
                className={`min-h-[28px] px-2.5 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200/80'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        {/* One Clean Numbers Line + Subtle Footer Actions */}
        <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap text-[11.5px]">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 tabular-nums text-slate-600">
            <span>
              Wholesale{' '}
              <strong className="text-slate-800">
                ৳{lineCost.toLocaleString('en-BD')}
              </strong>
              <span className="text-slate-400"> ×{item.quantity}</span>
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>
              Selling{' '}
              <strong className="text-slate-800">
                ৳{lineSelling.toLocaleString('en-BD')}
              </strong>
              <span className="text-slate-400"> ×{item.quantity}</span>
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span
              className={`font-bold ${
                lineProfit >= 0 ? 'text-emerald-700' : 'text-rose-600'
              }`}
            >
              {lineProfit >= 0 ? '+' : ''}৳{lineProfit.toLocaleString('en-BD')} (
              {marginPct.toFixed(1).replace(/\.0$/, '')}%)
            </span>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onSaveForLater(item);
              }}
              className="min-h-[32px] text-[11px] font-semibold text-slate-600 hover:text-blue-600 inline-flex items-center gap-1 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
            >
              <Bookmark className="w-3 h-3" />
              <span>Save for later</span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onSwipeRemove(item, index);
              }}
              className="min-h-[32px] text-[11px] font-semibold text-slate-400 hover:text-rose-600 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 rounded"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const YourCartDrawer: React.FC<YourCartDrawerProps> = ({
  isOpen,
  onClose,
  user,
  cart,
  savedForLater,
  products,
  walletBalance,
  companySettings,
  loading = false,
  loadError = null,
  onRetryLoad,
  canAccessFullApp = true,
  onOpenLockedModal,
  onUpdateQuantity,
  onUpdateSellingPrice,
  onBulkUpdateSellingPrices,
  onRemoveItem,
  onRestoreItem,
  onClearCart,
  onSaveForLater,
  onMoveToCart,
  onRemoveSavedItem,
  onOrderSuccessCleanup,
  onViewOrders,
  removalNotices = [],
  onDismissRemovalNotices,
}) => {
  const reducedMotion = !!useReducedMotion();
  const { isOnline } = useNetwork();

  // Header Clear Confirm Sheet
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Undo Remove Snackbar (5s)
  const [undoData, setUndoData] = useState<{
    item: CartItem;
    index: number;
  } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bulk Price Tools
  const [showBulkMarginInput, setShowBulkMarginInput] = useState(false);
  const [bulkMarginPct, setBulkMarginPct] = useState('20');
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

  // Saved for later expand toggle
  const [showSavedList, setShowSavedList] = useState(false);

  // Customer Details (collapsible, session persisted)
  const [isCustomerOpen, setIsCustomerOpen] = useState(true);
  const [customer, setCustomer] = useState<CartCustomerDetails>(EMPTY_CUSTOMER_DETAILS);
  const [customerErrors, setCustomerErrors] = useState<Record<string, string>>({});

  // Bangladesh geo lists
  const [divisions, setDivisions] = useState<BdDivision[]>([]);
  const [districts, setDistricts] = useState<BdDistrict[]>([]);
  const [upazilas, setUpazilas] = useState<BdUpazilaThana[]>([]);

  // COD Advance received
  const [advanceDraft, setAdvanceDraft] = useState<string>('');

  // Sticky Summary expand toggle (per-item breakdown)
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);

  // Confirmation Sheet & Success Screen
  const [showConfirmSheet, setShowConfirmSheet] = useState(false);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const placingOrderLockRef = useRef(false);
  const [orderSubmitError, setOrderSubmitError] = useState('');
  const [orderSuccess, setOrderSuccess] = useState<OrderSuccessData | null>(null);

  const customerSectionRef = useRef<HTMLDivElement | null>(null);

  // Load session-persisted customer details
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`cart_customer_${user.uid}`);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CartCustomerDetails>;
        setCustomer({ ...EMPTY_CUSTOMER_DETAILS, ...parsed });
      }
    } catch {
      // Ignore storage errors
    }
  }, [user.uid]);

  // Persist customer details to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem(
        `cart_customer_${user.uid}`,
        JSON.stringify(customer)
      );
    } catch {
      // Ignore storage errors
    }
  }, [customer, user.uid]);

  // Load BD Divisions
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    getDivisions()
      .then((list) => {
        if (active) setDivisions(list);
      })
      .catch((err) => console.warn('Failed to load divisions:', err));
    return () => {
      active = false;
    };
  }, [isOpen]);

  // Load BD Districts when division changes
  useEffect(() => {
    if (!customer.divisionId) {
      setDistricts([]);
      return;
    }
    let active = true;
    getDistricts(customer.divisionId)
      .then((list) => {
        if (active) setDistricts(list);
      })
      .catch((err) => console.warn('Failed to load districts:', err));
    return () => {
      active = false;
    };
  }, [customer.divisionId]);

  // Load BD Upazilas/Thanas when district changes
  useEffect(() => {
    if (!customer.districtId) {
      setUpazilas([]);
      return;
    }
    let active = true;
    getUpazilasAndThanas(customer.districtId)
      .then((list) => {
        if (active) setUpazilas(list);
      })
      .catch((err) => console.warn('Failed to load upazilas:', err));
    return () => {
      active = false;
    };
  }, [customer.districtId]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  // Reset transient overlays when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setShowClearConfirm(false);
      setShowConfirmSheet(false);
      setOrderSubmitError('');
      setOrderSuccess(null);
    }
  }, [isOpen]);

  // Clear orderSuccess if reseller adds a new item to cart
  useEffect(() => {
    if (cart.length > 0 && orderSuccess) {
      setOrderSuccess(null);
    }
  }, [cart.length, orderSuccess]);

  // Escape key closes active sheet or drawer
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showClearConfirm) {
        setShowClearConfirm(false);
      } else if (showConfirmSheet) {
        if (!isPlacingOrder) setShowConfirmSheet(false);
      } else if (!isPlacingOrder) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showClearConfirm, showConfirmSheet, isPlacingOrder, onClose]);

  // Totals & Validation Calculations (Shared Order Calculations)
  const {
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
  } = useMemo(
    () =>
      computeOrderTotals(
        cart,
        customer.districtName,
        advanceDraft,
        companySettings
      ),
    [cart, customer.districtName, advanceDraft, companySettings]
  );

  // Swipe / Remove with 5-second Undo Snackbar
  const handleRemoveWithUndo = (item: CartItem, idx: number) => {
    onRemoveItem(item.id);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoData({ item, index: idx });
    undoTimerRef.current = setTimeout(() => {
      setUndoData(null);
    }, 5000);
  };

  const handleUndoRemove = () => {
    if (!undoData) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    triggerHaptic('light');
    onRestoreItem(undoData.item, undoData.index);
    setUndoData(null);
  };

  // Bulk Price Tools
  const handleApplyBulkMargin = () => {
    const pct = parseFloat(bulkMarginPct);
    if (isNaN(pct) || pct < 0) return;
    triggerHaptic('light');
    onBulkUpdateSellingPrices((item) => {
      const cost = getItemCost(item);
      return Math.round(cost * (1 + pct / 100));
    });
    setShowBulkMarginInput(false);
    setShareFeedback(`Applied +${pct}% margin to all items.`);
    setTimeout(() => setShareFeedback(null), 2500);
  };

  const handleResetSuggestedPrices = () => {
    triggerHaptic('light');
    onBulkUpdateSellingPrices((item) => getItemSuggestedPrice(item));
    setShareFeedback('Reset all items to suggested retail price.');
    setTimeout(() => setShareFeedback(null), 2500);
  };

  // Share Price List (Customer Quote - NO wholesale price or profit)
  const handleSharePriceList = async () => {
    if (cart.length === 0) return;
    triggerHaptic('light');
    const shopTitle = user.shopName || user.fullName || 'Our Shop';
    const quoteText = buildCustomerQuoteText({
      shopTitle,
      items: cart,
      customer,
      isInsideDhaka,
      deliveryCharge,
      totalSellingSubtotal,
      customerPaysTotal,
      clampedAdvance,
      codPayableOnDelivery,
    });

    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({
          title: `${shopTitle} Price Quote`,
          text: quoteText,
        });
        setShareFeedback('Quote shared.');
        setTimeout(() => setShareFeedback(null), 2500);
        return;
      }
    } catch {
      // Fallback to clipboard if user cancels native share or unsupported
    }

    try {
      await navigator.clipboard.writeText(quoteText);
      setShareFeedback('Price list copied for customer.');
      setTimeout(() => setShareFeedback(null), 2500);
    } catch {
      setShareFeedback('Could not copy quote.');
      setTimeout(() => setShareFeedback(null), 2500);
    }
  };

  // Validate customer details before opening confirmation sheet
  const validateCustomerDetails = (): boolean => {
    const errs = validateCustomerDetailsMap(customer);
    setCustomerErrors(errs);
    if (Object.keys(errs).length > 0) {
      setIsCustomerOpen(true);
      setTimeout(() => {
        customerSectionRef.current?.scrollIntoView({
          behavior: reducedMotion ? 'auto' : 'smooth',
          block: 'start',
        });
      }, 60);
      return false;
    }
    return true;
  };

  const handleOpenConfirmation = () => {
    if (!canAccessFullApp) {
      onOpenLockedModal?.('Cart & Ordering');
      return;
    }
    if (cart.length === 0 || hasInvalidPrices || hasInvalidStock) return;
    if (!validateCustomerDetails()) return;
    setOrderSubmitError('');
    setShowConfirmSheet(true);
  };

  // Place Order via Firestore Transaction (Double-tap Protected)
  const handleConfirmPlaceOrder = async () => {
    if (placingOrderLockRef.current || isPlacingOrder) return;
    if (!canAccessFullApp) {
      onOpenLockedModal?.('Cart & Ordering');
      return;
    }
    if (!isOnline) {
      setOrderSubmitError('No internet connection. Please reconnect and try again.');
      return;
    }
    if (cart.length === 0 || hasInvalidPrices || hasInvalidStock) {
      setOrderSubmitError('Please resolve item price or stock issues before placing the order.');
      return;
    }
    if (!validateCustomerDetails()) {
      setShowConfirmSheet(false);
      return;
    }

    placingOrderLockRef.current = true;
    setIsPlacingOrder(true);
    setOrderSubmitError('');
    triggerHaptic('medium');

    const fullFormattedAddress = [
      customer.address.trim(),
      customer.upazilaName,
      customer.districtName,
      customer.divisionName,
    ]
      .filter(Boolean)
      .join(', ');

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let randGroup = '';
    for (let i = 0; i < 4; i++) {
      randGroup += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const groupOrderId = `SAT_GRP-${randGroup}`;
    const deliveryZone: 'inside_dhaka' | 'outside_dhaka' = isInsideDhaka
      ? 'inside_dhaka'
      : 'outside_dhaka';
    const orderPaymentStatus: 'unpaid' | 'paid' | 'partial' =
      clampedAdvance > 0 && codPayableOnDelivery === 0
        ? 'paid'
        : clampedAdvance > 0
        ? 'partial'
        : 'unpaid';

    const generatedOrderNumbers: string[] = [];

    try {
      await runTransaction(db, async (transaction) => {
        // 1. Verify every product is active and in stock from server before writing
        const productDocs = await Promise.all(
          cart.map((item) => transaction.get(doc(db, 'products', item.product.id)))
        );

        for (let i = 0; i < cart.length; i++) {
          const item = cart[i];
          const pSnap = productDocs[i];
          if (!pSnap.exists()) {
            throw new Error(`"${item.product.name}" is no longer available.`);
          }
          const liveData = pSnap.data();
          if (liveData.status !== 'active') {
            throw new Error(`"${item.product.name}" is currently unavailable.`);
          }
          let liveStock = Number(liveData.stock || 0);
          if (item.variant && Array.isArray(liveData.variants)) {
            const liveVar = liveData.variants.find(
              (v: any) => v.id === item.variant?.id
            );
            if (!liveVar || liveVar.status !== 'active') {
              throw new Error(
                `"${item.product.name}" (${item.variant.colorName}) is unavailable.`
              );
            }
            liveStock = Number(liveVar.stock || 0);
          }
          if (item.quantity > liveStock) {
            throw new Error(
              `Only ${liveStock} available for "${item.product.name}".`
            );
          }
        }

        // 2. Write order document(s) using exact existing price/commission formulas
        for (let index = 0; index < cart.length; index++) {
          const item = cart[index];
          const p = item.product;
          const v = item.variant;
          const q = item.quantity;
          const sPrice = item.sellingPrice;

          const vAdj = v ? v.priceAdjustment || 0 : 0;
          const itemUnitResellerPrice = p.resellerPrice + vAdj;
          const itemUnitRetailPrice = p.retailPrice + vAdj;
          const itemTotalAmount = q * sPrice;
          const itemSellAmount = q * (sPrice - itemUnitResellerPrice);

          if (sPrice < itemUnitResellerPrice) {
            throw new Error(
              `Selling price for "${p.name}" cannot be below wholesale cost.`
            );
          }

          const itemOrderNumber = `SAT_ORD-${randGroup}${
            cart.length > 1 ? `-${index + 1}` : ''
          }`;
          generatedOrderNumbers.push(itemOrderNumber);

          const newOrderRef = doc(collection(db, 'orders'));
          transaction.set(newOrderRef, {
            orderNumber: itemOrderNumber,
            userId: user.uid,
            resellerId: user.uid,
            resellerName: user.fullName,
            resellerShopName: user.shopName || user.fullName,
            productId: p.id,
            productName: p.name,
            productImage: p.images?.[0]?.url || '',
            categoryId: p.categoryId || '',
            variantId: v ? v.id : null,
            variantColorName: v ? v.colorName : null,
            quantity: q,
            unitRetailPrice: itemUnitRetailPrice,
            suggestedRetailPrice: itemUnitRetailPrice,
            sellingPrice: sPrice,
            unitResellerPrice: itemUnitResellerPrice,
            totalAmount: itemTotalAmount,
            sellAmount: itemSellAmount,
            customerName: customer.name.trim(),
            customerPhone: normalizeBdPhone(customer.mobile),
            customerAltPhone: customer.altMobile.trim()
              ? normalizeBdPhone(customer.altMobile)
              : null,
            customerDivision: customer.divisionName,
            customerDistrict: customer.districtName,
            customerUpazila: customer.upazilaName,
            customerAddress: fullFormattedAddress,
            courierNote: customer.courierNote.trim() || null,
            specialInstructions: customer.courierNote.trim() || '',
            deliveryZone,
            deliveryCost: index === 0 ? deliveryCharge : 0,
            advanceAmount: index === 0 ? clampedAdvance : 0,
            codAmount: index === 0 ? codPayableOnDelivery : 0,
            cartOrderGroupId: groupOrderId,
            bundleDeliveryCost: deliveryCharge,
            bundleAdvanceAmount: clampedAdvance,
            bundleCodAmount: codPayableOnDelivery,
            status: 'pending',
            paymentStatus: orderPaymentStatus,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      });

      // Notify Admins (non-blocking)
      try {
        const displayOrderLabel =
          generatedOrderNumbers.length === 1
            ? generatedOrderNumbers[0]
            : `${generatedOrderNumbers[0]} (+${generatedOrderNumbers.length - 1})`;
        await createAppNotification({
          title: `New Order: #${displayOrderLabel}`,
          message: `Reseller ${
            user.fullName || user.shopName || 'Reseller'
          } placed an order for ${customer.name.trim()} (${
            customer.districtName
          }) · COD ৳${codPayableOnDelivery.toLocaleString('en-BD')}.`,
          type: 'new_order',
          targetAudience: 'admin',
          metadata: {
            orderNumber: displayOrderLabel,
            resellerId: user.uid,
            customerName: customer.name.trim(),
            totalAmount: customerPaysTotal,
            codAmount: codPayableOnDelivery,
            type: 'new_order',
          },
          priority: 'high',
        });
      } catch (notifErr) {
        console.error('Failed to notify admin of new order:', notifErr);
      }

      const primaryNum =
        generatedOrderNumbers.length === 1
          ? generatedOrderNumbers[0]
          : `SAT_ORD-${randGroup}`;

      setOrderSuccess({
        primaryOrderNumber: primaryNum,
        orderNumbers: generatedOrderNumbers,
        totalProducts: productCount,
        totalPieces: pieceCount,
        customerName: customer.name.trim(),
        customerPayable: customerPaysTotal,
        codAmount: codPayableOnDelivery,
        estimatedProfit: totalEstimatedProfit,
      });

      setShowConfirmSheet(false);
      setAdvanceDraft('');
      triggerHaptic('heavy');
      onOrderSuccessCleanup();
    } catch (err: any) {
      console.error('Cart order creation error:', err);
      setOrderSubmitError(
        err?.message || 'Failed to place order. Please try again.'
      );
    } finally {
      placingOrderLockRef.current = false;
      setIsPlacingOrder(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Your Cart"
      className="fixed inset-0 z-50 flex justify-end"
    >
      {/* Backdrop */}
      <div
        onClick={() => {
          if (!isPlacingOrder) onClose();
        }}
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-xs"
      />

      {/* Drawer Panel (Responsive from 320px to desktop) */}
      <motion.div
        initial={reducedMotion ? false : { x: '100%' }}
        animate={{ x: 0 }}
        exit={reducedMotion ? undefined : { x: '100%' }}
        transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full sm:max-w-[500px] bg-[#F8FAFC]/95 backdrop-blur-xl h-full shadow-2xl border-l border-slate-200/80 flex flex-col justify-between z-10 overflow-hidden"
      >
        {/* 1. SLIM HEADER */}
        <header className="shrink-0 bg-white/90 backdrop-blur-md border-b border-slate-200/80 px-3 sm:px-4 h-[56px] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={onClose}
              aria-label="Back to catalog"
              className="w-10 h-10 -ml-1.5 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100 flex items-center justify-center shrink-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <ArrowLeft className="w-4.5 h-4.5" />
            </button>
            <div className="min-w-0">
              <h2 className="text-[16px] font-bold text-slate-900 leading-tight truncate">
                Your Cart
              </h2>
              <p className="text-[11.5px] text-slate-500 font-medium tabular-nums truncate">
                {productCount} {productCount === 1 ? 'product' : 'products'} -{' '}
                {pieceCount} {pieceCount === 1 ? 'pc' : 'pcs'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {cart.length > 0 && canAccessFullApp && (
              <button
                type="button"
                onClick={() => setShowClearConfirm(true)}
                className="min-h-[40px] px-2.5 rounded-xl text-[12px] font-semibold text-slate-500 hover:text-rose-600 hover:bg-rose-50/70 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close cart"
              className="w-10 h-10 rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <X className="w-4.5 h-4.5" />
            </button>
          </div>
        </header>

        {/* 2. SCROLLABLE BODY */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 space-y-3">
          {/* Pending / Locked Reseller Guard */}
          {!canAccessFullApp ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4">
              <div className="w-14 h-14 rounded-xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center">
                <Lock className="w-6 h-6" />
              </div>
              <div className="space-y-1 max-w-[260px]">
                <h3 className="text-[16px] font-bold text-slate-900">
                  Account Under Review
                </h3>
                <p className="text-[12.5px] text-slate-600 leading-relaxed">
                  Wholesale prices, cart tools, and checkout unlock automatically as soon as your reseller account is approved.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenLockedModal?.('Cart & Ordering');
                }}
                className="h-[42px] px-5 rounded-xl bg-slate-900 text-white text-[12.5px] font-semibold cursor-pointer"
              >
                Check Account Status
              </button>
            </div>
          ) : orderSuccess ? (
            /* ORDER SUCCESS SCREEN (Shared Component) */
            <OrderSuccessCard
              orderSuccess={orderSuccess}
              reducedMotion={reducedMotion}
              onViewOrder={() => {
                setOrderSuccess(null);
                onClose();
                onViewOrders();
              }}
              secondaryLabel="Continue shopping"
              onSecondaryAction={() => {
                setOrderSuccess(null);
                onClose();
              }}
            />
          ) : loading && products.length === 0 ? (
            /* LOADING SKELETONS */
            <div className="space-y-3" aria-busy="true" aria-label="Loading cart">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className="bg-white border border-slate-200/80 rounded-xl p-3 space-y-3 animate-pulse"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="w-14 h-14 rounded-xl bg-slate-100 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 bg-slate-100 rounded w-3/4" />
                      <div className="h-3 bg-slate-100 rounded w-1/2" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="h-10 bg-slate-100 rounded-xl" />
                    <div className="h-10 bg-slate-100 rounded-xl" />
                  </div>
                </div>
              ))}
            </div>
          ) : loadError ? (
            /* ERROR STATE WITH RETRY */
            <div className="bg-white border border-rose-200 rounded-xl p-6 text-center space-y-3 mt-4">
              <AlertCircle className="w-7 h-7 text-rose-500 mx-auto" />
              <div className="space-y-1">
                <h3 className="text-[14px] font-bold text-slate-900">
                  Could not load cart items
                </h3>
                <p className="text-[12px] text-slate-600">{loadError}</p>
              </div>
              {onRetryLoad && (
                <button
                  type="button"
                  onClick={onRetryLoad}
                  className="h-[40px] px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry</span>
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Auto-removal / out-of-stock notice banner */}
              {removalNotices.length > 0 && (
                <div
                  role="status"
                  className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 text-[12px] text-amber-900 flex items-start justify-between gap-2"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      {removalNotices.map((msg, i) => (
                        <p key={i}>{msg}</p>
                      ))}
                    </div>
                  </div>
                  {onDismissRemovalNotices && (
                    <button
                      type="button"
                      onClick={onDismissRemovalNotices}
                      aria-label="Dismiss notice"
                      className="p-1 text-amber-700 hover:text-amber-950 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}

              {/* EMPTY STATE (Illustration-free) */}
              {cart.length === 0 ? (
                <div className="bg-white border border-slate-200/90 rounded-xl p-6 text-center space-y-3 mt-2">
                  <div className="space-y-1">
                    <h3 className="text-[16px] font-bold text-slate-900">
                      Your cart is empty
                    </h3>
                    <p className="text-[12.5px] text-slate-500 max-w-[260px] mx-auto">
                      Add products from the catalog to set your selling prices, calculate profit, and place a bundled customer order.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className="h-[42px] px-5 rounded-xl bg-[#f57224] hover:bg-[#e0651d] text-white text-[12.5px] font-semibold cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f57224]"
                  >
                    Browse catalog
                  </button>
                </div>
              ) : (
                <>
                  {/* BULK PRICE TOOLS & SHARE QUOTE */}
                  <div className="bg-white/95 border border-slate-200/90 rounded-xl p-2.5 space-y-2">
                    <div className="flex items-center flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setShowBulkMarginInput((v) => !v)}
                        className="min-h-[34px] px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200/75 text-slate-700 text-[11.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                        <span>Apply same margin to all</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleResetSuggestedPrices}
                        className="min-h-[34px] px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200/75 text-slate-700 text-[11.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
                        <span>Reset to suggested price</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleSharePriceList}
                        className="min-h-[34px] px-2.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors ml-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <Share2 className="w-3.5 h-3.5" />
                        <span>Share price list</span>
                      </button>
                    </div>

                    {showBulkMarginInput && (
                      <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                        <label
                          htmlFor="bulk-margin-pct"
                          className="text-[11.5px] text-slate-600 font-medium whitespace-nowrap"
                        >
                          Markup %
                        </label>
                        <input
                          id="bulk-margin-pct"
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={500}
                          value={bulkMarginPct}
                          onChange={(e) => setBulkMarginPct(e.target.value)}
                          className="w-20 h-[36px] px-2.5 rounded-lg border border-slate-200 text-[12.5px] font-bold text-slate-900 tabular-nums outline-none focus:border-blue-500"
                        />
                        <button
                          type="button"
                          onClick={handleApplyBulkMargin}
                          className="h-[36px] px-3 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[12px] font-semibold cursor-pointer"
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowBulkMarginInput(false)}
                          className="h-[36px] px-2.5 rounded-lg text-slate-500 hover:bg-slate-100 text-[12px] font-medium cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    {shareFeedback && (
                      <p className="text-[11.5px] font-medium text-emerald-700 flex items-center gap-1 pt-0.5">
                        <Check className="w-3.5 h-3.5" />
                        <span>{shareFeedback}</span>
                      </p>
                    )}
                  </div>

                  {/* CART PRODUCT ROW-CARDS */}
                  <div className="space-y-2.5">
                    {cart.map((item, idx) => (
                      <CartRowCard
                        key={item.id}
                        item={item}
                        index={idx}
                        reducedMotion={reducedMotion}
                        onUpdateQuantity={onUpdateQuantity}
                        onUpdateSellingPrice={onUpdateSellingPrice}
                        onSwipeRemove={handleRemoveWithUndo}
                        onSaveForLater={onSaveForLater}
                      />
                    ))}
                  </div>

                  {/* FEATURE 1: COLLAPSIBLE CUSTOMER DETAILS (Shared Component) */}
                  <div ref={customerSectionRef}>
                    <CustomerDeliveryForm
                      idPrefix="cart"
                      customer={customer}
                      onChangeCustomer={setCustomer}
                      customerErrors={customerErrors}
                      onClearFieldError={(fields) =>
                        setCustomerErrors((prev) => {
                          const next = { ...prev };
                          fields.forEach((f) => {
                            next[f] = '';
                          });
                          return next;
                        })
                      }
                      divisions={divisions}
                      districts={districts}
                      upazilas={upazilas}
                      advanceDraft={advanceDraft}
                      onChangeAdvanceDraft={setAdvanceDraft}
                      customerPaysTotal={customerPaysTotal}
                      codPayableOnDelivery={codPayableOnDelivery}
                      clampedAdvance={clampedAdvance}
                      deliveryCharge={deliveryCharge}
                      isInsideDhaka={isInsideDhaka}
                      collapsible
                      isOpen={isCustomerOpen}
                      onToggleOpen={() => setIsCustomerOpen((v) => !v)}
                    />
                  </div>
                </>
              )}

              {/* FEATURE 5: SAVED FOR LATER LIST */}
              {savedForLater.length > 0 && (
                <div className="bg-white/95 border border-slate-200/90 rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowSavedList((v) => !v)}
                    aria-expanded={showSavedList}
                    className="w-full px-3.5 py-2.5 flex items-center justify-between text-left hover:bg-slate-50/70 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-2 text-[12.5px] font-semibold text-slate-800">
                      <Bookmark className="w-4 h-4 text-slate-500" />
                      <span>Saved for later ({savedForLater.length})</span>
                    </div>
                    {showSavedList ? (
                      <ChevronUp className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    )}
                  </button>

                  {showSavedList && (
                    <div className="divide-y divide-slate-100 border-t border-slate-100">
                      {savedForLater.map((saved) => {
                        const img =
                          saved.variant?.images?.[0]?.url ||
                          saved.product.images?.[0]?.url;
                        const sStock = getItemStockLimit(saved);
                        return (
                          <div
                            key={saved.id}
                            className="p-2.5 flex items-center justify-between gap-2.5"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-11 h-11 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden shrink-0">
                                {img ? (
                                  <img
                                    src={img}
                                    alt={saved.product.name}
                                    referrerPolicy="no-referrer"
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-slate-400">
                                    <Package className="w-4 h-4" />
                                  </div>
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="text-[12px] font-semibold text-slate-900 truncate">
                                  {saved.product.name}
                                </p>
                                <p className="text-[11px] text-slate-500 tabular-nums">
                                  Wholesale ৳{getItemCost(saved)} · {sStock} in stock
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                disabled={sStock <= 0}
                                onClick={() => {
                                  triggerHaptic('light');
                                  onMoveToCart(saved);
                                }}
                                className="min-h-[34px] px-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white text-[11px] font-semibold cursor-pointer"
                              >
                                Move to cart
                              </button>
                              <button
                                type="button"
                                onClick={() => onRemoveSavedItem(saved.id)}
                                aria-label={`Remove ${saved.product.name} from saved`}
                                className="min-h-[34px] px-2 rounded-lg text-slate-400 hover:text-rose-600 text-[11px] font-semibold cursor-pointer"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 5-SECOND UNDO SNACKBAR */}
        <AnimatePresence>
          {undoData && (
            <motion.div
              initial={reducedMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, y: 12 }}
              transition={{ duration: reducedMotion ? 0 : 0.18 }}
              role="status"
              className="mx-3 mb-2 px-3.5 py-2.5 rounded-xl bg-slate-900 text-white text-[12px] flex items-center justify-between gap-3 shadow-lg shrink-0"
            >
              <span className="truncate">
                Removed <strong>{undoData.item.product.name}</strong>
              </span>
              <button
                type="button"
                onClick={handleUndoRemove}
                className="min-h-[32px] px-2.5 rounded-lg bg-white/15 hover:bg-white/25 text-[#3DD055] font-bold text-[12px] shrink-0 cursor-pointer"
              >
                Undo
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 3. COLLAPSIBLE STICKY BOTTOM SUMMARY BAR */}
        {canAccessFullApp && cart.length > 0 && !orderSuccess && (
          <div className="shrink-0 bg-white/95 backdrop-blur-md border-t border-slate-200 px-3 sm:px-4 py-2.5 space-y-2 shadow-[0_-6px_20px_rgba(15,23,42,0.06)]">
            {/* Expandable Per-Item Profit Breakdown */}
            {isSummaryExpanded && (
              <div className="pb-2 border-b border-slate-100 space-y-1.5 max-h-36 overflow-y-auto text-[11.5px]">
                <p className="text-[11px] font-bold text-slate-500">
                  Per-item profit breakdown
                </p>
                {cart.map((item) => {
                  const cost = getItemCost(item) * item.quantity;
                  const sell = item.sellingPrice * item.quantity;
                  const prof = sell - cost;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-2 tabular-nums"
                    >
                      <span className="text-slate-700 truncate">
                        {item.product.name} ×{item.quantity}
                      </span>
                      <span className="shrink-0 text-slate-500">
                        ৳{sell.toLocaleString('en-BD')} − ৳
                        {cost.toLocaleString('en-BD')} ={' '}
                        <strong
                          className={
                            prof >= 0 ? 'text-emerald-700' : 'text-rose-600'
                          }
                        >
                          ৳{prof.toLocaleString('en-BD')}
                        </strong>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Compact Totals & Expand Toggle */}
            <div className="space-y-1 text-[12px] tabular-nums">
              <div className="flex items-center justify-between text-slate-600">
                <span>Wholesale cost (you pay)</span>
                <span className="font-semibold text-slate-800">
                  ৳{totalWholesaleCost.toLocaleString('en-BD')}
                </span>
              </div>

              <div className="flex items-center justify-between text-slate-600">
                <span className="flex items-center gap-1">
                  <Truck className="w-3.5 h-3.5 text-slate-400" />
                  <span>
                    Delivery (
                    {customer.districtName
                      ? isInsideDhaka
                        ? 'Inside Dhaka'
                        : `Outside Dhaka`
                      : 'Outside Dhaka'}
                    )
                  </span>
                </span>
                <span className="font-semibold text-slate-800">
                  ৳{deliveryCharge.toLocaleString('en-BD')}
                </span>
              </div>

              <div className="flex items-center justify-between text-slate-600">
                <span>Customer pays (incl. delivery)</span>
                <span className="font-bold text-slate-900">
                  ৳{customerPaysTotal.toLocaleString('en-BD')}
                </span>
              </div>

              <div className="flex items-center justify-between text-slate-700">
                <span>Customer pays on delivery</span>
                <span className="font-bold text-slate-900">
                  ৳{codPayableOnDelivery.toLocaleString('en-BD')}
                  {clampedAdvance > 0 && (
                    <span className="text-[11px] font-normal text-slate-500">
                      {' '}
                      (after ৳{clampedAdvance.toLocaleString('en-BD')} adv.)
                    </span>
                  )}
                </span>
              </div>

              {/* Wallet Balance Coverage Row (Shared Component) */}
              <WalletCoverageRow
                walletBalance={walletBalance}
                totalWholesaleCost={totalWholesaleCost}
                className="pt-0.5 text-[11.5px]"
              />

              {/* Estimated Total Profit + Breakdown Toggle */}
              <div className="pt-1.5 border-t border-slate-100 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setIsSummaryExpanded((v) => !v)}
                  className="text-[12px] font-semibold text-slate-700 hover:text-slate-950 inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>Estimated total profit</span>
                  {isSummaryExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </button>
                <span
                  className={`text-[18px] font-extrabold tabular-nums leading-none ${
                    totalEstimatedProfit >= 0
                      ? 'text-emerald-600'
                      : 'text-rose-600'
                  }`}
                >
                  {totalEstimatedProfit >= 0 ? '+' : ''}৳
                  {totalEstimatedProfit.toLocaleString('en-BD')}
                </span>
              </div>
            </div>

            {/* Inline Block Reason if Price/Stock Invalid */}
            {(hasInvalidPrices || hasInvalidStock) && (
              <p className="text-[11.5px] font-semibold text-rose-600 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {hasInvalidPrices
                    ? 'Fix selling prices below minimum cost before placing order.'
                    : 'Adjust quantities that exceed available stock.'}
                </span>
              </p>
            )}

            <button
              type="button"
              disabled={hasInvalidPrices || hasInvalidStock || !isOnline}
              onClick={handleOpenConfirmation}
              className="w-full h-[44px] rounded-xl bg-[#f57224] hover:bg-[#e0651d] disabled:opacity-45 disabled:cursor-not-allowed text-white text-[13px] font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f57224]"
            >
              {!isOnline ? (
                <>
                  <WifiOff className="w-4 h-4" />
                  <span>Offline - Reconnect to place order</span>
                </>
              ) : (
                <>
                  <ShoppingBag className="w-4 h-4" />
                  <span>Place order</span>
                </>
              )}
            </button>
          </div>
        )}
      </motion.div>

      {/* CLEAR CART CONFIRM SHEET */}
      <AnimatePresence>
        {showClearConfirm && (
          <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div
              onClick={() => setShowClearConfirm(false)}
              className="absolute inset-0 bg-slate-950/50 backdrop-blur-xs"
            />
            <motion.div
              initial={reducedMotion ? false : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, y: 20 }}
              transition={{ duration: reducedMotion ? 0 : 0.18 }}
              className="relative w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 shadow-2xl border border-slate-200 space-y-4 z-10"
            >
              <div className="space-y-1">
                <h3 className="text-[16px] font-bold text-slate-900">
                  Clear your cart?
                </h3>
                <p className="text-[12.5px] text-slate-600">
                  This will remove all {productCount}{' '}
                  {productCount === 1 ? 'product' : 'products'} ({pieceCount} pcs) from your cart.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(false)}
                  className="h-[42px] rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12.5px] font-semibold cursor-pointer"
                >
                  Keep items
                </button>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('medium');
                    onClearCart();
                    setShowClearConfirm(false);
                  }}
                  className="h-[42px] rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-[12.5px] font-semibold cursor-pointer"
                >
                  Clear cart
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* FEATURE 8: ORDER CONFIRMATION SHEET (Shared Component) */}
      <OrderConfirmModalSheet
        isOpen={showConfirmSheet}
        isPlacingOrder={isPlacingOrder}
        isOnline={isOnline}
        reducedMotion={reducedMotion}
        orderSubmitError={orderSubmitError}
        customer={customer}
        items={cart}
        totalWholesaleCost={totalWholesaleCost}
        totalSellingSubtotal={totalSellingSubtotal}
        deliveryCharge={deliveryCharge}
        isInsideDhaka={isInsideDhaka}
        clampedAdvance={clampedAdvance}
        codPayableOnDelivery={codPayableOnDelivery}
        totalEstimatedProfit={totalEstimatedProfit}
        onClose={() => setShowConfirmSheet(false)}
        onConfirm={handleConfirmPlaceOrder}
      />
    </div>
  );
};

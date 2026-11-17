import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { normalizeProduct } from '../../lib/productHelper';
import {
  Product,
  ProductVariant,
  UserProfile,
  CartItem,
  Category,
  CompanySettings,
  Order,
  Wallet,
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
import { useAccess } from '../../hooks/useAccess';
import { createAppNotification } from '../../lib/notificationHelper';
import { triggerHaptic } from '../../lib/nativeFeedback';
import { QrScannerModal } from '../common/QrScannerModal';
import {
  CartCustomerDetails,
  EMPTY_CUSTOMER_DETAILS,
  OrderSuccessData,
  SavedCustomerProfile,
  normalizeBdPhone,
  normalizeBdPhoneKey,
  getItemCost,
  getItemSuggestedPrice,
  getItemStockLimit,
  computeOrderTotals,
  validateCustomerDetailsMap,
  buildCustomerQuoteText,
  loadSavedCustomers,
  upsertSavedCustomer,
} from './shared/orderCalculations';
import { CustomerDeliveryForm } from './shared/CustomerDeliveryForm';
import {
  WalletCoverageRow,
  OrderConfirmModalSheet,
  OrderSuccessCard,
} from './shared/OrderConfirmAndSuccess';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  Heart,
  History,
  LayoutGrid,
  LayoutList,
  Lock,
  Minus,
  Package,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  SlidersHorizontal,
  Trash2,
  Truck,
  WifiOff,
  X,
} from 'lucide-react';

interface CreateOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile;
  onOrderCreated: () => void;
  onOrderSubmitted?: () => void;
  initialProduct?: Product | null;
  initialVariant?: ProductVariant | null;
  cartItems?: CartItem[] | null;
  onOpenLockedModal?: (featureName?: string) => void;
}

type OrderStep = 1 | 2 | 3 | 4;

interface DraftItemSnapshot {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  sellingPrice: number;
}

interface OrderDraftPayload {
  version: 1;
  step: OrderStep;
  items: DraftItemSnapshot[];
  customer: CartCustomerDetails;
  advanceDraft: string;
  updatedAt: number;
}

const DRAFT_KEY = (uid: string) => `new_order_draft_${uid}`;
const FAVORITES_KEY = (uid: string) => `reseller_order_favorites_${uid}`;

const STEPS: { id: OrderStep; label: string }[] = [
  { id: 1, label: 'Products' },
  { id: 2, label: 'Price' },
  { id: 3, label: 'Customer' },
  { id: 4, label: 'Review' },
];

function formatDraftAge(updatedAt: number): string {
  const diffMin = Math.max(1, Math.round((Date.now() - updatedAt) / 60000));
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function getOrderTimestampMs(createdAt: any): number {
  if (!createdAt) return 0;
  if (typeof createdAt?.toDate === 'function') {
    return createdAt.toDate().getTime();
  }
  if (typeof createdAt?.seconds === 'number') {
    return createdAt.seconds * 1000;
  }
  const t = new Date(createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Compact Step 2 Line-Item Editor Row with long-press stepper, quick margin chips, and validation
interface Step2ItemRowProps {
  item: CartItem;
  onUpdateQuantity: (id: string, nextQty: number) => void;
  onUpdateSellingPrice: (id: string, nextPrice: number) => void;
  onRemoveItem: (id: string) => void;
}

const Step2ItemRow: React.FC<Step2ItemRowProps> = ({
  item,
  onUpdateQuantity,
  onUpdateSellingPrice,
  onRemoveItem,
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

  const [qtyDraft, setQtyDraft] = useState(String(item.quantity));
  const [priceDraft, setPriceDraft] = useState(String(item.sellingPrice));
  const [priceFocused, setPriceFocused] = useState(false);

  useEffect(() => {
    setQtyDraft(String(item.quantity));
  }, [item.quantity]);

  useEffect(() => {
    if (!priceFocused) {
      setPriceDraft(String(item.sellingPrice));
    }
  }, [item.sellingPrice, priceFocused]);

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

  const quickPresets = [
    { label: 'Min', value: costPrice },
    { label: '+10%', value: Math.round(costPrice * 1.1) },
    { label: '+20%', value: Math.round(costPrice * 1.2) },
    { label: '+30%', value: Math.round(costPrice * 1.3) },
  ];

  const coverUrl =
    item.variant?.images?.[0]?.url || item.product.images?.[0]?.url || '';

  return (
    <div
      className={`bg-white/95 border rounded-xl p-3 space-y-2.5 ${
        isPriceBelowMin || isOverStock
          ? 'border-rose-300'
          : 'border-slate-200/90'
      }`}
    >
      {/* Top Row: Image + Name + Metadata */}
      <div className="flex items-start gap-2.5">
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
          <div className="flex items-start justify-between gap-2">
            <h4 className="text-[13px] font-semibold text-slate-900 leading-snug line-clamp-2">
              {item.product.name}
            </h4>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onRemoveItem(item.id);
              }}
              aria-label={`Remove ${item.product.name}`}
              className="w-9 h-9 -mt-1 -mr-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center shrink-0 cursor-pointer transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center flex-wrap gap-1.5 text-[11px]">
            <span className="text-slate-500 font-medium">
              {item.variant?.sku || item.product.sku}
              {item.product.brandName ? ` · ${item.product.brandName}` : ''}
            </span>

            {item.variant && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-medium">
                <span
                  className="w-2 h-2 rounded-full border border-slate-300 shrink-0"
                  style={{ backgroundColor: item.variant.colorName.toLowerCase() }}
                />
                <span>{item.variant.colorName}</span>
              </span>
            )}

            <span
              className={`px-1.5 py-0.5 rounded font-semibold tabular-nums ${
                stockLimit <= 0 || isOverStock
                  ? 'bg-rose-50 text-rose-700'
                  : stockLimit <= (item.product.lowStockThreshold || 5)
                  ? 'bg-amber-50 text-amber-800'
                  : 'bg-emerald-50 text-emerald-700'
              }`}
            >
              {stockLimit <= 0
                ? 'Out of stock'
                : stockLimit <= (item.product.lowStockThreshold || 5)
                ? `Only ${stockLimit} left`
                : `${stockLimit} in stock`}
            </span>
          </div>
        </div>
      </div>

      {/* Quantity & Selling Price Controls */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2.5 pt-2 border-t border-slate-100 items-start">
        <div className="space-y-1">
          <label
            htmlFor={`new-order-qty-${item.id}`}
            className="text-[11px] font-medium text-slate-500 block"
          >
            Quantity
          </label>
          <div className="flex items-center border border-slate-200 rounded-xl h-[40px] bg-slate-50/70 overflow-hidden max-w-[144px]">
            <button
              type="button"
              aria-label="Decrease quantity"
              disabled={item.quantity <= 1}
              onPointerDown={() => handleStepperPointerDown(-1)}
              onPointerUp={clearStepperTimers}
              onPointerLeave={clearStepperTimers}
              onPointerCancel={clearStepperTimers}
              onClick={() => handleStepperClick(-1)}
              className="w-10 h-full flex items-center justify-center text-slate-600 hover:bg-slate-200/60 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer select-none"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <input
              id={`new-order-qty-${item.id}`}
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
              className="w-10 h-full flex items-center justify-center text-slate-600 hover:bg-slate-200/60 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer select-none"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          {isOverStock && (
            <p className="text-[11px] font-semibold text-rose-600 tabular-nums">
              {stockLimit <= 0
                ? 'This product is out of stock.'
                : `Exceeds stock — only ${stockLimit} available.`}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-1 text-[11px]">
            <label
              htmlFor={`new-order-price-${item.id}`}
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
              id={`new-order-price-${item.id}`}
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
              Cannot be below minimum ৳{costPrice.toLocaleString('en-BD')}
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
        <span className="text-[11px] text-slate-400 mr-0.5">Quick price:</span>
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
              className={`min-h-[30px] px-2.5 rounded-lg text-[11px] font-semibold transition-colors cursor-pointer tabular-nums ${
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

      {/* Live Profit & Margin Summary Line */}
      <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap text-[11.5px] tabular-nums">
        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-slate-600">
          <span>
            Wholesale{' '}
            <strong className="text-slate-800">
              ৳{lineCost.toLocaleString('en-BD')}
            </strong>
            <span className="text-slate-400"> ×{item.quantity}</span>
          </span>
          <span className="text-slate-300">·</span>
          <span>
            Selling{' '}
            <strong className="text-slate-800">
              ৳{lineSelling.toLocaleString('en-BD')}
            </strong>
            <span className="text-slate-400"> ×{item.quantity}</span>
          </span>
        </div>

        <span
          className={`font-bold ${
            lineProfit >= 0 ? 'text-emerald-700' : 'text-rose-600'
          }`}
        >
          {lineProfit >= 0 ? '+' : ''}৳{lineProfit.toLocaleString('en-BD')} (
          {marginPct.toFixed(1).replace(/\.0$/, '')}%)
        </span>
      </div>
    </div>
  );
};

export const CreateOrderModal: React.FC<CreateOrderModalProps> = ({
  isOpen,
  onClose,
  user,
  onOrderCreated,
  onOrderSubmitted,
  initialProduct = null,
  initialVariant = null,
  cartItems = null,
  onOpenLockedModal,
}) => {
  const reducedMotion = !!useReducedMotion();
  const { isOnline } = useNetwork();
  const { canAccessFullApp } = useAccess(user);

  // Dynamic VisualViewport height & offset for mobile soft-keyboard safety
  const [viewportStyle, setViewportStyle] = useState<{
    height?: string;
    top?: string;
  }>({});

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) {
      setViewportStyle({ height: '100dvh', top: '0px' });
      return;
    }
    const syncViewport = () => {
      setViewportStyle({
        height: `${Math.round(vv.height)}px`,
        top: `${Math.round(vv.offsetTop)}px`,
      });
    };
    syncViewport();
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    return () => {
      vv.removeEventListener('resize', syncViewport);
      vv.removeEventListener('scroll', syncViewport);
    };
  }, [isOpen]);

  // Notify ResellerDashboard to hide shop header & bottom navigation while full-screen order flow is open
  useEffect(() => {
    if (!isOpen) return;
    window.dispatchEvent(
      new CustomEvent('sky_fullscreen_overlay', { detail: { open: true } })
    );
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = prevOverflow;
      window.dispatchEvent(
        new CustomEvent('sky_fullscreen_overlay', { detail: { open: false } })
      );
    };
  }, [isOpen]);

  // Wizard Steps & Core Selection State
  const [step, setStep] = useState<OrderStep>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<OrderStep>(1);
  const [selectedItems, setSelectedItems] = useState<CartItem[]>([]);

  // Catalog & Background Data
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(
    null
  );
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [pastOrders, setPastOrders] = useState<Order[]>([]);
  const [savedCustomersList, setSavedCustomersList] = useState<
    SavedCustomerProfile[]
  >([]);
  const [loadingData, setLoadingData] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Step 1 Filters & View Mode
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [variantPickerProduct, setVariantPickerProduct] =
    useState<Product | null>(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  // Step 2 Bulk Tools
  const [showBulkMarginInput, setShowBulkMarginInput] = useState(false);
  const [bulkMarginPct, setBulkMarginPct] = useState('20');
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

  // Step 3 Customer & Bangladesh Geo
  const [customer, setCustomer] = useState<CartCustomerDetails>(
    EMPTY_CUSTOMER_DETAILS
  );
  const [customerErrors, setCustomerErrors] = useState<Record<string, string>>(
    {}
  );
  const [advanceDraft, setAdvanceDraft] = useState<string>('');
  const [saveThisCustomer, setSaveThisCustomer] = useState<boolean>(true);
  const [divisions, setDivisions] = useState<BdDivision[]>([]);
  const [districts, setDistricts] = useState<BdDistrict[]>([]);
  const [upazilas, setUpazilas] = useState<BdUpazilaThana[]>([]);

  // Draft Autosave & Notices
  const [pendingDraft, setPendingDraft] = useState<OrderDraftPayload | null>(
    null
  );
  const [draftBannerInfo, setDraftBannerInfo] = useState<string | null>(null);
  const [draftNotices, setDraftNotices] = useState<string[]>([]);
  const draftHydratedRef = useRef<boolean>(false);

  // Step 4 Confirm & Success
  const [showConfirmSheet, setShowConfirmSheet] = useState(false);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const placingOrderLockRef = useRef(false);
  const [orderSubmitError, setOrderSubmitError] = useState('');
  const [orderSuccess, setOrderSuccess] = useState<OrderSuccessData | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Scroll page to top smoothly whenever step changes
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [step, orderSuccess]);

  // Load saved favorites & saved customers for this reseller
  useEffect(() => {
    if (!isOpen) return;
    try {
      const favRaw = localStorage.getItem(FAVORITES_KEY(user.uid));
      if (favRaw) {
        const parsed = JSON.parse(favRaw);
        if (Array.isArray(parsed)) setFavoriteIds(parsed);
      }
    } catch {
      // ignore storage errors
    }
    setSavedCustomersList(loadSavedCustomers(user.uid));
  }, [isOpen, user.uid]);

  const toggleFavorite = (productId: string) => {
    triggerHaptic('light');
    setFavoriteIds((prev) => {
      const exists = prev.includes(productId);
      const next = exists
        ? prev.filter((id) => id !== productId)
        : [productId, ...prev];
      try {
        localStorage.setItem(FAVORITES_KEY(user.uid), JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  // Load BD Geocode Lists
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

  // Fetch products, categories, settings, wallet, and reseller's past orders
  const fetchInitialData = useCallback(async () => {
    setLoadingData(true);
    setLoadError(null);
    try {
      const pQuery = query(
        collection(db, 'products'),
        where('status', '==', 'active')
      );
      const cQuery = query(
        collection(db, 'categories'),
        where('status', '==', 'active')
      );
      const oQuery = query(
        collection(db, 'orders'),
        where('resellerId', '==', user.uid)
      );

      const [pSnap, cSnap, sSnap, wSnap, oSnap] = await Promise.all([
        getDocs(pQuery),
        getDocs(cQuery),
        getDoc(doc(db, 'settings', 'general')),
        getDoc(doc(db, 'wallets', user.uid)),
        getDocs(oQuery),
      ]);

      const pList: Product[] = [];
      pSnap.forEach((docSnap) => {
        pList.push(normalizeProduct(docSnap.id, docSnap.data()));
      });
      setProducts(pList);

      const cList: Category[] = [];
      cSnap.forEach((docSnap) => {
        cList.push(
          Object.assign({ id: docSnap.id }, docSnap.data()) as unknown as Category
        );
      });
      setCategories(cList);

      if (sSnap.exists()) {
        setCompanySettings(sSnap.data() as CompanySettings);
      }

      if (wSnap.exists()) {
        setWalletBalance((wSnap.data() as Wallet).balance || 0);
      }

      const oList: Order[] = [];
      oSnap.forEach((docSnap) => {
        oList.push(
          Object.assign({ id: docSnap.id }, docSnap.data()) as unknown as Order
        );
      });
      oList.sort(
        (a, b) =>
          getOrderTimestampMs(b.createdAt) - getOrderTimestampMs(a.createdAt)
      );
      setPastOrders(oList);
    } catch (err) {
      console.error('Error loading new order catalog & data:', err);
      setLoadError(
        'Could not load catalog and order settings. Check your connection and retry.'
      );
    } finally {
      setLoadingData(false);
    }
  }, [user.uid]);

  // Helper to build a CartItem from product + optional variant
  const buildCartItem = (
    product: Product,
    variant: ProductVariant | null,
    qty = 1,
    customPrice?: number
  ): CartItem => {
    const vAdj = variant ? variant.priceAdjustment || 0 : 0;
    const costPrice = (product.resellerPrice || 0) + vAdj;
    const suggested = Math.max(costPrice, (product.retailPrice || 0) + vAdj);
    return {
      id: `${product.id}_${variant ? variant.id : 'default'}`,
      product,
      variant,
      quantity: Math.max(1, qty),
      sellingPrice:
        typeof customPrice === 'number' && !isNaN(customPrice)
          ? customPrice
          : suggested,
    };
  };

  // Initialize state when modal opens
  useEffect(() => {
    if (!isOpen) {
      draftHydratedRef.current = false;
      setShowConfirmSheet(false);
      setVariantPickerProduct(null);
      setIsScannerOpen(false);
      return;
    }

    setOrderSuccess(null);
    setOrderSubmitError('');
    setCustomerErrors({});
    setSearchTerm('');
    setSelectedCategory('All');
    setDraftNotices([]);
    setDraftBannerInfo(null);
    setPendingDraft(null);
    draftHydratedRef.current = false;

    fetchInitialData();

    if (cartItems && cartItems.length > 0) {
      setSelectedItems(cartItems);
      setStep(2);
      setMaxReachedStep(2);
      setCustomer(EMPTY_CUSTOMER_DETAILS);
      setAdvanceDraft('');
      draftHydratedRef.current = true;
      return;
    }

    if (initialProduct) {
      let chosenVariant = initialVariant || null;
      if (
        !chosenVariant &&
        initialProduct.hasVariants &&
        initialProduct.variants &&
        initialProduct.variants.length > 0
      ) {
        const activeVars = initialProduct.variants.filter(
          (v) => v.status === 'active' && (v.stock || 0) > 0
        );
        if (activeVars.length > 0) {
          chosenVariant = activeVars[0];
        }
      }
      setSelectedItems([buildCartItem(initialProduct, chosenVariant, 1)]);
      setStep(2);
      setMaxReachedStep(2);
      setCustomer(EMPTY_CUSTOMER_DETAILS);
      setAdvanceDraft('');
      draftHydratedRef.current = true;
      return;
    }

    // Standard "New order": check for saved draft in localStorage
    setSelectedItems([]);
    setCustomer(EMPTY_CUSTOMER_DETAILS);
    setAdvanceDraft('');
    setStep(1);
    setMaxReachedStep(1);

    try {
      const rawDraft = localStorage.getItem(DRAFT_KEY(user.uid));
      if (rawDraft) {
        const parsed = JSON.parse(rawDraft) as OrderDraftPayload;
        if (
          parsed &&
          parsed.version === 1 &&
          (parsed.items?.length > 0 ||
            parsed.customer?.name ||
            parsed.customer?.mobile)
        ) {
          setPendingDraft(parsed);
          setCustomer({ ...EMPTY_CUSTOMER_DETAILS, ...(parsed.customer || {}) });
          setAdvanceDraft(parsed.advanceDraft || '');
          setDraftBannerInfo(`Saved ${formatDraftAge(parsed.updatedAt)}`);
        } else {
          draftHydratedRef.current = true;
        }
      } else {
        draftHydratedRef.current = true;
      }
    } catch {
      draftHydratedRef.current = true;
    }
  }, [isOpen, initialProduct, initialVariant, cartItems, user.uid, fetchInitialData]);

  // Hydrate pending draft items once live products finish loading, dropping unavailable/out-of-stock items gracefully
  useEffect(() => {
    if (!isOpen || loadingData || !pendingDraft) return;

    const productMap = new Map<string, Product>();
    products.forEach((p) => productMap.set(p.id, p));

    const notices: string[] = [];
    const hydratedItems: CartItem[] = [];

    for (const snap of pendingDraft.items || []) {
      const liveProd = productMap.get(snap.productId);
      if (!liveProd || liveProd.status !== 'active') {
        notices.push('A product from your saved draft is no longer available and was removed.');
        continue;
      }

      let liveVar: ProductVariant | null = null;
      let liveStock = liveProd.stock || 0;

      if (snap.variantId) {
        liveVar =
          (liveProd.variants || []).find(
            (v) => v.id === snap.variantId && v.status === 'active'
          ) || null;
        if (!liveVar) {
          notices.push(
            `A color variant of "${liveProd.name}" is no longer available.`
          );
          continue;
        }
        liveStock = liveVar.stock || 0;
      }

      if (liveStock <= 0) {
        notices.push(`"${liveProd.name}" is now out of stock and was removed from your draft.`);
        continue;
      }

      const clampedQty = Math.min(liveStock, Math.max(1, snap.quantity || 1));
      if (clampedQty < snap.quantity) {
        notices.push(
          `Adjusted "${liveProd.name}" quantity to available stock (${liveStock}).`
        );
      }

      hydratedItems.push(
        buildCartItem(liveProd, liveVar, clampedQty, snap.sellingPrice)
      );
    }

    if (notices.length > 0) {
      setDraftNotices(notices);
    }

    setSelectedItems(hydratedItems);
    const targetStep: OrderStep =
      hydratedItems.length > 0 && pendingDraft.step >= 2
        ? pendingDraft.step
        : 1;
    setStep(targetStep);
    setMaxReachedStep(targetStep);
    setPendingDraft(null);
    draftHydratedRef.current = true;
  }, [isOpen, loadingData, pendingDraft, products]);

  // Keep selectedItems synchronized with refreshed product list (handles stock drops or inactive products)
  useEffect(() => {
    if (!isOpen || loadingData || products.length === 0 || !draftHydratedRef.current)
      return;

    const productMap = new Map<string, Product>();
    products.forEach((p) => productMap.set(p.id, p));

    setSelectedItems((prev) => {
      if (prev.length === 0) return prev;
      let changed = false;
      const notices: string[] = [];
      const next: CartItem[] = [];

      for (const item of prev) {
        const liveProd = productMap.get(item.product.id);
        if (!liveProd || liveProd.status !== 'active') {
          notices.push(`Removed "${item.product.name}" — no longer active.`);
          changed = true;
          continue;
        }
        let liveVar = item.variant;
        let liveStock = liveProd.stock || 0;
        if (item.variant) {
          const foundVar = (liveProd.variants || []).find(
            (v) => v.id === item.variant?.id && v.status === 'active'
          );
          if (!foundVar) {
            notices.push(
              `Removed "${liveProd.name}" (${item.variant.colorName}) — variant unavailable.`
            );
            changed = true;
            continue;
          }
          liveVar = foundVar;
          liveStock = foundVar.stock || 0;
        }
        if (liveStock <= 0) {
          notices.push(`Removed "${liveProd.name}" — out of stock.`);
          changed = true;
          continue;
        }
        if (liveProd !== item.product || liveVar !== item.variant) {
          changed = true;
        }
        next.push({ ...item, product: liveProd, variant: liveVar });
      }

      if (notices.length > 0) {
        setDraftNotices((n) => [...n, ...notices]);
      }
      return changed ? next : prev;
    });
  }, [isOpen, loadingData, products]);

  // Draft Autosave (saved to localStorage whenever hydrated & not in cart/buy-now/success)
  useEffect(() => {
    if (!isOpen || !draftHydratedRef.current || orderSuccess) return;
    if (cartItems && cartItems.length > 0) return;

    const hasContent =
      selectedItems.length > 0 ||
      customer.name.trim().length > 0 ||
      customer.mobile.trim().length > 0 ||
      customer.address.trim().length > 0;

    try {
      if (!hasContent) {
        localStorage.removeItem(DRAFT_KEY(user.uid));
        return;
      }
      const payload: OrderDraftPayload = {
        version: 1,
        step,
        items: selectedItems.map((it) => ({
          id: it.id,
          productId: it.product.id,
          variantId: it.variant ? it.variant.id : null,
          quantity: it.quantity,
          sellingPrice: it.sellingPrice,
        })),
        customer,
        advanceDraft,
        updatedAt: Date.now(),
      };
      localStorage.setItem(DRAFT_KEY(user.uid), JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }
  }, [
    isOpen,
    orderSuccess,
    cartItems,
    step,
    selectedItems,
    customer,
    advanceDraft,
    user.uid,
  ]);

  const handleDiscardDraft = () => {
    triggerHaptic('light');
    try {
      localStorage.removeItem(DRAFT_KEY(user.uid));
    } catch {
      // ignore
    }
    setSelectedItems([]);
    setCustomer(EMPTY_CUSTOMER_DETAILS);
    setCustomerErrors({});
    setAdvanceDraft('');
    setDraftBannerInfo(null);
    setDraftNotices([]);
    setStep(1);
    setMaxReachedStep(1);
  };

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
        selectedItems,
        customer.districtName,
        advanceDraft,
        companySettings
      ),
    [selectedItems, customer.districtName, advanceDraft, companySettings]
  );

  // Merge localStorage saved customers + unique recent customers from past Firestore orders
  const mergedSavedCustomers = useMemo<SavedCustomerProfile[]>(() => {
    const byPhone = new Map<string, SavedCustomerProfile>();

    for (const saved of savedCustomersList) {
      const key = normalizeBdPhoneKey(saved.mobile);
      if (key) byPhone.set(key, saved);
    }

    for (const ord of pastOrders) {
      const phone = normalizeBdPhone(ord.customerPhone || '');
      const key = normalizeBdPhoneKey(phone);
      if (!key || !ord.customerName) continue;
      if (byPhone.has(key)) continue;

      byPhone.set(key, {
        id: `ord_${ord.id}`,
        name: ord.customerName,
        mobile: phone,
        altMobile: ord.customerAltPhone || '',
        divisionId: '',
        divisionName: ord.customerDivision || '',
        districtId: '',
        districtName: ord.customerDistrict || '',
        upazilaId: '',
        upazilaName: ord.customerUpazila || '',
        address: ord.customerAddress || '',
        courierNote: ord.courierNote || ord.specialInstructions || '',
        source: 'recent',
        lastOrderedAtMs: getOrderTimestampMs(ord.createdAt),
      });
    }

    return Array.from(byPhone.values());
  }, [savedCustomersList, pastOrders]);

  // Select Saved Customer -> resolve Bangladesh geo IDs if only names are available from past orders
  const handleSelectSavedCustomer = async (profile: SavedCustomerProfile) => {
    triggerHaptic('light');
    let divId = profile.divisionId;
    let divName = profile.divisionName;
    let distId = profile.districtId;
    let distName = profile.districtName;
    let upaId = profile.upazilaId;
    let upaName = profile.upazilaName;

    try {
      const allDivs = divisions.length > 0 ? divisions : await getDivisions();
      if (!divId && divName) {
        const matchedDiv = allDivs.find(
          (d) => d.name.trim().toLowerCase() === divName.trim().toLowerCase()
        );
        if (matchedDiv) {
          divId = matchedDiv.id;
          divName = matchedDiv.name;
        }
      }
      if (divId && !distId && distName) {
        const divDistricts = await getDistricts(divId);
        const matchedDist = divDistricts.find(
          (d) => d.name.trim().toLowerCase() === distName.trim().toLowerCase()
        );
        if (matchedDist) {
          distId = matchedDist.id;
          distName = matchedDist.name;
        }
      }
      if (distId && !upaId && upaName) {
        const distUpazilas = await getUpazilasAndThanas(distId);
        const matchedUpa = distUpazilas.find(
          (u) => u.name.trim().toLowerCase() === upaName.trim().toLowerCase()
        );
        if (matchedUpa) {
          upaId = matchedUpa.id;
          upaName = matchedUpa.name;
        }
      }
    } catch {
      // keep existing names if lookup fails
    }

    setCustomer({
      name: profile.name,
      mobile: profile.mobile,
      altMobile: profile.altMobile || '',
      divisionId: divId,
      divisionName: divName,
      districtId: distId,
      districtName: distName,
      upazilaId: upaId,
      upazilaName: upaName,
      address: profile.address,
      courierNote: profile.courierNote || '',
    });
    setCustomerErrors({});
  };

  // Duplicate Order Warning (Same mobile + any selected product in the last 24h)
  const duplicateOrderWarning = useMemo(() => {
    const phoneKey = normalizeBdPhoneKey(customer.mobile);
    if (phoneKey.length < 10 || selectedItems.length === 0) return null;

    const selectedProdIds = new Set(selectedItems.map((i) => i.product.id));
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;

    for (const ord of pastOrders) {
      if (ord.status === 'cancelled') continue;
      const ordPhoneKey = normalizeBdPhoneKey(ord.customerPhone || '');
      if (ordPhoneKey !== phoneKey) continue;
      if (!selectedProdIds.has(ord.productId)) continue;
      const ordMs = getOrderTimestampMs(ord.createdAt);
      if (ordMs >= cutoffMs) {
        const hrsAgo = Math.max(
          1,
          Math.round((Date.now() - ordMs) / (60 * 60 * 1000))
        );
        return `Duplicate order alert: ${
          ord.customerName || phoneKey
        } already ordered "${ord.productName}" ${hrsAgo}h ago (${
          ord.orderNumber
        }). Verify before placing another order.`;
      }
    }
    return null;
  }, [customer.mobile, selectedItems, pastOrders]);

  // Step 1 Derived Lists: Categories, Recently Ordered, Favourites, Filtered Catalog
  const categoryList = useMemo(() => {
    const map = new Map<string, string>();
    categories.forEach((c) => {
      if (c.name && c.name.trim()) {
        map.set(c.name.trim().toLowerCase(), c.name.trim());
      }
    });
    products.forEach((p) => {
      if (p.categoryName && p.categoryName.trim()) {
        const k = p.categoryName.trim().toLowerCase();
        if (!map.has(k)) map.set(k, p.categoryName.trim());
      }
    });
    return ['All', ...Array.from(map.values())];
  }, [categories, products]);

  const recentlyOrderedProducts = useMemo(() => {
    const prodMap = new Map<string, Product>();
    products.forEach((p) => prodMap.set(p.id, p));

    const seen = new Set<string>();
    const recent: Product[] = [];
    for (const ord of pastOrders) {
      if (seen.has(ord.productId)) continue;
      const p = prodMap.get(ord.productId);
      if (p && p.status === 'active') {
        seen.add(ord.productId);
        recent.push(p);
        if (recent.length >= 10) break;
      }
    }
    return recent;
  }, [pastOrders, products]);

  const favouriteProducts = useMemo(() => {
    if (favoriteIds.length === 0) return [];
    const prodMap = new Map<string, Product>();
    products.forEach((p) => prodMap.set(p.id, p));
    return favoriteIds
      .map((id) => prodMap.get(id))
      .filter((p): p is Product => Boolean(p && p.status === 'active'));
  }, [favoriteIds, products]);

  const filteredProducts = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return products.filter((p) => {
      if (selectedCategory !== 'All') {
        const cat = (p.categoryName || 'General').trim().toLowerCase();
        if (cat !== selectedCategory.toLowerCase()) return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.brandName || '').toLowerCase().includes(q) ||
        (p.categoryName || '').toLowerCase().includes(q) ||
        (p.barcodeValue || '').toLowerCase().includes(q) ||
        (p.qrValue || '').toLowerCase().includes(q)
      );
    });
  }, [products, selectedCategory, searchTerm]);

  // Add / Increment / Update Selected Items
  const addProductOrVariant = (product: Product, variant: ProductVariant | null) => {
    const stockLimit = variant ? variant.stock || 0 : product.stock || 0;
    if (stockLimit <= 0) return;

    const itemId = `${product.id}_${variant ? variant.id : 'default'}`;
    triggerHaptic('light');

    setSelectedItems((prev) => {
      const existingIdx = prev.findIndex((i) => i.id === itemId);
      if (existingIdx > -1) {
        const existing = prev[existingIdx];
        if (existing.quantity >= stockLimit) return prev;
        const copy = [...prev];
        copy[existingIdx] = {
          ...existing,
          quantity: existing.quantity + 1,
        };
        return copy;
      }
      return [...prev, buildCartItem(product, variant, 1)];
    });
  };

  const handleAddProductClick = (product: Product) => {
    const activeVariants =
      product.hasVariants && product.variants
        ? product.variants.filter((v) => v.status === 'active')
        : [];

    if (activeVariants.length > 0) {
      if (activeVariants.length === 1) {
        addProductOrVariant(product, activeVariants[0]);
      } else {
        triggerHaptic('light');
        setVariantPickerProduct(product);
      }
      return;
    }

    addProductOrVariant(product, null);
  };

  const handleScannedProduct = (matched: Product) => {
    const normalized = normalizeProduct(matched.id, matched);
    if (normalized.status !== 'active') {
      setDraftNotices([
        `Scanned "${normalized.name}", which is currently inactive.`,
      ]);
      return;
    }
    const stock = normalized.stock || 0;
    if (stock <= 0) {
      setSearchTerm(normalized.sku || normalized.name);
      setDraftNotices([`"${normalized.name}" is currently out of stock.`]);
      return;
    }
    handleAddProductClick(normalized);
  };

  const updateItemQuantity = (id: string, nextQty: number) => {
    setSelectedItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, quantity: Math.max(1, nextQty) } : it
      )
    );
  };

  const updateItemSellingPrice = (id: string, nextPrice: number) => {
    setSelectedItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, sellingPrice: Math.max(0, nextPrice) } : it
      )
    );
  };

  const removeSelectedItem = (id: string) => {
    setSelectedItems((prev) => prev.filter((it) => it.id !== id));
  };

  // Step 2 Bulk Price Helpers
  const handleApplyBulkMargin = () => {
    const pct = parseFloat(bulkMarginPct);
    if (isNaN(pct) || pct < 0) return;
    triggerHaptic('light');
    setSelectedItems((prev) =>
      prev.map((item) => {
        const cost = getItemCost(item);
        return { ...item, sellingPrice: Math.round(cost * (1 + pct / 100)) };
      })
    );
    setShowBulkMarginInput(false);
    setShareFeedback(`Applied +${pct}% margin to all items.`);
    setTimeout(() => setShareFeedback(null), 2400);
  };

  const handleResetSuggestedPrices = () => {
    triggerHaptic('light');
    setSelectedItems((prev) =>
      prev.map((item) => ({
        ...item,
        sellingPrice: getItemSuggestedPrice(item),
      }))
    );
    setShareFeedback('Reset all items to suggested retail price.');
    setTimeout(() => setShareFeedback(null), 2400);
  };

  // Share Customer Quote (NO wholesale price or reseller profit)
  const handleShareQuote = async () => {
    if (selectedItems.length === 0) return;
    triggerHaptic('light');
    const shopTitle = user.shopName || user.fullName || 'Our Shop';
    const quoteText = buildCustomerQuoteText({
      shopTitle,
      items: selectedItems,
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
        setShareFeedback('Quote shared with customer.');
        setTimeout(() => setShareFeedback(null), 2500);
        return;
      }
    } catch {
      // Fallback to clipboard
    }

    try {
      await navigator.clipboard.writeText(quoteText);
      setShareFeedback('Customer quote copied to clipboard.');
      setTimeout(() => setShareFeedback(null), 2500);
    } catch {
      setShareFeedback('Could not copy quote.');
      setTimeout(() => setShareFeedback(null), 2500);
    }
  };

  // Step Navigation Helpers
  const goToStep = (nextStep: OrderStep) => {
    triggerHaptic('light');
    setStep(nextStep);
    setMaxReachedStep((prev) => (nextStep > prev ? nextStep : prev));
  };

  const handleBackNavigation = useCallback(() => {
    if (isPlacingOrder) return;
    if (showConfirmSheet) {
      setShowConfirmSheet(false);
      return;
    }
    if (variantPickerProduct) {
      setVariantPickerProduct(null);
      return;
    }
    if (isScannerOpen) {
      setIsScannerOpen(false);
      return;
    }
    if (orderSuccess) {
      setOrderSuccess(null);
      onClose();
      return;
    }
    if (step > 1) {
      triggerHaptic('light');
      setStep((s) => Math.max(1, s - 1) as OrderStep);
      return;
    }
    onClose();
  }, [
    isPlacingOrder,
    showConfirmSheet,
    variantPickerProduct,
    isScannerOpen,
    orderSuccess,
    step,
    onClose,
  ]);

  // Listen to Escape key & Android Hardware Back button event from ResellerDashboard
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleBackNavigation();
      }
    };
    const handleHardwareBack = () => {
      handleBackNavigation();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('sky_fullscreen_overlay_back', handleHardwareBack);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(
        'sky_fullscreen_overlay_back',
        handleHardwareBack
      );
    };
  }, [isOpen, handleBackNavigation]);

  const handleStep3Next = () => {
    const errs = validateCustomerDetailsMap(customer);
    setCustomerErrors(errs);
    if (Object.keys(errs).length > 0) {
      triggerHaptic('medium');
      return;
    }
    if (saveThisCustomer) {
      const updated = upsertSavedCustomer(user.uid, customer);
      setSavedCustomersList(updated);
    }
    goToStep(4);
  };

  const handleOpenConfirmation = () => {
    if (!canAccessFullApp) {
      onOpenLockedModal?.('Creating Orders');
      return;
    }
    if (selectedItems.length === 0 || hasInvalidPrices || hasInvalidStock) return;
    const errs = validateCustomerDetailsMap(customer);
    setCustomerErrors(errs);
    if (Object.keys(errs).length > 0) {
      setStep(3);
      return;
    }
    setOrderSubmitError('');
    setShowConfirmSheet(true);
  };

  // Place Order via Firestore Transaction (Exact Stock, Price, Commission & COD/Wallet Rules)
  const handleConfirmPlaceOrder = async () => {
    if (placingOrderLockRef.current || isPlacingOrder) return;
    if (!canAccessFullApp) {
      onOpenLockedModal?.('Creating Orders');
      return;
    }
    if (!isOnline) {
      setOrderSubmitError(
        'No internet connection. Please reconnect and try again.'
      );
      return;
    }
    if (selectedItems.length === 0 || hasInvalidPrices || hasInvalidStock) {
      setOrderSubmitError(
        'Please resolve item price or stock issues before placing the order.'
      );
      return;
    }
    const errs = validateCustomerDetailsMap(customer);
    if (Object.keys(errs).length > 0) {
      setCustomerErrors(errs);
      setShowConfirmSheet(false);
      setStep(3);
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
        // 1. Verify every selected product is active and in stock from server
        const productDocs = await Promise.all(
          selectedItems.map((item) =>
            transaction.get(doc(db, 'products', item.product.id))
          )
        );

        for (let i = 0; i < selectedItems.length; i++) {
          const item = selectedItems[i];
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

        // 2. Write order document(s) using exact price/commission rules
        for (let index = 0; index < selectedItems.length; index++) {
          const item = selectedItems[index];
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
            selectedItems.length > 1 ? `-${index + 1}` : ''
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

      if (saveThisCustomer) {
        const updated = upsertSavedCustomer(user.uid, customer);
        setSavedCustomersList(updated);
      }

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

      // Clear draft cleanly
      try {
        localStorage.removeItem(DRAFT_KEY(user.uid));
      } catch {
        // ignore
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
      setDraftBannerInfo(null);
      triggerHaptic('heavy');
      onOrderSubmitted?.();
    } catch (err: any) {
      console.error('Order creation error:', err);
      setOrderSubmitError(
        err?.message || 'Failed to place order. Please try again.'
      );
    } finally {
      placingOrderLockRef.current = false;
      setIsPlacingOrder(false);
    }
  };

  const handleStartAnotherOrder = () => {
    triggerHaptic('light');
    setOrderSuccess(null);
    setSelectedItems([]);
    setCustomer(EMPTY_CUSTOMER_DETAILS);
    setCustomerErrors({});
    setAdvanceDraft('');
    setDraftBannerInfo(null);
    setDraftNotices([]);
    setStep(1);
    setMaxReachedStep(1);
    fetchInitialData();
  };

  if (!isOpen) return null;

  // Map product selection count for quick Step 1 badges
  const getProductSelectedQty = (productId: string) =>
    selectedItems
      .filter((i) => i.product.id === productId)
      .reduce((acc, i) => acc + i.quantity, 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New order"
      style={viewportStyle}
      className="fixed inset-x-0 z-50 flex justify-center bg-slate-100/90 backdrop-blur-xs overflow-hidden"
    >
      {/* True Full-Screen Mobile-First Container (Centered max-w-2xl matching ResellerDashboard shell) */}
      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.18 }}
        className="w-full max-w-2xl h-full bg-[#F8FAFC] flex flex-col justify-between md:border-x border-slate-200/80 shadow-2xl overflow-hidden"
      >
        {/* 1. SLIM STICKY HEADER + 4-STEP INDICATOR */}
        <header className="shrink-0 bg-white/95 backdrop-blur-md border-b border-slate-200/80 pt-[env(safe-area-inset-top,0px)] z-30">
          <div className="px-3 sm:px-4 h-[52px] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={handleBackNavigation}
                aria-label={step > 1 && !orderSuccess ? 'Previous step' : 'Close new order'}
                className="w-11 h-11 -ml-2 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100 flex items-center justify-center shrink-0 cursor-pointer transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <h1 className="text-[16px] font-bold text-slate-900 leading-tight truncate">
                  New order
                </h1>
                <p className="text-[11.5px] text-slate-500 font-medium tabular-nums truncate">
                  {orderSuccess
                    ? `Order ${orderSuccess.primaryOrderNumber}`
                    : productCount > 0
                    ? `${productCount} ${productCount === 1 ? 'product' : 'products'} · ${pieceCount} ${pieceCount === 1 ? 'pc' : 'pcs'}`
                    : 'Choose products for your customer'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {selectedItems.length > 0 && canAccessFullApp && !orderSuccess && (
                <button
                  type="button"
                  onClick={handleShareQuote}
                  title="Share quote with customer"
                  className="min-h-[38px] px-2.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11.5px] font-semibold inline-flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span className="hidden min-[380px]:inline">Quote</span>
                </button>
              )}
              <button
                type="button"
                disabled={isPlacingOrder}
                onClick={onClose}
                aria-label="Close new order"
                className="w-10 h-10 rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 flex items-center justify-center cursor-pointer transition-colors disabled:opacity-40"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
          </div>

          {/* Step Indicator Strip */}
          {canAccessFullApp && !orderSuccess && (
            <nav
              aria-label="Order steps"
              className="px-3 sm:px-4 pb-2 flex items-center justify-between gap-1 overflow-x-auto scrollbar-none"
            >
              {STEPS.map((s, idx) => {
                const isCurrent = step === s.id;
                const isCompleted = step > s.id;
                const canJump =
                  s.id <= maxReachedStep ||
                  (s.id === 2 && selectedItems.length > 0);
                return (
                  <React.Fragment key={s.id}>
                    <button
                      type="button"
                      disabled={!canJump}
                      onClick={() => {
                        if (canJump && s.id !== step) {
                          if (step === 3 && s.id === 4) {
                            handleStep3Next();
                          } else {
                            goToStep(s.id);
                          }
                        }
                      }}
                      className={`min-h-[30px] px-2 rounded-lg text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition-colors shrink-0 ${
                        isCurrent
                          ? 'bg-slate-900 text-white cursor-default'
                          : isCompleted
                          ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100 cursor-pointer'
                          : canJump
                          ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer'
                          : 'text-slate-400 cursor-not-allowed'
                      }`}
                    >
                      <span
                        className={`w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center ${
                          isCurrent
                            ? 'bg-white/20 text-white'
                            : isCompleted
                            ? 'bg-emerald-600 text-white'
                            : 'bg-slate-200 text-slate-600'
                        }`}
                      >
                        {isCompleted ? <Check className="w-2.5 h-2.5" /> : s.id}
                      </span>
                      <span>{s.label}</span>
                    </button>
                    {idx < STEPS.length - 1 && (
                      <span
                        aria-hidden="true"
                        className="text-slate-300 text-[11px] shrink-0"
                      >
                        ·
                      </span>
                    )}
                  </React.Fragment>
                );
              })}
            </nav>
          )}
        </header>

        {/* 2. SINGLE PAGE SCROLLABLE BODY (No tiny inner scroll box!) */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-3 space-y-3"
        >
          {/* Pending / Locked Reseller Guard */}
          {!canAccessFullApp ? (
            <div className="h-full min-h-[340px] flex flex-col items-center justify-center text-center p-6 space-y-4">
              <div className="w-14 h-14 rounded-xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center">
                <Lock className="w-6 h-6" />
              </div>
              <div className="space-y-1 max-w-[280px]">
                <h2 className="text-[16px] font-bold text-slate-900">
                  Account Under Review
                </h2>
                <p className="text-[12.5px] text-slate-600 leading-relaxed">
                  Creating customer orders and viewing wholesale costs unlock automatically once your reseller account is approved.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenLockedModal?.('Creating Orders');
                }}
                className="h-[44px] px-5 rounded-xl bg-slate-900 text-white text-[12.5px] font-semibold cursor-pointer"
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
                onOrderCreated();
                onClose();
              }}
              secondaryLabel="New order"
              onSecondaryAction={handleStartAnotherOrder}
            />
          ) : loadingData && products.length === 0 ? (
            /* LOADING SKELETONS */
            <div className="space-y-2.5" aria-busy="true" aria-label="Loading products">
              <div className="h-11 bg-white rounded-xl border border-slate-200/80 animate-pulse" />
              {[1, 2, 3, 4, 5].map((n) => (
                <div
                  key={n}
                  className="bg-white border border-slate-200/80 rounded-xl p-3 flex items-center gap-3 animate-pulse"
                >
                  <div className="w-14 h-14 rounded-xl bg-slate-100 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 bg-slate-100 rounded w-3/4" />
                    <div className="h-3 bg-slate-100 rounded w-1/2" />
                    <div className="h-3 bg-slate-100 rounded w-1/3" />
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-slate-100 shrink-0" />
                </div>
              ))}
            </div>
          ) : loadError && products.length === 0 ? (
            /* ERROR STATE WITH RETRY */
            <div className="bg-white border border-rose-200 rounded-xl p-6 text-center space-y-3 mt-4">
              <AlertCircle className="w-7 h-7 text-rose-500 mx-auto" />
              <div className="space-y-1">
                <h2 className="text-[15px] font-bold text-slate-900">
                  Unable to load catalog
                </h2>
                <p className="text-[12.5px] text-slate-600">{loadError}</p>
              </div>
              <button
                type="button"
                onClick={fetchInitialData}
                className="h-[42px] px-5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[12.5px] font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Retry</span>
              </button>
            </div>
          ) : (
            <>
              {/* Draft Restored Notice */}
              {draftBannerInfo && (
                <div
                  role="status"
                  className="bg-blue-50/90 border border-blue-200 rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-[12px]"
                >
                  <div className="min-w-0">
                    <span className="font-bold text-blue-950">
                      Continue your draft
                    </span>
                    <span className="text-blue-700 ml-1.5">
                      ({draftBannerInfo})
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={handleDiscardDraft}
                      className="min-h-[30px] px-2.5 rounded-lg bg-white hover:bg-rose-50 border border-blue-200 hover:border-rose-300 text-rose-600 text-[11.5px] font-semibold cursor-pointer"
                    >
                      Discard draft
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraftBannerInfo(null)}
                      aria-label="Dismiss draft notice"
                      className="p-1 text-blue-600 hover:text-blue-900 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* Out-of-stock / Removed Items Notice */}
              {draftNotices.length > 0 && (
                <div
                  role="status"
                  className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 text-[12px] text-amber-900 flex items-start justify-between gap-2"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      {draftNotices.map((msg, i) => (
                        <p key={i}>{msg}</p>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDraftNotices([])}
                    aria-label="Dismiss alert"
                    className="p-1 text-amber-700 hover:text-amber-950 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Quote Share Feedback */}
              {shareFeedback && (
                <div
                  role="status"
                  className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 text-[12px] font-semibold text-emerald-800 flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4 shrink-0" />
                  <span>{shareFeedback}</span>
                </div>
              )}

              {/* ============================================================ */}
              {/* STEP 1: CHOOSE PRODUCTS                                      */}
              {/* ============================================================ */}
              {step === 1 && (
                <div className="space-y-3">
                  {/* Sticky Search + Scanner + Category Chips + View Toggle */}
                  <div className="sticky -top-3 z-20 -mx-3 sm:-mx-4 px-3 sm:px-4 pt-1 pb-2.5 bg-[#F8FAFC]/95 backdrop-blur-md border-b border-slate-200/70 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          placeholder="Search by product name, SKU, or brand..."
                          className="w-full h-[42px] pl-9 pr-8 rounded-xl bg-white border border-slate-200/90 text-[13px] text-slate-900 placeholder-slate-400 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                        />
                        {searchTerm && (
                          <button
                            type="button"
                            onClick={() => setSearchTerm('')}
                            aria-label="Clear search"
                            className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 flex items-center justify-center absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Barcode / QR Scanner Trigger (Existing QrScannerModal) */}
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          setIsScannerOpen(true);
                        }}
                        title="Scan barcode or QR"
                        aria-label="Scan barcode or QR"
                        className="w-[42px] h-[42px] rounded-xl bg-white border border-slate-200/90 hover:border-slate-300 text-slate-700 flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                      >
                        <QrCode className="w-4.5 h-4.5" />
                      </button>

                      {/* Grid / List Toggle */}
                      <div className="flex items-center bg-white border border-slate-200/90 rounded-xl p-0.5 shrink-0 h-[42px]">
                        <button
                          type="button"
                          onClick={() => setViewMode('list')}
                          aria-label="List view"
                          className={`w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${
                            viewMode === 'list'
                              ? 'bg-slate-900 text-white'
                              : 'text-slate-500 hover:text-slate-800'
                          }`}
                        >
                          <LayoutList className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewMode('grid')}
                          aria-label="Grid view"
                          className={`w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${
                            viewMode === 'grid'
                              ? 'bg-slate-900 text-white'
                              : 'text-slate-500 hover:text-slate-800'
                          }`}
                        >
                          <LayoutGrid className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Category Chips */}
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
                      {categoryList.map((cat) => {
                        const active =
                          selectedCategory.toLowerCase() === cat.toLowerCase();
                        return (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => {
                              triggerHaptic('light');
                              setSelectedCategory(cat);
                            }}
                            className={`min-h-[32px] px-3 rounded-lg text-[12px] font-semibold whitespace-nowrap transition-colors cursor-pointer shrink-0 ${
                              active
                                ? 'bg-slate-900 text-white'
                                : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            {cat}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Recently Ordered Row (Top Quick Strip) */}
                  {!searchTerm.trim() &&
                    selectedCategory === 'All' &&
                    recentlyOrderedProducts.length > 0 && (
                      <section className="space-y-1.5">
                        <div className="flex items-center justify-between px-0.5">
                          <h2 className="text-[12px] font-bold text-slate-700 flex items-center gap-1.5">
                            <History className="w-3.5 h-3.5 text-slate-500" />
                            <span>Recently ordered</span>
                          </h2>
                          <span className="text-[11px] text-slate-400">
                            Quick add
                          </span>
                        </div>
                        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                          {recentlyOrderedProducts.map((p) => {
                            const out = (p.stock || 0) <= 0;
                            const addedQty = getProductSelectedQty(p.id);
                            return (
                              <div
                                key={p.id}
                                className="w-[152px] shrink-0 bg-white border border-slate-200/90 rounded-xl p-2 flex flex-col justify-between gap-2"
                              >
                                <div className="flex items-start gap-2">
                                  <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden shrink-0">
                                    {p.images?.[0]?.url ? (
                                      <img
                                        src={p.images[0].url}
                                        alt={p.name}
                                        referrerPolicy="no-referrer"
                                        className="w-full h-full object-cover"
                                      />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center text-slate-400">
                                        <Package className="w-4 h-4" />
                                      </div>
                                    )}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-[11.5px] font-semibold text-slate-900 leading-tight line-clamp-2">
                                      {p.name}
                                    </p>
                                    <p className="text-[11px] font-bold text-blue-700 tabular-nums mt-0.5">
                                      ৳{p.resellerPrice.toLocaleString('en-BD')}
                                    </p>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  disabled={out}
                                  onClick={() => handleAddProductClick(p)}
                                  className={`w-full h-[32px] rounded-lg text-[11.5px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                                    out
                                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                      : addedQty > 0
                                      ? 'bg-emerald-600 text-white'
                                      : 'bg-slate-900 hover:bg-slate-800 text-white'
                                  }`}
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                  <span>
                                    {out
                                      ? 'Out'
                                      : addedQty > 0
                                      ? `Added (${addedQty})`
                                      : 'Add'}
                                  </span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}

                  {/* Favourites Row (Top Quick Strip) */}
                  {!searchTerm.trim() &&
                    selectedCategory === 'All' &&
                    favouriteProducts.length > 0 && (
                      <section className="space-y-1.5">
                        <div className="flex items-center justify-between px-0.5">
                          <h2 className="text-[12px] font-bold text-slate-700 flex items-center gap-1.5">
                            <Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500" />
                            <span>Favourites</span>
                          </h2>
                          <span className="text-[11px] text-slate-400">
                            {favouriteProducts.length} saved
                          </span>
                        </div>
                        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                          {favouriteProducts.map((p) => {
                            const out = (p.stock || 0) <= 0;
                            const addedQty = getProductSelectedQty(p.id);
                            return (
                              <div
                                key={p.id}
                                className="w-[152px] shrink-0 bg-white border border-slate-200/90 rounded-xl p-2 flex flex-col justify-between gap-2"
                              >
                                <div className="flex items-start gap-2">
                                  <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden shrink-0">
                                    {p.images?.[0]?.url ? (
                                      <img
                                        src={p.images[0].url}
                                        alt={p.name}
                                        referrerPolicy="no-referrer"
                                        className="w-full h-full object-cover"
                                      />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center text-slate-400">
                                        <Package className="w-4 h-4" />
                                      </div>
                                    )}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-[11.5px] font-semibold text-slate-900 leading-tight line-clamp-2">
                                      {p.name}
                                    </p>
                                    <p className="text-[11px] font-bold text-blue-700 tabular-nums mt-0.5">
                                      ৳{p.resellerPrice.toLocaleString('en-BD')}
                                    </p>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  disabled={out}
                                  onClick={() => handleAddProductClick(p)}
                                  className={`w-full h-[32px] rounded-lg text-[11.5px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                                    out
                                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                      : addedQty > 0
                                      ? 'bg-emerald-600 text-white'
                                      : 'bg-slate-900 hover:bg-slate-800 text-white'
                                  }`}
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                  <span>
                                    {out
                                      ? 'Out'
                                      : addedQty > 0
                                      ? `Added (${addedQty})`
                                      : 'Add'}
                                  </span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}

                  {/* Full-Height Catalog List or Grid (No inner scroll trap!) */}
                  <div className="flex items-center justify-between px-0.5 text-[11.5px] text-slate-500">
                    <span className="font-semibold">
                      Catalog ({filteredProducts.length})
                    </span>
                    {(searchTerm || selectedCategory !== 'All') && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchTerm('');
                          setSelectedCategory('All');
                        }}
                        className="text-blue-600 hover:underline font-semibold cursor-pointer"
                      >
                        Reset filters
                      </button>
                    )}
                  </div>

                  {filteredProducts.length === 0 ? (
                    <div className="bg-white border border-slate-200/90 rounded-xl p-8 text-center space-y-2.5">
                      <p className="text-[14px] font-bold text-slate-900">
                        No matching products
                      </p>
                      <p className="text-[12.5px] text-slate-500 max-w-[260px] mx-auto">
                        Try another product name, SKU, brand, or clear the active category filter.
                      </p>
                      {(searchTerm || selectedCategory !== 'All') && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchTerm('');
                            setSelectedCategory('All');
                          }}
                          className="h-[40px] px-4 rounded-xl bg-slate-900 text-white text-[12px] font-semibold cursor-pointer"
                        >
                          Show all products
                        </button>
                      )}
                    </div>
                  ) : viewMode === 'list' ? (
                    <div className="space-y-2">
                      {filteredProducts.map((p) => {
                        const cover = p.images?.[0]?.url;
                        const stockCount = p.stock || 0;
                        const lowThreshold = p.lowStockThreshold || 5;
                        const isOut = stockCount <= 0;
                        const isLow = !isOut && stockCount <= lowThreshold;
                        const isFav = favoriteIds.includes(p.id);
                        const addedQty = getProductSelectedQty(p.id);

                        return (
                          <div
                            key={p.id}
                            className={`bg-white/95 border rounded-xl p-2.5 flex items-center justify-between gap-2.5 min-h-[64px] transition-colors ${
                              addedQty > 0
                                ? 'border-emerald-400 bg-emerald-50/20'
                                : 'border-slate-200/90'
                            }`}
                          >
                            <div className="flex items-start gap-2.5 min-w-0 flex-1">
                              <div className="w-14 h-14 rounded-xl bg-slate-100 border border-slate-200/80 overflow-hidden shrink-0">
                                {cover ? (
                                  <img
                                    src={cover}
                                    alt={p.name}
                                    referrerPolicy="no-referrer"
                                    className={`w-full h-full object-cover ${
                                      isOut ? 'opacity-45 grayscale' : ''
                                    }`}
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-slate-400">
                                    <Package className="w-5 h-5" />
                                  </div>
                                )}
                              </div>

                              <div className="min-w-0 flex-1 space-y-1">
                                <h3 className="text-[13px] font-semibold text-slate-900 leading-snug line-clamp-2">
                                  {p.name}
                                </h3>
                                <p className="text-[11px] text-slate-500 truncate">
                                  {p.sku}
                                  {p.brandName ? ` · ${p.brandName}` : ''}
                                </p>
                                <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-[11.5px] tabular-nums">
                                  <span className="font-bold text-blue-700">
                                    Wholesale ৳
                                    {p.resellerPrice.toLocaleString('en-BD')}
                                  </span>
                                  <span className="text-slate-400">
                                    Retail ৳
                                    {p.retailPrice.toLocaleString('en-BD')}
                                  </span>
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10.5px] font-semibold ${
                                      isOut
                                        ? 'bg-rose-50 text-rose-700'
                                        : isLow
                                        ? 'bg-amber-50 text-amber-800'
                                        : 'bg-emerald-50 text-emerald-700'
                                    }`}
                                  >
                                    {isOut
                                      ? 'Out of stock'
                                      : isLow
                                      ? `Only ${stockCount} left`
                                      : `${stockCount} in stock`}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => toggleFavorite(p.id)}
                                aria-label={
                                  isFav
                                    ? `Remove ${p.name} from favourites`
                                    : `Add ${p.name} to favourites`
                                }
                                className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-400 hover:bg-slate-100 cursor-pointer transition-colors"
                              >
                                <Heart
                                  className={`w-4 h-4 ${
                                    isFav
                                      ? 'text-rose-500 fill-rose-500'
                                      : 'text-slate-400'
                                  }`}
                                />
                              </button>

                              <button
                                type="button"
                                disabled={isOut}
                                onClick={() => handleAddProductClick(p)}
                                aria-label={`Add ${p.name}`}
                                className={`min-w-[44px] h-[42px] px-2.5 rounded-xl font-bold text-[12px] flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                                  isOut
                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                    : addedQty > 0
                                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                    : 'bg-slate-900 hover:bg-slate-800 text-white'
                                }`}
                              >
                                <Plus className="w-4 h-4 shrink-0" />
                                {addedQty > 0 && (
                                  <span className="tabular-nums">{addedQty}</span>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                      {filteredProducts.map((p) => {
                        const cover = p.images?.[0]?.url;
                        const stockCount = p.stock || 0;
                        const lowThreshold = p.lowStockThreshold || 5;
                        const isOut = stockCount <= 0;
                        const isLow = !isOut && stockCount <= lowThreshold;
                        const isFav = favoriteIds.includes(p.id);
                        const addedQty = getProductSelectedQty(p.id);

                        return (
                          <div
                            key={p.id}
                            className={`bg-white/95 border rounded-xl overflow-hidden flex flex-col justify-between transition-colors ${
                              addedQty > 0
                                ? 'border-emerald-400 ring-1 ring-emerald-400/40'
                                : 'border-slate-200/90'
                            }`}
                          >
                            <div>
                              <div className="relative aspect-square bg-slate-100 overflow-hidden">
                                {cover ? (
                                  <img
                                    src={cover}
                                    alt={p.name}
                                    referrerPolicy="no-referrer"
                                    className={`w-full h-full object-cover ${
                                      isOut ? 'opacity-45 grayscale' : ''
                                    }`}
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-slate-400">
                                    <Package className="w-6 h-6" />
                                  </div>
                                )}

                                <button
                                  type="button"
                                  onClick={() => toggleFavorite(p.id)}
                                  aria-label="Toggle favourite"
                                  className="absolute top-1.5 right-1.5 w-8 h-8 rounded-lg bg-white/90 backdrop-blur-xs flex items-center justify-center shadow-xs cursor-pointer"
                                >
                                  <Heart
                                    className={`w-3.5 h-3.5 ${
                                      isFav
                                        ? 'text-rose-500 fill-rose-500'
                                        : 'text-slate-500'
                                    }`}
                                  />
                                </button>

                                <span
                                  className={`absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold backdrop-blur-xs ${
                                    isOut
                                      ? 'bg-rose-600/90 text-white'
                                      : isLow
                                      ? 'bg-amber-500/90 text-white'
                                      : 'bg-emerald-600/90 text-white'
                                  }`}
                                >
                                  {isOut
                                    ? 'Out of stock'
                                    : isLow
                                    ? `Only ${stockCount} left`
                                    : `${stockCount} in stock`}
                                </span>
                              </div>

                              <div className="p-2.5 space-y-1">
                                <h3 className="text-[12.5px] font-semibold text-slate-900 leading-snug line-clamp-2 min-h-[34px]">
                                  {p.name}
                                </h3>
                                <p className="text-[10.5px] text-slate-500 truncate">
                                  {p.sku}
                                  {p.brandName ? ` · ${p.brandName}` : ''}
                                </p>
                                <div className="flex items-baseline justify-between gap-1 text-[11.5px] tabular-nums pt-0.5">
                                  <span className="font-bold text-blue-700">
                                    ৳{p.resellerPrice.toLocaleString('en-BD')}
                                  </span>
                                  <span className="text-[10.5px] text-slate-400">
                                    SRP ৳{p.retailPrice.toLocaleString('en-BD')}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="p-2 pt-0">
                              <button
                                type="button"
                                disabled={isOut}
                                onClick={() => handleAddProductClick(p)}
                                className={`w-full h-[38px] rounded-xl text-[12px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                                  isOut
                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                    : addedQty > 0
                                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                    : 'bg-slate-900 hover:bg-slate-800 text-white'
                                }`}
                              >
                                <Plus className="w-3.5 h-3.5" />
                                <span>
                                  {isOut
                                    ? 'Out of stock'
                                    : addedQty > 0
                                    ? `Added (${addedQty})`
                                    : 'Add'}
                                </span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ============================================================ */}
              {/* STEP 2: QUANTITY & PRICE                                     */}
              {/* ============================================================ */}
              {step === 2 && (
                <div className="space-y-3">
                  {/* Top Bar Actions */}
                  <div className="bg-white/95 border border-slate-200/90 rounded-xl p-2.5 space-y-2">
                    <div className="flex items-center flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => goToStep(1)}
                        className="min-h-[34px] px-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11.5px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add product</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setShowBulkMarginInput((v) => !v)}
                        className="min-h-[34px] px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200/75 text-slate-700 text-[11.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                        <span>Set margin %</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleResetSuggestedPrices}
                        className="min-h-[34px] px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200/75 text-slate-700 text-[11.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
                        <span>Suggested price</span>
                      </button>
                    </div>

                    {showBulkMarginInput && (
                      <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                        <label
                          htmlFor="new-order-bulk-margin"
                          className="text-[11.5px] text-slate-600 font-medium whitespace-nowrap"
                        >
                          Markup %
                        </label>
                        <input
                          id="new-order-bulk-margin"
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
                  </div>

                  {selectedItems.length === 0 ? (
                    <div className="bg-white border border-slate-200/90 rounded-xl p-6 text-center space-y-3">
                      <p className="text-[14px] font-bold text-slate-900">
                        No products selected
                      </p>
                      <p className="text-[12.5px] text-slate-500">
                        Choose at least one product to set quantity and selling price.
                      </p>
                      <button
                        type="button"
                        onClick={() => goToStep(1)}
                        className="h-[42px] px-5 rounded-xl bg-slate-900 text-white text-[12.5px] font-semibold cursor-pointer"
                      >
                        Choose products
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {selectedItems.map((item) => (
                        <Step2ItemRow
                          key={item.id}
                          item={item}
                          onUpdateQuantity={updateItemQuantity}
                          onUpdateSellingPrice={updateItemSellingPrice}
                          onRemoveItem={removeSelectedItem}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ============================================================ */}
              {/* STEP 3: CUSTOMER & DELIVERY (SHARED WITH CART)               */}
              {/* ============================================================ */}
              {step === 3 && (
                <div className="space-y-3">
                  <CustomerDeliveryForm
                    idPrefix="new-order"
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
                    savedCustomers={mergedSavedCustomers}
                    onSelectSavedCustomer={handleSelectSavedCustomer}
                    saveThisCustomer={saveThisCustomer}
                    onToggleSaveThisCustomer={setSaveThisCustomer}
                    duplicateOrderWarning={duplicateOrderWarning}
                  />
                </div>
              )}

              {/* ============================================================ */}
              {/* STEP 4: REVIEW & CONFIRM (SHARED WITH CART)                  */}
              {/* ============================================================ */}
              {step === 4 && (
                <div className="space-y-3">
                  {/* Duplicate Warning Reminder if Present */}
                  {duplicateOrderWarning && (
                    <div
                      role="alert"
                      className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-[12px] flex items-start gap-2"
                    >
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <p className="leading-snug">{duplicateOrderWarning}</p>
                    </div>
                  )}

                  {/* Customer & Delivery Card */}
                  <div className="bg-white/95 border border-slate-200/90 rounded-xl p-3.5 space-y-1.5 text-[12.5px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-bold text-slate-500 uppercase tracking-wider">
                        Customer & Delivery
                      </span>
                      <button
                        type="button"
                        onClick={() => goToStep(3)}
                        className="text-[12px] font-semibold text-blue-600 hover:underline cursor-pointer"
                      >
                        Edit
                      </button>
                    </div>
                    <p className="font-bold text-slate-900 text-[13.5px]">
                      {customer.name}
                    </p>
                    <p className="text-slate-700 tabular-nums">
                      {normalizeBdPhone(customer.mobile)}
                      {customer.altMobile.trim()
                        ? ` · Alt: ${normalizeBdPhone(customer.altMobile)}`
                        : ''}
                    </p>
                    <p className="text-slate-600 leading-relaxed">
                      {[
                        customer.address.trim(),
                        customer.upazilaName,
                        customer.districtName,
                        customer.divisionName,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                    {customer.courierNote.trim() && (
                      <p className="text-slate-500 italic text-[12px]">
                        Courier note: {customer.courierNote.trim()}
                      </p>
                    )}
                  </div>

                  {/* Items Card */}
                  <div className="bg-white/95 border border-slate-200/90 rounded-xl overflow-hidden">
                    <div className="px-3.5 py-2.5 border-b border-slate-100 flex items-center justify-between">
                      <span className="text-[12px] font-bold text-slate-500 uppercase tracking-wider">
                        Items ({productCount} · {pieceCount} pcs)
                      </span>
                      <button
                        type="button"
                        onClick={() => goToStep(2)}
                        className="text-[12px] font-semibold text-blue-600 hover:underline cursor-pointer"
                      >
                        Edit prices / qty
                      </button>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {selectedItems.map((item) => {
                        const prof =
                          (item.sellingPrice - getItemCost(item)) * item.quantity;
                        const cover =
                          item.variant?.images?.[0]?.url ||
                          item.product.images?.[0]?.url;
                        return (
                          <div
                            key={item.id}
                            className="p-3 flex items-center justify-between gap-2.5 text-[12px] tabular-nums"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-11 h-11 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden shrink-0">
                                {cover ? (
                                  <img
                                    src={cover}
                                    alt={item.product.name}
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
                                <p className="font-semibold text-slate-900 line-clamp-2 leading-snug">
                                  {item.product.name}
                                  {item.variant
                                    ? ` (${item.variant.colorName})`
                                    : ''}
                                </p>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  {item.quantity} × ৳
                                  {item.sellingPrice.toLocaleString('en-BD')}
                                </p>
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-bold text-slate-900">
                                ৳
                                {(
                                  item.sellingPrice * item.quantity
                                ).toLocaleString('en-BD')}
                              </p>
                              <p className="text-[11px] font-semibold text-emerald-700">
                                +৳{prof.toLocaleString('en-BD')} profit
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Financial Summary + Shared Wallet Check */}
                  <div className="bg-white/95 border border-slate-200/90 rounded-xl p-3.5 space-y-2 text-[12.5px] tabular-nums">
                    <div className="flex justify-between text-slate-600">
                      <span>Wholesale cost (you pay)</span>
                      <span className="font-semibold text-slate-900">
                        ৳{totalWholesaleCost.toLocaleString('en-BD')}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span>Items selling subtotal</span>
                      <span className="font-semibold text-slate-900">
                        ৳{totalSellingSubtotal.toLocaleString('en-BD')}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span className="inline-flex items-center gap-1">
                        <Truck className="w-3.5 h-3.5 text-slate-400" />
                        <span>
                          Delivery ({isInsideDhaka ? 'Inside Dhaka' : 'Outside Dhaka'})
                        </span>
                      </span>
                      <span className="font-semibold text-slate-900">
                        ৳{deliveryCharge.toLocaleString('en-BD')}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-700 font-semibold">
                      <span>Customer pays total</span>
                      <span>৳{customerPaysTotal.toLocaleString('en-BD')}</span>
                    </div>
                    {clampedAdvance > 0 && (
                      <div className="flex justify-between text-slate-600">
                        <span>Advance received</span>
                        <span>−৳{clampedAdvance.toLocaleString('en-BD')}</span>
                      </div>
                    )}
                    <div className="flex justify-between pt-2 border-t border-slate-100 font-bold text-slate-900 text-[13.5px]">
                      <span>Customer pays on delivery (COD)</span>
                      <span>৳{codPayableOnDelivery.toLocaleString('en-BD')}</span>
                    </div>
                    <div className="flex justify-between font-extrabold text-emerald-700 text-[14px]">
                      <span>Estimated profit</span>
                      <span>+৳{totalEstimatedProfit.toLocaleString('en-BD')}</span>
                    </div>

                    <div className="pt-2 border-t border-slate-100">
                      <WalletCoverageRow
                        walletBalance={walletBalance}
                        totalWholesaleCost={totalWholesaleCost}
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 3. STICKY BOTTOM ACTION BAR (Keyboard-Safe via visualViewport) */}
        {canAccessFullApp && !orderSuccess && !loadError && (
          <footer className="shrink-0 bg-white/95 backdrop-blur-md border-t border-slate-200 px-3 sm:px-4 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom,0px))] shadow-[0_-6px_20px_rgba(15,23,42,0.06)]">
            {step === 1 && (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  {selectedItems.length > 0 ? (
                    <>
                      <p className="text-[12.5px] font-bold text-slate-900 tabular-nums truncate">
                        {productCount}{' '}
                        {productCount === 1 ? 'product' : 'products'} ·{' '}
                        {pieceCount} {pieceCount === 1 ? 'pc' : 'pcs'}
                      </p>
                      <p className="text-[11px] text-slate-500 tabular-nums truncate">
                        Wholesale ৳{totalWholesaleCost.toLocaleString('en-BD')} ·
                        Est. profit +৳
                        {totalEstimatedProfit.toLocaleString('en-BD')}
                      </p>
                    </>
                  ) : (
                    <p className="text-[12px] text-slate-500 font-medium">
                      Tap + to select one or more products
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={selectedItems.length === 0}
                  onClick={() => goToStep(2)}
                  className="h-[44px] px-5 rounded-xl bg-[#f57224] hover:bg-[#e0651d] disabled:opacity-45 disabled:cursor-not-allowed text-white text-[13px] font-bold shrink-0 cursor-pointer transition-colors"
                >
                  Next
                </button>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-1.5">
                {(hasInvalidPrices || hasInvalidStock) && (
                  <p className="text-[11.5px] font-semibold text-rose-600 flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      {hasInvalidPrices
                        ? 'Selling price cannot be lower than minimum wholesale price.'
                        : 'Adjust quantities exceeding available stock.'}
                    </span>
                  </p>
                )}
                <div className="flex items-center justify-between gap-2.5">
                  <button
                    type="button"
                    onClick={() => goToStep(1)}
                    className="h-[44px] px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12.5px] font-semibold cursor-pointer shrink-0"
                  >
                    Back
                  </button>
                  <div className="flex-1 min-w-0 text-center tabular-nums">
                    <p className="text-[11px] text-slate-500">Est. profit</p>
                    <p
                      className={`text-[14px] font-extrabold leading-tight ${
                        totalEstimatedProfit >= 0
                          ? 'text-emerald-700'
                          : 'text-rose-600'
                      }`}
                    >
                      {totalEstimatedProfit >= 0 ? '+' : ''}৳
                      {totalEstimatedProfit.toLocaleString('en-BD')}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={
                      selectedItems.length === 0 ||
                      hasInvalidPrices ||
                      hasInvalidStock
                    }
                    onClick={() => goToStep(3)}
                    className="h-[44px] px-5 rounded-xl bg-[#f57224] hover:bg-[#e0651d] disabled:opacity-45 disabled:cursor-not-allowed text-white text-[13px] font-bold shrink-0 cursor-pointer transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="flex items-center justify-between gap-2.5">
                <button
                  type="button"
                  onClick={() => goToStep(2)}
                  className="h-[44px] px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12.5px] font-semibold cursor-pointer shrink-0"
                >
                  Back
                </button>
                <div className="flex-1 min-w-0 text-center tabular-nums">
                  <p className="text-[11px] text-slate-500">COD total</p>
                  <p className="text-[14px] font-extrabold text-slate-900 leading-tight">
                    ৳{codPayableOnDelivery.toLocaleString('en-BD')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleStep3Next}
                  className="h-[44px] px-5 rounded-xl bg-[#f57224] hover:bg-[#e0651d] text-white text-[13px] font-bold shrink-0 cursor-pointer transition-colors"
                >
                  Review
                </button>
              </div>
            )}

            {step === 4 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => goToStep(3)}
                  className="h-[44px] px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12.5px] font-semibold cursor-pointer shrink-0"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleShareQuote}
                  aria-label="Share customer quote"
                  className="h-[44px] px-3.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 text-[12.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                >
                  <Share2 className="w-4 h-4" />
                  <span className="hidden min-[380px]:inline">Share quote</span>
                </button>
                <button
                  type="button"
                  disabled={!isOnline || hasInvalidPrices || hasInvalidStock}
                  onClick={handleOpenConfirmation}
                  className="flex-1 h-[44px] rounded-xl bg-[#f57224] hover:bg-[#e0651d] disabled:opacity-45 disabled:cursor-not-allowed text-white text-[13px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  {!isOnline ? (
                    <>
                      <WifiOff className="w-4 h-4" />
                      <span>Offline</span>
                    </>
                  ) : (
                    <span>Place order</span>
                  )}
                </button>
              </div>
            )}
          </footer>
        )}
      </motion.div>

      {/* VARIANT SELECTION SHEET FOR STEP 1 PRODUCTS WITH VARIANTS */}
      <AnimatePresence>
        {variantPickerProduct && (
          <div className="fixed inset-0 z-[65] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div
              onClick={() => setVariantPickerProduct(null)}
              className="absolute inset-0 bg-slate-950/50 backdrop-blur-xs"
            />
            <motion.div
              initial={reducedMotion ? false : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, y: 20 }}
              transition={{ duration: reducedMotion ? 0 : 0.18 }}
              className="relative w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] shadow-2xl border border-slate-200 space-y-3 z-10"
            >
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
                <div className="min-w-0">
                  <h3 className="text-[15px] font-bold text-slate-900 truncate">
                    Select Color Variant
                  </h3>
                  <p className="text-[11.5px] text-slate-500 truncate">
                    {variantPickerProduct.name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setVariantPickerProduct(null)}
                  className="w-9 h-9 rounded-xl text-slate-500 hover:bg-slate-100 flex items-center justify-center cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {(variantPickerProduct.variants || [])
                  .filter((v) => v.status === 'active')
                  .map((v) => {
                    const out = (v.stock || 0) <= 0;
                    const existingQty =
                      selectedItems.find(
                        (i) =>
                          i.id === `${variantPickerProduct.id}_${v.id}`
                      )?.quantity || 0;
                    const cost =
                      (variantPickerProduct.resellerPrice || 0) +
                      (v.priceAdjustment || 0);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        disabled={out}
                        onClick={() => {
                          addProductOrVariant(variantPickerProduct, v);
                          setVariantPickerProduct(null);
                        }}
                        className="w-full p-3 rounded-xl border border-slate-200 hover:border-blue-500 hover:bg-blue-50/40 disabled:opacity-45 disabled:cursor-not-allowed flex items-center justify-between gap-2 text-left cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="w-4 h-4 rounded-full border border-slate-300 shrink-0"
                            style={{ backgroundColor: v.colorName.toLowerCase() }}
                          />
                          <div className="min-w-0">
                            <p className="text-[12.5px] font-bold text-slate-900 truncate">
                              {v.colorName}
                            </p>
                            <p className="text-[11px] text-slate-500 tabular-nums">
                              Wholesale ৳{cost.toLocaleString('en-BD')} ·{' '}
                              {out ? 'Out of stock' : `${v.stock} in stock`}
                            </p>
                          </div>
                        </div>
                        <span className="px-2.5 py-1 rounded-lg bg-slate-900 text-white text-[11px] font-bold shrink-0">
                          {existingQty > 0 ? `+ Add (${existingQty})` : '+ Add'}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* BARCODE / QR SCANNER MODAL (Reuses Existing QrScannerModal) */}
      <QrScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onProductMatched={handleScannedProduct}
      />

      {/* SHARED ORDER CONFIRMATION SHEET */}
      <OrderConfirmModalSheet
        isOpen={showConfirmSheet}
        isPlacingOrder={isPlacingOrder}
        isOnline={isOnline}
        reducedMotion={reducedMotion}
        orderSubmitError={orderSubmitError}
        customer={customer}
        items={selectedItems}
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

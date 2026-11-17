import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CartItem } from '../../../types';
import {
  CartCustomerDetails,
  OrderSuccessData,
  getItemCost,
  normalizeBdPhone,
} from './orderCalculations';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  MapPin,
  Phone,
  RefreshCw,
  Wallet as WalletIcon,
  X,
} from 'lucide-react';

interface WalletCoverageRowProps {
  walletBalance: number;
  totalWholesaleCost: number;
  className?: string;
}

export const WalletCoverageRow: React.FC<WalletCoverageRowProps> = ({
  walletBalance,
  totalWholesaleCost,
  className = '',
}) => {
  const walletCoversOrder = walletBalance >= totalWholesaleCost;
  const walletShortfall = Math.max(0, totalWholesaleCost - walletBalance);

  return (
    <div
      className={`flex items-center justify-between gap-2 text-[12px] tabular-nums ${className}`}
    >
      <span className="inline-flex items-center gap-1.5 text-slate-600">
        <WalletIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span>
          Wallet:{' '}
          <strong className="text-slate-900">
            ৳{walletBalance.toLocaleString('en-BD')}
          </strong>
        </span>
      </span>
      {walletCoversOrder ? (
        <span className="font-semibold text-emerald-700">
          Covers wholesale cost
        </span>
      ) : (
        <span className="font-semibold text-amber-700">
          ৳{walletShortfall.toLocaleString('en-BD')} short of wholesale cost
        </span>
      )}
    </div>
  );
};

interface OrderConfirmModalSheetProps {
  isOpen: boolean;
  isPlacingOrder: boolean;
  isOnline: boolean;
  reducedMotion: boolean;
  orderSubmitError: string;
  customer: CartCustomerDetails;
  items: CartItem[];
  totalWholesaleCost: number;
  totalSellingSubtotal: number;
  deliveryCharge: number;
  isInsideDhaka: boolean;
  clampedAdvance: number;
  codPayableOnDelivery: number;
  totalEstimatedProfit: number;
  onClose: () => void;
  onConfirm: () => void;
}

export const OrderConfirmModalSheet: React.FC<OrderConfirmModalSheetProps> = ({
  isOpen,
  isPlacingOrder,
  isOnline,
  reducedMotion,
  orderSubmitError,
  customer,
  items,
  totalWholesaleCost,
  totalSellingSubtotal,
  deliveryCharge,
  isInsideDhaka,
  clampedAdvance,
  codPayableOnDelivery,
  totalEstimatedProfit,
  onClose,
  onConfirm,
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div
            onClick={() => {
              if (!isPlacingOrder) onClose();
            }}
            className="absolute inset-0 bg-slate-950/55 backdrop-blur-xs"
          />
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? undefined : { opacity: 0, y: 24 }}
            transition={{ duration: reducedMotion ? 0 : 0.2 }}
            className="relative w-full sm:max-w-md max-h-[88vh] bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden z-10"
          >
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-[16px] font-bold text-slate-900">
                  Confirm Your Order
                </h3>
                <p className="text-[11.5px] text-slate-500">
                  Review customer details, items, totals & profit
                </p>
              </div>
              <button
                type="button"
                disabled={isPlacingOrder}
                onClick={onClose}
                aria-label="Close confirmation"
                className="w-10 h-10 rounded-xl text-slate-500 hover:bg-slate-100 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 text-[12px]">
              {orderSubmitError && (
                <div
                  role="alert"
                  className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 font-medium flex items-start gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{orderSubmitError}</span>
                </div>
              )}

              {/* Customer Summary */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3 space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-slate-900">
                  <MapPin className="w-3.5 h-3.5 text-slate-500" />
                  <span>{customer.name}</span>
                </div>
                <p className="text-slate-700 tabular-nums flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-slate-400" />
                  <span>
                    {normalizeBdPhone(customer.mobile)}
                    {customer.altMobile.trim()
                      ? ` · Alt: ${normalizeBdPhone(customer.altMobile)}`
                      : ''}
                  </span>
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
                  <p className="text-slate-500 italic">
                    Note: {customer.courierNote.trim()}
                  </p>
                )}
              </div>

              {/* Items List */}
              <div className="border border-slate-200/80 rounded-xl divide-y divide-slate-100">
                {items.map((item) => {
                  const prof =
                    (item.sellingPrice - getItemCost(item)) * item.quantity;
                  return (
                    <div
                      key={item.id}
                      className="p-2.5 flex items-center justify-between gap-2 tabular-nums"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900 line-clamp-2">
                          {item.product.name}
                          {item.variant ? ` (${item.variant.colorName})` : ''}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {item.quantity} × ৳
                          {item.sellingPrice.toLocaleString('en-BD')}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-bold text-slate-900">
                          ৳
                          {(item.sellingPrice * item.quantity).toLocaleString(
                            'en-BD'
                          )}
                        </p>
                        <p className="text-[11px] font-semibold text-emerald-700">
                          +৳{prof.toLocaleString('en-BD')} profit
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Financial Totals */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3 space-y-1.5 tabular-nums">
                <div className="flex justify-between text-slate-600">
                  <span>Wholesale cost</span>
                  <span className="font-semibold text-slate-800">
                    ৳{totalWholesaleCost.toLocaleString('en-BD')}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Selling subtotal</span>
                  <span className="font-semibold text-slate-800">
                    ৳{totalSellingSubtotal.toLocaleString('en-BD')}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>
                    Delivery ({isInsideDhaka ? 'Inside Dhaka' : 'Outside Dhaka'})
                  </span>
                  <span className="font-semibold text-slate-800">
                    ৳{deliveryCharge.toLocaleString('en-BD')}
                  </span>
                </div>
                {clampedAdvance > 0 && (
                  <div className="flex justify-between text-slate-600">
                    <span>Advance received</span>
                    <span className="font-semibold text-slate-800">
                      −৳{clampedAdvance.toLocaleString('en-BD')}
                    </span>
                  </div>
                )}
                <div className="flex justify-between pt-1.5 border-t border-slate-200 font-bold text-slate-900 text-[13px]">
                  <span>Customer pays on delivery</span>
                  <span>৳{codPayableOnDelivery.toLocaleString('en-BD')}</span>
                </div>
                <div className="flex justify-between font-bold text-emerald-700 text-[13px]">
                  <span>Estimated total profit</span>
                  <span>+৳{totalEstimatedProfit.toLocaleString('en-BD')}</span>
                </div>
              </div>
            </div>

            <div className="p-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom,0px))] border-t border-slate-100 bg-white grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={isPlacingOrder}
                onClick={onClose}
                className="h-[44px] rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12.5px] font-semibold cursor-pointer disabled:opacity-50"
              >
                Edit Details
              </button>
              <button
                type="button"
                disabled={isPlacingOrder || !isOnline}
                onClick={onConfirm}
                className="h-[44px] rounded-xl bg-[#f57224] hover:bg-[#e0651d] disabled:opacity-50 text-white text-[12.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {isPlacingOrder ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Placing order...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Confirm & Place Order</span>
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

interface OrderSuccessCardProps {
  orderSuccess: OrderSuccessData;
  reducedMotion: boolean;
  onViewOrder: () => void;
  secondaryLabel: string;
  onSecondaryAction: () => void;
}

export const OrderSuccessCard: React.FC<OrderSuccessCardProps> = ({
  orderSuccess,
  reducedMotion,
  onViewOrder,
  secondaryLabel,
  onSecondaryAction,
}) => {
  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.2 }}
      className="bg-white border border-slate-200 rounded-xl p-5 text-center space-y-4 mt-2"
    >
      <div className="w-12 h-12 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center mx-auto">
        <CheckCircle2 className="w-6 h-6" />
      </div>

      <div className="space-y-1">
        <h3 className="text-[16px] font-bold text-slate-900">
          Order Placed Successfully
        </h3>
        <p className="text-[12.5px] text-slate-600">
          Order for{' '}
          <strong className="text-slate-900">
            {orderSuccess.customerName}
          </strong>{' '}
          ({orderSuccess.totalProducts}{' '}
          {orderSuccess.totalProducts === 1 ? 'product' : 'products'} -{' '}
          {orderSuccess.totalPieces} pcs) has been submitted.
        </p>
      </div>

      <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3 space-y-2 text-[12px] text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">Order Number</span>
          <span className="font-mono font-bold text-slate-900">
            {orderSuccess.primaryOrderNumber}
          </span>
        </div>
        {orderSuccess.orderNumbers.length > 1 && (
          <div className="text-[11px] text-slate-500 font-mono break-all">
            Items: {orderSuccess.orderNumbers.join(', ')}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-200/70 tabular-nums">
          <span className="text-slate-500">Customer pays on delivery</span>
          <strong className="text-slate-900">
            ৳{orderSuccess.codAmount.toLocaleString('en-BD')}
          </strong>
        </div>
        <div className="flex items-center justify-between gap-2 tabular-nums">
          <span className="text-slate-500">Estimated profit</span>
          <strong className="text-emerald-700">
            +৳{orderSuccess.estimatedProfit.toLocaleString('en-BD')}
          </strong>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 pt-1">
        <button
          type="button"
          onClick={onViewOrder}
          className="h-[44px] rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[12.5px] font-semibold cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        >
          View order
        </button>
        <button
          type="button"
          onClick={onSecondaryAction}
          className="h-[44px] rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-800 text-[12.5px] font-semibold cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {secondaryLabel}
        </button>
      </div>
    </motion.div>
  );
};

import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, limit, orderBy } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { UserProfile, Order } from '../../types';
import { X, Search, ShoppingBag } from 'lucide-react';

interface OrderAttachmentPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile;
  onSelectOrder: (order: { id: string; orderNumber: string; status: string; totalAmount: number }) => void;
}

export const OrderAttachmentPickerModal: React.FC<OrderAttachmentPickerModalProps> = ({
  isOpen,
  onClose,
  user,
  onSelectOrder,
}) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!isOpen) return;

    const getCreatedMs = (ts: any): number => {
      if (!ts) return 0;
      if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
      if (typeof ts?.seconds === 'number') return ts.seconds * 1000;
      const t = new Date(ts).getTime();
      return Number.isNaN(t) ? 0 : t;
    };

    const fetchOrders = async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        let snap;
        if (user.role === 'reseller') {
          // Query by resellerId without composite orderBy to guarantee compatibility without custom index
          const q = query(
            collection(db, 'orders'),
            where('resellerId', '==', user.uid),
            limit(60)
          );
          snap = await getDocs(q);
        } else {
          const q = query(
            collection(db, 'orders'),
            orderBy('createdAt', 'desc'),
            limit(40)
          );
          snap = await getDocs(q);
        }
        const list: Order[] = [];
        snap.forEach((d) => {
          const data = d.data() as Order;
          list.push({ id: d.id, ...data });
        });
        list.sort((a, b) => getCreatedMs(b.createdAt) - getCreatedMs(a.createdAt));
        setOrders(list.slice(0, 30));
      } catch (err: any) {
        console.error('Error fetching orders for chat attachment:', err);
        setErrorMsg('Could not load recent orders. Please check your connection.');
      } finally {
        setLoading(false);
      }
    };

    fetchOrders();
  }, [isOpen, user.uid, user.role, retryCount]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const filteredOrders = orders.filter((o) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return (
      (o.orderNumber && o.orderNumber.toLowerCase().includes(term)) ||
      (o.customerName && o.customerName.toLowerCase().includes(term)) ||
      (o.customerPhone && o.customerPhone.includes(term))
    );
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'delivered':
        return <span className="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-md">DELIVERED</span>;
      case 'pending':
        return <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded-md">PENDING</span>;
      case 'processing':
      case 'confirmed':
      case 'shipped':
        return <span className="bg-cyan-100 text-[#04203F] text-[10px] font-bold px-2 py-0.5 rounded-md uppercase">{status}</span>;
      case 'cancelled':
      case 'returned':
        return <span className="bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase">{status}</span>;
      default:
        return <span className="bg-slate-100 text-slate-700 text-[10px] font-bold px-2 py-0.5 rounded-md uppercase">{status}</span>;
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-950/45 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Attach order"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl shadow-2xl border border-slate-200/80 overflow-hidden flex flex-col max-h-[82dvh] pb-[env(safe-area-inset-bottom,0px)]"
      >
        {/* Modal Header */}
        <div className="px-4 py-3 bg-white/95 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#0E9AA7]/10 text-[#0E9AA7] flex items-center justify-center">
              <ShoppingBag className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-[15px] text-[#04203F] leading-tight">Attach Order</h3>
              <p className="text-[11px] text-slate-500">Tap an order to send its reference card</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 -mr-1.5 text-slate-500 hover:text-[#04203F] rounded-xl hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer"
            aria-label="Close order picker"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="p-3 bg-slate-50/90 border-b border-slate-200 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by Order #, customer name, phone..."
              className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-xl text-[13px] text-slate-900 placeholder-slate-400 focus:border-[#0E9AA7] focus:outline-none"
            />
          </div>
        </div>

        {/* Orders List */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-2">
          {loading ? (
            <div className="space-y-2 py-2">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-16 rounded-xl bg-slate-100 animate-pulse motion-reduce:animate-none" />
              ))}
            </div>
          ) : errorMsg ? (
            <div className="text-center py-8 px-4 space-y-2.5">
              <p className="text-[12.5px] text-rose-600 font-medium">{errorMsg}</p>
              <button
                type="button"
                onClick={() => setRetryCount((c) => c + 1)}
                className="px-4 py-2 bg-[#0E9AA7] hover:bg-[#0c8591] text-white text-[12px] font-semibold rounded-xl cursor-pointer"
              >
                Retry
              </button>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-[12.5px]">
              No recent orders found.
            </div>
          ) : (
            filteredOrders.map((ord) => (
              <button
                key={ord.id}
                type="button"
                onClick={() => {
                  onSelectOrder({
                    id: ord.id,
                    orderNumber: ord.orderNumber || ord.id.slice(0, 8),
                    status: ord.status,
                    totalAmount: ord.totalAmount || 0,
                  });
                  onClose();
                }}
                className="w-full text-left p-3 bg-white hover:bg-[#0E9AA7]/5 border border-slate-200 hover:border-[#0E9AA7]/40 rounded-xl transition-colors cursor-pointer flex items-center justify-between gap-3 group"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-[13px] text-[#04203F] group-hover:text-[#0E9AA7]">
                      Order #{ord.orderNumber || ord.id.slice(0, 8)}
                    </span>
                    {getStatusBadge(ord.status)}
                  </div>
                  <p className="text-[11px] text-slate-500 truncate">
                    {ord.customerName} {ord.customerPhone ? `· ${ord.customerPhone}` : ''}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <span className="font-bold text-[13.5px] text-[#04203F] block tabular-nums">
                    ৳{(ord.totalAmount || 0).toLocaleString()}
                  </span>
                  <span className="text-[11px] text-[#0E9AA7] font-semibold">
                    Attach
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

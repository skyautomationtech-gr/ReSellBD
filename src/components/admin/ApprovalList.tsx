import React, { useCallback, useEffect, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  CheckCircle2,
  Clock,
  CreditCard,
  Shield,
  ShieldAlert,
  Store,
  Tag,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { formatResellerId } from '../../lib/resellerIdHelper';
import { PayoutChangeRequest, UserProfile } from '../../types';
import { ResellerRegistrationsView } from './approvals/ResellerRegistrationsView';

interface ApprovalListProps {
  user?: UserProfile;
}

export const ApprovalList: React.FC<ApprovalListProps> = ({ user: currentUser }) => {
  const hasApprovalAccess =
    currentUser?.role === 'super_admin' ||
    (currentUser?.role === 'admin' &&
      Array.isArray(currentUser.permissions) &&
      currentUser.permissions.includes('approve_resellers'));

  const [activeTab, setActiveTab] = useState<'registrations' | 'payouts'>('registrations');
  const [pendingRegistrationsCount, setPendingRegistrationsCount] = useState<number>(0);

  const [pendingPayouts, setPendingPayouts] = useState<PayoutChangeRequest[]>([]);
  const [payoutsLoading, setPayoutsLoading] = useState<boolean>(false);
  const [rejectingPayout, setRejectingPayout] = useState<PayoutChangeRequest | null>(null);
  const [payoutRejectReason, setPayoutRejectReason] = useState('');
  const [payoutRejectError, setPayoutRejectError] = useState<string | null>(null);
  const [payoutActionLoadingId, setPayoutActionLoadingId] = useState<string | null>(null);
  const [payoutFeedback, setPayoutFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showPayoutFeedback = (type: 'success' | 'error', message: string) => {
    setPayoutFeedback({ type, message });
    setTimeout(() => {
      setPayoutFeedback((prev) => (prev?.message === message ? null : prev));
    }, 5000);
  };

  const fetchPendingPayouts = useCallback(async () => {
    if (!hasApprovalAccess) return;
    setPayoutsLoading(true);
    try {
      const qPayouts = query(
        collection(db, 'payoutChangeRequests'),
        where('status', '==', 'pending')
      );
      const payoutsSnap = await getDocs(qPayouts);
      const payoutList: PayoutChangeRequest[] = [];
      payoutsSnap.forEach((docSnap) => {
        payoutList.push({ id: docSnap.id, ...docSnap.data() } as PayoutChangeRequest);
      });
      setPendingPayouts(payoutList);
    } catch (err) {
      console.error('Error fetching pending payout approvals:', err);
      showPayoutFeedback('error', 'Failed to load pending payout change requests.');
    } finally {
      setPayoutsLoading(false);
    }
  }, [hasApprovalAccess]);

  useEffect(() => {
    if (hasApprovalAccess) {
      fetchPendingPayouts();
    }
  }, [hasApprovalAccess, fetchPendingPayouts]);

  const handleApprovePayout = async (payoutReq: PayoutChangeRequest) => {
    setPayoutActionLoadingId(payoutReq.id);
    try {
      await updateDoc(doc(db, 'payoutChangeRequests', payoutReq.id), {
        status: 'approved',
        approvedAt: serverTimestamp(),
        approvedBy: currentUser?.fullName || 'Admin',
      });

      await updateDoc(doc(db, 'users', payoutReq.resellerId), {
        payoutMethod: payoutReq.payoutMethod,
        bkashNumber: payoutReq.bkashNumber || '',
        nagadNumber: payoutReq.nagadNumber || '',
        rocketNumber: payoutReq.rocketNumber || '',
        bankName: payoutReq.bankName || '',
        accountNumber: payoutReq.accountNumber || '',
        accountHolderName: payoutReq.accountHolderName || '',
        branchName: payoutReq.branchName || '',
      });

      await addDoc(collection(db, 'notices'), {
        resellerId: payoutReq.resellerId,
        title: 'Payout Account Updated',
        message: `Your request to update payout method to ${payoutReq.payoutMethod.toUpperCase()} has been approved by Admin!`,
        type: 'system',
        targetRole: 'reseller',
        createdAt: serverTimestamp(),
      });

      setPendingPayouts((prev) => prev.filter((p) => p.id !== payoutReq.id));
      showPayoutFeedback(
        'success',
        `Approved payout update for ${payoutReq.resellerName} (${payoutReq.payoutMethod.toUpperCase()}).`
      );
    } catch (err) {
      console.error('Error approving payout change:', err);
      showPayoutFeedback('error', 'Failed to approve payout account change.');
    } finally {
      setPayoutActionLoadingId(null);
    }
  };

  const handleRejectPayoutConfirm = async () => {
    if (!rejectingPayout) return;
    if (!payoutRejectReason.trim()) {
      setPayoutRejectError('Please provide a rejection reason for this payout change.');
      return;
    }
    setPayoutRejectError(null);
    setPayoutActionLoadingId(rejectingPayout.id);
    try {
      await updateDoc(doc(db, 'payoutChangeRequests', rejectingPayout.id), {
        status: 'rejected',
        rejectionReason: payoutRejectReason.trim(),
      });

      await addDoc(collection(db, 'notices'), {
        resellerId: rejectingPayout.resellerId,
        title: 'Payout Account Change Rejected',
        message: `Your payout account change request was rejected. Reason: ${payoutRejectReason.trim()}`,
        type: 'system',
        targetRole: 'reseller',
        createdAt: serverTimestamp(),
      });

      setPendingPayouts((prev) => prev.filter((p) => p.id !== rejectingPayout.id));
      showPayoutFeedback(
        'success',
        `Rejected payout change request for ${rejectingPayout.resellerName}.`
      );
      setRejectingPayout(null);
      setPayoutRejectReason('');
    } catch (err) {
      console.error('Error rejecting payout change:', err);
      setPayoutRejectError('Failed to reject payout account change. Please try again.');
    } finally {
      setPayoutActionLoadingId(null);
    }
  };

  if (!hasApprovalAccess) {
    return (
      <div className="bg-white/85 backdrop-blur-xl rounded-2xl border border-rose-200/80 p-8 sm:p-10 text-center shadow-[0_2px_12px_rgba(4,32,63,0.04)] max-w-xl mx-auto my-6">
        <div className="w-12 h-12 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center mx-auto mb-3">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-[16px] font-bold text-[#04203F]">Access Restricted</h2>
        <p className="text-[12.5px] text-slate-500 mt-1 leading-relaxed">
          Only a Super Admin or an Admin with the{' '}
          <span className="font-mono font-semibold text-slate-700">approve_resellers</span>{' '}
          permission can open Reseller Registration Approvals.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top Bar with Navigation Tabs */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white/85 backdrop-blur-xl px-4 py-3.5 rounded-2xl border border-slate-200/85 shadow-[0_2px_10px_rgba(4,32,63,0.04)]">
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold text-[#04203F] flex items-center gap-2 tracking-tight">
            <Shield className="w-4 h-4 text-[#0E9AA7] shrink-0" />
            <span>Admin Approval Center</span>
          </h2>
          <p className="text-[12px] text-slate-500 mt-0.5">
            Inspect complete reseller applications, verify KYC documents, and authorize payout changes.
          </p>
        </div>

        {/* Tab Selector */}
        <div className="flex items-center gap-1.5 bg-slate-100/90 p-1 rounded-xl w-full sm:w-auto overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('registrations')}
            className={`min-h-[36px] px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeTab === 'registrations'
                ? 'bg-white text-[#04203F] shadow-xs'
                : 'text-slate-600 hover:text-[#04203F]'
            }`}
          >
            <UserCheck className="w-3.5 h-3.5 text-[#0E9AA7]" />
            <span>Reseller Registrations</span>
            {pendingRegistrationsCount > 0 && (
              <span className="bg-amber-500 text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded-full font-mono tabular-nums">
                {pendingRegistrationsCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('payouts')}
            className={`min-h-[36px] px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeTab === 'payouts'
                ? 'bg-white text-[#04203F] shadow-xs'
                : 'text-slate-600 hover:text-[#04203F]'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5 text-emerald-600" />
            <span>Payout Account Changes</span>
            {pendingPayouts.length > 0 && (
              <span className="bg-emerald-600 text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded-full font-mono tabular-nums">
                {pendingPayouts.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* --- TAB 1: RESELLER REGISTRATIONS (Master-Detail Workspace) --- */}
      {activeTab === 'registrations' && (
        <ResellerRegistrationsView
          currentUser={currentUser}
          onPendingCountChange={setPendingRegistrationsCount}
        />
      )}

      {/* --- TAB 2: PAYOUT ACCOUNT CHANGES --- */}
      {activeTab === 'payouts' && (
        <div className="space-y-4">
          {payoutFeedback && (
            <div
              className={`px-3.5 py-2.5 rounded-xl border text-[12px] font-semibold flex items-center justify-between gap-2 ${
                payoutFeedback.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              <span className="min-w-0">{payoutFeedback.message}</span>
              <button
                type="button"
                onClick={() => setPayoutFeedback(null)}
                className="text-current opacity-70 hover:opacity-100 cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {payoutsLoading ? (
            <div className="bg-white/85 backdrop-blur-xl rounded-2xl border border-slate-200/85 p-10 flex items-center justify-center gap-2 text-slate-500 text-[12.5px]">
              <Clock className="w-4 h-4 animate-spin text-[#0E9AA7]" />
              <span>Loading pending payout change requests...</span>
            </div>
          ) : pendingPayouts.length === 0 ? (
            <div className="bg-white/85 backdrop-blur-xl rounded-2xl border border-slate-200/85 p-10 text-center shadow-[0_2px_10px_rgba(4,32,63,0.04)]">
              <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-3">
                <CreditCard className="w-6 h-6" />
              </div>
              <h3 className="text-[15px] font-bold text-[#04203F] mb-1">
                No Pending Payout Change Requests
              </h3>
              <p className="text-[12px] text-slate-500">
                There are no requested updates to reseller bank or mobile wallet details.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {pendingPayouts.map((req) => (
                <div
                  key={req.id}
                  className="bg-white/90 backdrop-blur-xl rounded-2xl border border-slate-200/90 shadow-[0_2px_10px_rgba(4,32,63,0.04)] overflow-hidden flex flex-col justify-between"
                >
                  <div className="p-4 sm:p-5 space-y-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-bold text-[#04203F] text-[14.5px] truncate">
                            {req.resellerName}
                          </h3>
                          <span className="inline-flex items-center gap-1 font-mono tabular-nums text-[11px] font-bold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg border border-blue-200">
                            <Tag className="w-3 h-3 text-blue-500" />
                            {formatResellerId(req.resellerId)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-[12px] text-[#0E9AA7] font-semibold mt-0.5">
                          <Store className="w-3.5 h-3.5" />
                          <span>{req.shopName || 'Reseller'}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                          Mobile: {req.mobile}
                        </div>
                      </div>
                      <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider flex items-center gap-1 shrink-0">
                        <CreditCard className="w-3 h-3 text-emerald-600" />
                        <span>Payout Update</span>
                      </span>
                    </div>

                    <div className="bg-[#04203F] text-white rounded-xl p-3.5 space-y-2 text-[12px]">
                      <div className="flex justify-between items-center border-b border-white/10 pb-2">
                        <span className="text-[10px] font-bold text-[#7CE7F0] uppercase tracking-wider">
                          Requested Payout Method
                        </span>
                        <span className="bg-emerald-500/20 text-emerald-300 font-extrabold px-2 py-0.5 rounded-md uppercase text-[10px]">
                          {req.payoutMethod}
                        </span>
                      </div>

                      {req.payoutMethod === 'bkash' && (
                        <div className="flex items-center justify-between text-pink-300 font-mono tabular-nums font-bold text-[13px]">
                          <span>bKash Number:</span>
                          <span>{req.bkashNumber}</span>
                        </div>
                      )}

                      {req.payoutMethod === 'nagad' && (
                        <div className="flex items-center justify-between text-amber-300 font-mono tabular-nums font-bold text-[13px]">
                          <span>Nagad Number:</span>
                          <span>{req.nagadNumber}</span>
                        </div>
                      )}

                      {req.payoutMethod === 'rocket' && (
                        <div className="flex items-center justify-between text-purple-300 font-mono tabular-nums font-bold text-[13px]">
                          <span>Rocket Number:</span>
                          <span>{req.rocketNumber}</span>
                        </div>
                      )}

                      {req.payoutMethod === 'bank' && (
                        <div className="space-y-1 text-slate-200 text-[11.5px]">
                          <p>
                            <span className="text-slate-400">Bank Name:</span>{' '}
                            <strong className="text-white">{req.bankName}</strong>
                          </p>
                          <p>
                            <span className="text-slate-400">Account Holder:</span>{' '}
                            <strong className="text-white">{req.accountHolderName}</strong>
                          </p>
                          <p>
                            <span className="text-slate-400">Account Number:</span>{' '}
                            <strong className="text-emerald-300 font-mono tabular-nums">
                              {req.accountNumber}
                            </strong>
                          </p>
                          <p>
                            <span className="text-slate-400">Branch:</span>{' '}
                            <strong className="text-white">{req.branchName}</strong>
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-slate-100 bg-slate-50/70 p-3.5 flex gap-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setPayoutRejectError(null);
                        setPayoutRejectReason('');
                        setRejectingPayout(req);
                      }}
                      disabled={payoutActionLoadingId === req.id}
                      className="flex-1 min-h-[38px] bg-white border border-rose-200 text-rose-700 hover:bg-rose-50 font-semibold py-2 px-3 rounded-xl text-[12px] transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>Reject Change</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleApprovePayout(req)}
                      disabled={payoutActionLoadingId === req.id}
                      className="flex-1 min-h-[38px] bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2 px-3 rounded-xl text-[12px] transition-colors flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-50 cursor-pointer"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Approve Payout</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reject Payout Change Modal */}
      {rejectingPayout && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-[#04203F]/50 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-5 space-y-3.5">
            <h3 className="text-[16px] font-bold text-[#04203F]">Reject Payout Account Update</h3>
            <p className="text-[12px] text-slate-600">
              Provide a reason for rejecting the payout account change for{' '}
              <span className="font-semibold text-[#04203F]">{rejectingPayout.resellerName}</span>.
            </p>

            <div>
              <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">
                Rejection Reason *
              </label>
              <textarea
                rows={3}
                value={payoutRejectReason}
                onChange={(e) => {
                  setPayoutRejectReason(e.target.value);
                  if (payoutRejectError) setPayoutRejectError(null);
                }}
                placeholder="e.g., Mobile wallet number invalid or name mismatch."
                className="w-full p-3 rounded-xl border border-slate-300 text-[13px] focus:outline-none focus:ring-2 focus:ring-rose-500/30 focus:border-rose-500 resize-none"
              />
            </div>

            {payoutRejectError && (
              <div className="px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-[12px] font-medium">
                {payoutRejectError}
              </div>
            )}

            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setRejectingPayout(null);
                  setPayoutRejectReason('');
                  setPayoutRejectError(null);
                }}
                className="flex-1 min-h-[40px] px-4 rounded-xl border border-slate-200 text-slate-700 text-[12.5px] font-semibold hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={payoutActionLoadingId === rejectingPayout.id}
                onClick={handleRejectPayoutConfirm}
                className="flex-1 min-h-[40px] px-4 rounded-xl bg-rose-600 text-white text-[12.5px] font-semibold hover:bg-rose-700 shadow-xs disabled:opacity-50 cursor-pointer"
              >
                Confirm Rejection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

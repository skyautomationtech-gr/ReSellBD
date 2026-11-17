import React, { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import {
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  FileText,
  Lock,
  Mail,
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
import { reviewChangeRequestCall } from '../../lib/lockedFieldsService';
import { ChangeRequest, ChangeRequestFieldKey, PayoutChangeRequest, UserProfile } from '../../types';
import { ResellerRegistrationsView } from './approvals/ResellerRegistrationsView';

interface ApprovalListProps {
  user?: UserProfile;
}

interface UnifiedChangeRequestItem {
  id: string;
  collectionName: 'changeRequests' | 'payoutChangeRequests';
  uid: string;
  resellerName: string;
  resellerCode: string;
  shopName: string;
  mobile: string;
  fieldKey: ChangeRequestFieldKey;
  fieldLabel: string;
  currentValueSummary: string;
  requestedValueSummary: string;
  requestedData: Record<string, any>;
  reason: string;
  proofUrl?: string;
  createdAtMs: number;
  createdAtLabel: string;
}

function getCreatedAtMs(val: any): number {
  if (!val) return 0;
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (typeof val.toDate === 'function') return val.toDate().getTime();
  if (val.seconds) return val.seconds * 1000;
  const parsed = new Date(val).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export const ApprovalList: React.FC<ApprovalListProps> = ({ user: currentUser }) => {
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const hasApprovalAccess =
    isSuperAdmin ||
    (currentUser?.role === 'admin' &&
      Array.isArray(currentUser.permissions) &&
      currentUser.permissions.includes('approve_resellers'));

  const [activeTab, setActiveTab] = useState<'registrations' | 'changes'>('registrations');
  const [pendingRegistrationsCount, setPendingRegistrationsCount] = useState<number>(0);

  const [pendingChanges, setPendingChanges] = useState<UnifiedChangeRequestItem[]>([]);
  const [changesLoading, setChangesLoading] = useState<boolean>(false);
  const [rejectingItem, setRejectingItem] = useState<UnifiedChangeRequestItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showFeedback = (type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
    setTimeout(() => {
      setFeedback((prev) => (prev?.message === message ? null : prev));
    }, 5000);
  };

  const fetchPendingChanges = useCallback(async () => {
    if (!isSuperAdmin) return;
    setChangesLoading(true);
    try {
      const [crSnap, legacyPayoutSnap] = await Promise.all([
        getDocs(query(collection(db, 'changeRequests'), where('status', '==', 'pending'))),
        getDocs(query(collection(db, 'payoutChangeRequests'), where('status', '==', 'pending'))),
      ]);

      const merged: UnifiedChangeRequestItem[] = [];

      crSnap.forEach((docSnap) => {
        const data = docSnap.data() as ChangeRequest;
        const ms = getCreatedAtMs(data.createdAt);
        merged.push({
          id: docSnap.id,
          collectionName: 'changeRequests',
          uid: data.uid || data.resellerId || '',
          resellerName: data.resellerName || 'Reseller',
          resellerCode: formatResellerId(data.resellerCode || data.uid || ''),
          shopName: data.shopName || 'Reseller Shop',
          mobile: data.mobile || '',
          fieldKey: data.fieldKey || 'shopName',
          fieldLabel: data.fieldLabel || 'Protected Info',
          currentValueSummary: data.currentValueSummary || 'Existing info on file',
          requestedValueSummary: data.requestedValueSummary || 'Updated details',
          requestedData: data.requestedData || {},
          reason: data.reason || '',
          proofUrl: data.proofUrl,
          createdAtMs: ms,
          createdAtLabel: ms ? new Date(ms).toLocaleString('en-GB') : 'Just now',
        });
      });

      legacyPayoutSnap.forEach((docSnap) => {
        const data = docSnap.data() as PayoutChangeRequest & { userId?: string };
        const ms = getCreatedAtMs(data.createdAt);
        const method = (data.payoutMethod || 'bkash').toUpperCase();
        const acct =
          data.payoutMethod === 'bkash'
            ? data.bkashNumber
            : data.payoutMethod === 'nagad'
            ? data.nagadNumber
            : data.payoutMethod === 'rocket'
            ? data.rocketNumber
            : `${data.bankName || 'Bank'} • ${data.accountNumber || ''}`;

        merged.push({
          id: docSnap.id,
          collectionName: 'payoutChangeRequests',
          uid: data.resellerId || data.userId || '',
          resellerName: data.resellerName || 'Reseller',
          resellerCode: formatResellerId(data.resellerId || data.userId || ''),
          shopName: data.shopName || 'Reseller Shop',
          mobile: data.mobile || '',
          fieldKey: 'payout',
          fieldLabel: 'Payout Account Details',
          currentValueSummary: 'Existing payout on file',
          requestedValueSummary: `${method}: ${acct || 'N/A'}`,
          requestedData: {
            payoutMethod: data.payoutMethod,
            bkashNumber: data.bkashNumber,
            nagadNumber: data.nagadNumber,
            rocketNumber: data.rocketNumber,
            bankName: data.bankName,
            accountNumber: data.accountNumber,
            accountHolderName: data.accountHolderName,
            branchName: data.branchName,
          },
          reason: 'Payout account update request',
          createdAtMs: ms,
          createdAtLabel: ms ? new Date(ms).toLocaleString('en-GB') : 'Just now',
        });
      });

      merged.sort((a, b) => b.createdAtMs - a.createdAtMs);
      setPendingChanges(merged);
    } catch (err) {
      console.error('Error fetching pending change requests:', err);
      showFeedback('error', 'Failed to load pending Super Admin change requests.');
    } finally {
      setChangesLoading(false);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    if (isSuperAdmin) {
      fetchPendingChanges();
    } else if (activeTab === 'changes') {
      setActiveTab('registrations');
    }
  }, [isSuperAdmin, activeTab, fetchPendingChanges]);

  const handleApproveItem = async (item: UnifiedChangeRequestItem) => {
    if (!isSuperAdmin) return;
    setActionLoadingId(item.id);
    try {
      const res = await reviewChangeRequestCall({
        requestId: item.id,
        collectionName: item.collectionName,
        decision: 'approved',
      });
      setPendingChanges((prev) => prev.filter((p) => p.id !== item.id));
      showFeedback(
        'success',
        res.message || `Approved ${item.fieldLabel} update for ${item.resellerName}.`
      );
    } catch (err: any) {
      console.error('Error approving change request:', err);
      showFeedback('error', err?.message || 'Failed to approve change request.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleRejectConfirm = async () => {
    if (!rejectingItem || !isSuperAdmin) return;
    if (!rejectReason.trim()) {
      setRejectError('Please provide a reason for rejecting this change request.');
      return;
    }
    setRejectError(null);
    setActionLoadingId(rejectingItem.id);
    try {
      await reviewChangeRequestCall({
        requestId: rejectingItem.id,
        collectionName: rejectingItem.collectionName,
        decision: 'rejected',
        adminNote: rejectReason.trim(),
      });
      setPendingChanges((prev) => prev.filter((p) => p.id !== rejectingItem.id));
      showFeedback(
        'success',
        `Rejected ${rejectingItem.fieldLabel} change request for ${rejectingItem.resellerName}.`
      );
      setRejectingItem(null);
      setRejectReason('');
    } catch (err: any) {
      console.error('Error rejecting change request:', err);
      setRejectError(err?.message || 'Failed to reject change request. Please try again.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const getFieldIcon = (key: ChangeRequestFieldKey) => {
    switch (key) {
      case 'shopName':
        return <Store className="w-3 h-3 text-indigo-600" />;
      case 'email':
        return <Mail className="w-3 h-3 text-blue-600" />;
      case 'dob':
        return <Calendar className="w-3 h-3 text-[#0E9AA7]" />;
      case 'payout':
        return <CreditCard className="w-3 h-3 text-emerald-600" />;
      default:
        return <FileText className="w-3 h-3 text-amber-600" />;
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
            {isSuperAdmin
              ? 'Inspect reseller applications and review locked identity & payout change requests.'
              : 'Inspect reseller applications and verify registration submissions.'}
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

          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => setActiveTab('changes')}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                activeTab === 'changes'
                  ? 'bg-white text-[#04203F] shadow-xs'
                  : 'text-slate-600 hover:text-[#04203F]'
              }`}
            >
              <Lock className="w-3.5 h-3.5 text-amber-600" />
              <span>Change Requests</span>
              {pendingChanges.length > 0 && (
                <span className="bg-emerald-600 text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded-full font-mono tabular-nums">
                  {pendingChanges.length}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* --- TAB 1: RESELLER REGISTRATIONS (Master-Detail Workspace) --- */}
      {activeTab === 'registrations' && (
        <ResellerRegistrationsView
          currentUser={currentUser}
          onPendingCountChange={setPendingRegistrationsCount}
        />
      )}

      {/* --- TAB 2: CHANGE REQUESTS (SUPER ADMIN EXCLUSIVE) --- */}
      {activeTab === 'changes' && isSuperAdmin && (
        <div className="space-y-4">
          {feedback && (
            <div
              className={`px-3.5 py-2.5 rounded-xl border text-[12px] font-semibold flex items-center justify-between gap-2 ${
                feedback.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              <span className="min-w-0">{feedback.message}</span>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="text-current opacity-70 hover:opacity-100 cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {changesLoading ? (
            <div className="bg-white/85 backdrop-blur-xl rounded-2xl border border-slate-200/85 p-10 flex items-center justify-center gap-2 text-slate-500 text-[12.5px]">
              <Clock className="w-4 h-4 animate-spin text-[#0E9AA7]" />
              <span>Loading pending protected field change requests...</span>
            </div>
          ) : pendingChanges.length === 0 ? (
            <div className="bg-white/85 backdrop-blur-xl rounded-2xl border border-slate-200/85 p-10 text-center shadow-[0_2px_10px_rgba(4,32,63,0.04)]">
              <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-3">
                <Lock className="w-6 h-6" />
              </div>
              <h3 className="text-[15px] font-bold text-[#04203F] mb-1">
                No Pending Change Requests
              </h3>
              <p className="text-[12px] text-slate-500">
                All reseller requests for shop name, email, identity, date of birth, or payout changes are reviewed.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {pendingChanges.map((item) => {
                const reqData = item.requestedData || {};
                const docImages = [
                  reqData.nidFrontUrl ? { label: 'NID Front', url: reqData.nidFrontUrl } : null,
                  reqData.nidBackUrl ? { label: 'NID Back', url: reqData.nidBackUrl } : null,
                  reqData.birthCertificateUrl ? { label: 'Birth Cert', url: reqData.birthCertificateUrl } : null,
                  item.proofUrl ? { label: 'Proof Photo', url: item.proofUrl } : null,
                ].filter(Boolean) as Array<{ label: string; url: string }>;

                return (
                  <div
                    key={`${item.collectionName}_${item.id}`}
                    className="bg-white/90 backdrop-blur-xl rounded-2xl border border-slate-200/90 shadow-[0_2px_10px_rgba(4,32,63,0.04)] overflow-hidden flex flex-col justify-between"
                  >
                    <div className="p-4 sm:p-5 space-y-3">
                      {/* Header */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-bold text-[#04203F] text-[14.5px] truncate">
                              {item.resellerName}
                            </h3>
                            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-[11px] font-bold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg border border-blue-200">
                              <Tag className="w-3 h-3 text-blue-500" />
                              {item.resellerCode}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[12px] text-[#0E9AA7] font-semibold mt-0.5">
                            <Store className="w-3.5 h-3.5" />
                            <span>{item.shopName}</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                            {item.mobile ? `Mobile: ${item.mobile} • ` : ''}
                            Submitted: {item.createdAtLabel}
                          </div>
                        </div>

                        <span className="bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider flex items-center gap-1 shrink-0">
                          {getFieldIcon(item.fieldKey)}
                          <span>{item.fieldLabel}</span>
                        </span>
                      </div>

                      {/* Current vs Requested Comparison */}
                      <div className="bg-[#04203F] text-white rounded-xl p-3.5 space-y-2 text-[12px]">
                        <div className="flex items-start justify-between gap-2 border-b border-white/10 pb-2">
                          <span className="text-[10px] font-bold text-slate-300 uppercase shrink-0">
                            Current:
                          </span>
                          <span className="text-right text-slate-200 font-mono text-[11.5px] break-all">
                            {item.currentValueSummary}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[10px] font-bold text-[#3DD055] uppercase shrink-0">
                            Requested:
                          </span>
                          <span className="text-right text-white font-bold font-mono text-[12px] break-all">
                            {item.requestedValueSummary}
                          </span>
                        </div>
                      </div>

                      {/* Reason */}
                      {item.reason && (
                        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-[11.5px] text-slate-700">
                          <span className="font-bold text-slate-900">Reason: </span>
                          <span>{item.reason}</span>
                        </div>
                      )}

                      {/* Proof & Uploaded Document Thumbnails */}
                      {docImages.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {docImages.map((img) => (
                            <button
                              key={`${img.label}_${img.url}`}
                              type="button"
                              onClick={() => setLightboxUrl(img.url)}
                              className="group relative rounded-xl overflow-hidden border border-slate-200 bg-slate-100 flex items-center gap-2 pr-2.5 cursor-pointer hover:border-[#0E9AA7]"
                            >
                              <img
                                src={img.url}
                                alt={img.label}
                                className="w-11 h-11 object-cover"
                              />
                              <span className="text-[10.5px] font-bold text-slate-700 flex items-center gap-1">
                                <span>{img.label}</span>
                                <ExternalLink className="w-3 h-3 text-[#0E9AA7]" />
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="border-t border-slate-100 bg-slate-50/70 p-3.5 flex gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          setRejectError(null);
                          setRejectReason('');
                          setRejectingItem(item);
                        }}
                        disabled={actionLoadingId === item.id}
                        className="flex-1 min-h-[38px] bg-white border border-rose-200 text-rose-700 hover:bg-rose-50 font-semibold py-2 px-3 rounded-xl text-[12px] transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                      >
                        <XCircle className="w-4 h-4" />
                        <span>Reject</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApproveItem(item)}
                        disabled={actionLoadingId === item.id}
                        className="flex-1 min-h-[38px] bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2 px-3 rounded-xl text-[12px] transition-colors flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-50 cursor-pointer"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>
                          {actionLoadingId === item.id ? 'Applying...' : 'Approve & Apply'}
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

      {/* Reject Change Request Modal */}
      {rejectingItem && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-[#04203F]/50 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-5 space-y-3.5">
            <h3 className="text-[16px] font-bold text-[#04203F]">
              Reject {rejectingItem.fieldLabel} Request
            </h3>
            <p className="text-[12px] text-slate-600">
              Provide a clear reason for rejecting the requested update for{' '}
              <span className="font-semibold text-[#04203F]">{rejectingItem.resellerName}</span>.
            </p>

            <div>
              <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">
                Rejection Reason *
              </label>
              <textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => {
                  setRejectReason(e.target.value);
                  if (rejectError) setRejectError(null);
                }}
                placeholder="e.g., Document mismatch or invalid account number."
                className="w-full p-3 rounded-xl border border-slate-300 text-[13px] focus:outline-none focus:ring-2 focus:ring-rose-500/30 focus:border-rose-500 resize-none"
              />
            </div>

            {rejectError && (
              <div className="px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-[12px] font-medium">
                {rejectError}
              </div>
            )}

            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setRejectingItem(null);
                  setRejectReason('');
                  setRejectError(null);
                }}
                className="flex-1 min-h-[40px] px-4 rounded-xl border border-slate-200 text-slate-700 text-[12.5px] font-semibold hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionLoadingId === rejectingItem.id}
                onClick={handleRejectConfirm}
                className="flex-1 min-h-[40px] px-4 rounded-xl bg-rose-600 text-white text-[12.5px] font-semibold hover:bg-rose-700 shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {actionLoadingId === rejectingItem.id ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Proof Image Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[85] bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <div className="relative max-w-3xl max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setLightboxUrl(null)}
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white text-slate-900 shadow-lg flex items-center justify-center cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={lightboxUrl}
              alt="Proof document"
              className="max-h-[82vh] max-w-full rounded-2xl border border-white/20 shadow-2xl object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  History,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { ChangeRequest, ChangeRequestFieldKey, UserProfile } from '../../types';
import {
  CHANGE_REQUEST_FIELD_LABELS,
  cancelPendingChangeRequest,
  fetchUserChangeRequests,
} from '../../lib/lockedFieldsService';
import { ChangeRequestForm } from './ChangeRequestForm';
import { useScrollToTop } from '../../utils/scrollToTop';

interface ChangeRequestsSectionProps {
  user: UserProfile;
  initialField?: ChangeRequestFieldKey;
  onPendingCountChange?: (count: number) => void;
}

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';

const PAGE_SIZE = 10;

function toMs(val: any): number {
  if (!val) return 0;
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (typeof val.toDate === 'function') return val.toDate().getTime();
  if (val.seconds) return val.seconds * 1000;
  const ms = new Date(val).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function formatDateTime(val: any): string {
  const ms = toMs(val);
  if (!ms) return 'Just now';
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDurationTaken(start: any, end: any): string {
  const s = toMs(start);
  const e = toMs(end);
  if (!s || !e || e <= s) return '';
  const mins = Math.round((e - s) / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

export const ChangeRequestsSection: React.FC<ChangeRequestsSectionProps> = ({
  user,
  initialField = 'shopName',
  onPendingCountChange,
}) => {
  useScrollToTop([]);

  const [activeTab, setActiveTab] = useState<'history' | 'new'>('history');
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedReq, setSelectedReq] = useState<ChangeRequest | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmCancelReq, setConfirmCancelReq] = useState<ChangeRequest | null>(null);
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToast({ text, type });
    setTimeout(() => {
      setToast((curr) => (curr?.text === text ? null : curr));
    }, 3500);
  };

  const loadHistory = useCallback(async () => {
    if (!user.uid) return;
    setLoading(true);
    try {
      const items = await fetchUserChangeRequests(user.uid);
      setRequests(items);
      const pendingCount = items.filter((r) => r.status === 'pending').length;
      onPendingCountChange?.(pendingCount);
    } catch (err) {
      console.error('Error loading change requests:', err);
    } finally {
      setLoading(false);
    }
  }, [user.uid, onPendingCountChange]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const filteredRequests = useMemo(() => {
    if (statusFilter === 'all') return requests;
    return requests.filter((r) => r.status === statusFilter);
  }, [requests, statusFilter]);

  const paginatedRequests = useMemo(
    () => filteredRequests.slice(0, visibleCount),
    [filteredRequests, visibleCount]
  );

  const pendingCount = useMemo(
    () => requests.filter((r) => r.status === 'pending').length,
    [requests]
  );

  const handleCancelRequest = async () => {
    if (!confirmCancelReq) return;
    setCancellingId(confirmCancelReq.id);
    try {
      await cancelPendingChangeRequest(confirmCancelReq.id);
      setConfirmCancelReq(null);
      setSelectedReq(null);
      await loadHistory();
      showToast('Request cancelled • আবেদন বাতিল করা হয়েছে', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to cancel request', 'error');
    } finally {
      setCancellingId(null);
    }
  };

  const renderStatusChip = (status: ChangeRequest['status']) => {
    switch (status) {
      case 'pending':
        return (
          <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-bold">
            Pending • অপেক্ষমাণ
          </span>
        );
      case 'approved':
        return (
          <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold">
            Approved • অনুমোদিত
          </span>
        );
      case 'rejected':
        return (
          <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-bold">
            Rejected • বাতিল
          </span>
        );
      case 'cancelled':
        return (
          <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-[10px] font-bold">
            Cancelled • প্রত্যাহৃত
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-3 pb-10">
      {toast && (
        <div
          className={`p-3 rounded-xl border text-[12px] font-bold flex items-center gap-2 shadow-xs ${
            toast.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span className="flex-1">{toast.text}</span>
        </div>
      )}

      {/* Top Segmented Tabs */}
      <div className="bg-white/90 backdrop-blur-xl rounded-xl border border-slate-200 p-1.5 flex items-center gap-1.5 shadow-2xs">
        <button
          type="button"
          onClick={() => setActiveTab('history')}
          className={`flex-1 h-10 rounded-lg text-[12.5px] font-bold flex items-center justify-center gap-1.5 transition cursor-pointer ${
            activeTab === 'history'
              ? 'bg-[#04203F] text-white shadow-xs'
              : 'text-slate-600 hover:bg-slate-50'
          }`}
        >
          <History className="w-3.5 h-3.5" />
          <span>My Requests</span>
          {pendingCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-white text-[10px] font-extrabold font-mono">
              {pendingCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('new')}
          className={`flex-1 h-10 rounded-lg text-[12.5px] font-bold flex items-center justify-center gap-1.5 transition cursor-pointer ${
            activeTab === 'new'
              ? 'bg-[#04203F] text-white shadow-xs'
              : 'text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Request • নতুন আবেদন</span>
        </button>
      </div>

      {/* TAB 1: MY REQUESTS */}
      {activeTab === 'history' && (
        <div className="space-y-3">
          {/* Status Filter Strip + Refresh */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'pending', label: 'Pending' },
                  { id: 'approved', label: 'Approved' },
                  { id: 'rejected', label: 'Rejected' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setStatusFilter(f.id);
                    setVisibleCount(PAGE_SIZE);
                  }}
                  className={`h-8 px-3 rounded-lg text-[11.5px] font-bold border transition cursor-pointer ${
                    statusFilter === f.id
                      ? 'bg-[#0E9AA7] border-[#0E9AA7] text-white'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={loadHistory}
              disabled={loading}
              className="h-8 px-2.5 rounded-lg bg-white border border-slate-200 text-slate-600 hover:text-slate-900 text-[11px] font-bold flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>

          {loading ? (
            <div className="bg-white rounded-xl border border-slate-200 p-8 flex items-center justify-center gap-2 text-[12.5px] text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin text-[#0E9AA7]" />
              <span>Loading change requests...</span>
            </div>
          ) : filteredRequests.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-6 text-center space-y-3 shadow-2xs">
              <div className="w-11 h-11 rounded-xl bg-teal-50 text-[#0E9AA7] border border-teal-100 flex items-center justify-center mx-auto">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="space-y-1 max-w-sm mx-auto">
                <h4 className="text-[15px] font-bold text-[#04203F]">
                  {statusFilter === 'all'
                    ? 'No Change Requests Yet • কোনো আবেদন নেই'
                    : `No ${statusFilter} requests`}
                </h4>
                <p className="text-[12px] text-slate-500 leading-relaxed">
                  Verified details like shop name, email, NID, birth certificate, date of birth, or
                  payout accounts require Super Admin approval to update safely.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('new')}
                className="h-10 px-4 rounded-xl bg-[#04203F] hover:bg-[#0B2D52] text-white text-[12.5px] font-bold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>New Request • নতুন আবেদন</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {paginatedRequests.map((req) => {
                const fieldMeta = CHANGE_REQUEST_FIELD_LABELS[req.fieldKey];
                const duration = formatDurationTaken(
                  req.createdAt,
                  req.decidedAt || req.reviewedAt || req.cancelledAt
                );
                return (
                  <button
                    key={req.id}
                    type="button"
                    onClick={() => setSelectedReq(req)}
                    className="w-full text-left bg-white hover:bg-slate-50/70 rounded-xl border border-slate-200 p-3 shadow-2xs transition cursor-pointer flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[11px] font-bold text-[#0E9AA7] bg-teal-50 px-1.5 py-0.5 rounded border border-teal-200">
                          {req.requestId || `CR-${req.id.slice(0, 6).toUpperCase()}`}
                        </span>
                        <span className="text-[13px] font-bold text-[#04203F] truncate">
                          {fieldMeta ? `${fieldMeta.en} (${fieldMeta.bn})` : req.fieldLabel}
                        </span>
                      </div>

                      <p className="text-[12px] text-slate-600 truncate">
                        New: <span className="font-semibold text-slate-800">{req.newValue || req.requestedValueSummary}</span>
                      </p>

                      <div className="flex items-center gap-2 text-[11px] text-slate-400">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDateTime(req.createdAt)}
                        </span>
                        {duration && <span>• {duration}</span>}
                      </div>
                    </div>

                    <div className="shrink-0 flex flex-col items-end gap-1">
                      {renderStatusChip(req.status)}
                    </div>
                  </button>
                );
              })}

              {filteredRequests.length > visibleCount && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                  className="w-full h-10 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-[12.5px] font-bold text-[#04203F] cursor-pointer"
                >
                  Load more ({filteredRequests.length - visibleCount} remaining)
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: NEW REQUEST */}
      {activeTab === 'new' && (
        <div className="bg-white rounded-xl border border-slate-200 p-3.5 sm:p-4 shadow-2xs">
          <ChangeRequestForm
            user={user}
            initialField={initialField}
            onSubmitted={async (msg) => {
              await loadHistory();
              setActiveTab('history');
              showToast(msg, 'success');
            }}
          />
        </div>
      )}

      {/* REQUEST DETAIL SHEET */}
      {selectedReq && (
        <div
          className="fixed inset-0 z-[75] bg-slate-900/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setSelectedReq(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-white rounded-t-2xl sm:rounded-2xl border border-slate-200 shadow-2xl max-h-[88dvh] flex flex-col overflow-hidden text-[12.5px]"
          >
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2 bg-slate-50">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-bold text-[#0E9AA7]">
                    {selectedReq.requestId || selectedReq.id.slice(0, 8)}
                  </span>
                  {renderStatusChip(selectedReq.status)}
                </div>
                <h4 className="text-[15px] font-bold text-[#04203F] truncate mt-0.5">
                  {CHANGE_REQUEST_FIELD_LABELS[selectedReq.fieldKey]?.en || selectedReq.fieldLabel}
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setSelectedReq(null)}
                className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-500 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-3">
              {/* Old vs New */}
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-2">
                <div>
                  <span className="text-[10.5px] font-bold text-slate-400 uppercase block">
                    Old Value (Masked) • আগের তথ্য
                  </span>
                  <span className="font-mono font-semibold text-slate-700">
                    {selectedReq.oldValueMasked || selectedReq.currentValueSummary || 'Not set'}
                  </span>
                </div>
                <div className="border-t border-slate-200 pt-2">
                  <span className="text-[10.5px] font-bold text-[#0E9AA7] uppercase block">
                    Requested New Value • নতুন তথ্য
                  </span>
                  <span className="font-bold text-[#04203F]">
                    {selectedReq.newValue || selectedReq.requestedValueSummary}
                  </span>
                </div>
              </div>

              {/* Reason */}
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                <span className="text-[10.5px] font-bold text-slate-400 uppercase block mb-0.5">
                  Your Reason • কারণ
                </span>
                <p className="text-slate-800">{selectedReq.reason}</p>
              </div>

              {/* Super Admin Decision / Rejection Note */}
              {(selectedReq.decisionNote || selectedReq.rejectionReason || selectedReq.adminNote) && (
                <div
                  className={`rounded-xl border p-3 ${
                    selectedReq.status === 'rejected'
                      ? 'bg-rose-50 border-rose-200 text-rose-800'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  }`}
                >
                  <span className="text-[10.5px] font-bold uppercase block mb-0.5">
                    Super Admin Response • সুপার অ্যাডমিনের মন্তব্য
                  </span>
                  <p className="font-medium">
                    {selectedReq.decisionNote || selectedReq.rejectionReason || selectedReq.adminNote}
                  </p>
                  {(selectedReq.decidedBy || selectedReq.reviewedByName) && (
                    <p className="text-[11px] opacity-80 mt-1">
                      Handled by {selectedReq.decidedBy || selectedReq.reviewedByName} •{' '}
                      {formatDateTime(selectedReq.decidedAt || selectedReq.reviewedAt)}
                    </p>
                  )}
                </div>
              )}

              {/* Attached Proof / Document Images */}
              {[
                selectedReq.newDocumentUrl,
                selectedReq.proofUrl,
                selectedReq.requestedData?.nidFrontUrl,
                selectedReq.requestedData?.nidBackUrl,
                selectedReq.requestedData?.birthCertificateUrl,
              ]
                .filter((u, idx, arr): u is string => Boolean(u) && arr.indexOf(u) === idx)
                .map((imgUrl, idx) => (
                  <button
                    key={imgUrl}
                    type="button"
                    onClick={() => setZoomImageUrl(imgUrl)}
                    className="w-full rounded-xl border border-slate-200 p-2 flex items-center gap-2.5 hover:border-[#0E9AA7] cursor-pointer text-left"
                  >
                    <img
                      src={imgUrl}
                      alt={`Attachment ${idx + 1}`}
                      className="w-12 h-12 rounded-lg object-cover bg-slate-100"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-slate-800 text-[12px]">
                        Attached Document #{idx + 1}
                      </p>
                      <p className="text-[11px] text-[#0E9AA7] flex items-center gap-1">
                        Tap to zoom <ExternalLink className="w-3 h-3" />
                      </p>
                    </div>
                  </button>
                ))}

              {/* 3-step Status Timeline */}
              <div className="rounded-xl border border-slate-200 p-3 space-y-2">
                <span className="text-[10.5px] font-bold text-slate-400 uppercase block">
                  Timeline • সময়রেখা
                </span>
                <div className="space-y-1.5 text-[11.5px]">
                  <div className="flex items-center justify-between text-slate-800">
                    <span className="font-semibold flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      Submitted
                    </span>
                    <span className="text-slate-500">{formatDateTime(selectedReq.createdAt)}</span>
                  </div>
                  <div className="flex items-center justify-between text-slate-700">
                    <span className="font-semibold flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-[#0E9AA7]" />
                      Under Super Admin Review
                    </span>
                    <span className="text-slate-500">
                      {selectedReq.status === 'pending' ? 'Active' : 'Completed'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-800">
                    <span className="font-semibold flex items-center gap-1.5">
                      {selectedReq.status === 'rejected' || selectedReq.status === 'cancelled' ? (
                        <XCircle className="w-3.5 h-3.5 text-rose-500" />
                      ) : (
                        <CheckCircle2
                          className={`w-3.5 h-3.5 ${
                            selectedReq.status === 'approved' ? 'text-emerald-600' : 'text-slate-300'
                          }`}
                        />
                      )}
                      Decision
                    </span>
                    <span className="text-slate-500 capitalize">
                      {selectedReq.status === 'pending'
                        ? 'Awaiting'
                        : `${selectedReq.status} (${formatDateTime(
                            selectedReq.decidedAt || selectedReq.reviewedAt || selectedReq.cancelledAt
                          )})`}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {selectedReq.status === 'pending' && (
              <div className="p-3 border-t border-slate-100 bg-slate-50">
                <button
                  type="button"
                  onClick={() => setConfirmCancelReq(selectedReq)}
                  className="w-full h-10 rounded-xl border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-[12.5px] font-bold cursor-pointer"
                >
                  Cancel Request • আবেদন বাতিল করুন
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm Cancel Dialog */}
      {confirmCancelReq && (
        <div
          className="fixed inset-0 z-[85] bg-slate-900/65 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => !cancellingId && setConfirmCancelReq(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-white rounded-2xl p-4 space-y-3 border border-slate-200 shadow-2xl"
          >
            <h4 className="text-[15px] font-bold text-slate-900">
              Cancel this pending request?
            </h4>
            <p className="text-[12px] text-slate-500">
              Your request{' '}
              <span className="font-mono font-bold text-slate-700">
                {confirmCancelReq.requestId || confirmCancelReq.id.slice(0, 8)}
              </span>{' '}
              will be marked as cancelled in history.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={Boolean(cancellingId)}
                onClick={() => setConfirmCancelReq(null)}
                className="flex-1 h-10 rounded-xl border border-slate-200 font-bold text-[12.5px] text-slate-700 cursor-pointer"
              >
                Keep
              </button>
              <button
                type="button"
                disabled={Boolean(cancellingId)}
                onClick={handleCancelRequest}
                className="flex-1 h-10 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-[12.5px] cursor-pointer disabled:opacity-50"
              >
                {cancellingId ? 'Cancelling...' : 'Yes, Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Lightbox */}
      {zoomImageUrl && (
        <div
          className="fixed inset-0 z-[90] bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setZoomImageUrl(null)}
        >
          <div className="relative max-w-2xl max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setZoomImageUrl(null)}
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white text-slate-900 shadow-lg flex items-center justify-center cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={zoomImageUrl}
              alt="Document preview"
              className="max-h-[82vh] max-w-full rounded-2xl border border-white/20 object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
};

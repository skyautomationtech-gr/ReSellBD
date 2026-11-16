import React, { useEffect, useState } from 'react';
import { Filter, RotateCcw, X } from 'lucide-react';
import { BANGLADESH_GEO } from '../../../data/bangladeshGeo';
import {
  DEFAULT_DIRECTORY_FILTERS,
  DirectoryAdvancedFilters,
} from '../../../lib/resellerDirectoryService';

interface DirectoryFiltersSheetProps {
  isOpen: boolean;
  onClose: () => void;
  filters: DirectoryAdvancedFilters;
  onApply: (next: DirectoryAdvancedFilters) => void;
}

export const DirectoryFiltersSheet: React.FC<DirectoryFiltersSheetProps> = ({
  isOpen,
  onClose,
  filters,
  onApply,
}) => {
  const [draft, setDraft] = useState<DirectoryAdvancedFilters>(filters);

  useEffect(() => {
    if (isOpen) {
      setDraft(filters);
    }
  }, [isOpen, filters]);

  if (!isOpen) return null;

  const allDistricts = Object.values(BANGLADESH_GEO)
    .flatMap((divObj) => Object.keys(divObj))
    .sort((a, b) => a.localeCompare(b));

  const upazilasForDistrict = (() => {
    if (!draft.district) return [];
    for (const divObj of Object.values(BANGLADESH_GEO)) {
      if (divObj[draft.district]) {
        return [...divObj[draft.district]].sort((a, b) => a.localeCompare(b));
      }
    }
    return [];
  })();

  const handleReset = () => {
    setDraft(DEFAULT_DIRECTORY_FILTERS);
    onApply(DEFAULT_DIRECTORY_FILTERS);
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onApply(draft);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-[2px]">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl h-full border-l border-slate-200 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-slate-200/80 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-[#04203F]">
              <Filter className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">Advanced Filters</h3>
              <p className="text-[11px] text-slate-500">Narrow down accounts by region & activity</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-50 cursor-pointer"
            aria-label="Close filters"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 space-y-4 text-[12px]">
          {/* Location */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">
                District
              </label>
              <select
                value={draft.district}
                onChange={(e) =>
                  setDraft({ ...draft, district: e.target.value, upazila: '' })
                }
                className="w-full h-[36px] px-2.5 rounded-xl border border-slate-200 bg-white text-[12px] text-slate-800 outline-none focus:border-[#0E9AA7]"
              >
                <option value="">All Districts</option>
                {allDistricts.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">
                Upazila / Thana
              </label>
              <select
                value={draft.upazila}
                disabled={!draft.district}
                onChange={(e) => setDraft({ ...draft, upazila: e.target.value })}
                className="w-full h-[36px] px-2.5 rounded-xl border border-slate-200 bg-white text-[12px] text-slate-800 outline-none focus:border-[#0E9AA7] disabled:bg-slate-50 disabled:text-slate-400"
              >
                <option value="">All Areas</option>
                {upazilasForDistrict.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Commission Type */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">
              Commission Rate Type
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'global', label: 'Global' },
                  { id: 'custom', label: 'Custom' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft({ ...draft, commissionType: opt.id })}
                  className={`h-[34px] rounded-xl text-[12px] font-semibold border transition-colors cursor-pointer ${
                    draft.commissionType === opt.id
                      ? 'bg-[#04203F] text-white border-[#04203F]'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Has Orders */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">
              Order Activity
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'yes', label: 'Has Orders' },
                  { id: 'no', label: 'No Orders' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft({ ...draft, hasOrders: opt.id })}
                  className={`h-[34px] rounded-xl text-[12px] font-semibold border transition-colors cursor-pointer ${
                    draft.hasOrders === opt.id
                      ? 'bg-[#04203F] text-white border-[#04203F]'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Inactive Duration */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">
              Inactivity Window
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'all', label: 'Anytime' },
                  { id: '7', label: 'Inactive 7d+' },
                  { id: '30', label: 'Inactive 30d+' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft({ ...draft, inactiveDays: opt.id })}
                  className={`h-[34px] rounded-xl text-[12px] font-semibold border transition-colors cursor-pointer ${
                    draft.inactiveDays === opt.id
                      ? 'bg-[#04203F] text-white border-[#04203F]'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Payout Method */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">
              Payout Method Type
            </label>
            <select
              value={draft.payoutMethod}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  payoutMethod: e.target.value as DirectoryAdvancedFilters['payoutMethod'],
                })
              }
              className="w-full h-[36px] px-2.5 rounded-xl border border-slate-200 bg-white text-[12px] text-slate-800 outline-none focus:border-[#0E9AA7]"
            >
              <option value="all">All Payout Methods</option>
              <option value="bkash">bKash</option>
              <option value="nagad">Nagad</option>
              <option value="rocket">Rocket</option>
              <option value="upay">Upay</option>
              <option value="bank">Bank Account</option>
              <option value="none">No Payout Configured</option>
            </select>
          </div>

          {/* Documents Missing Toggle */}
          <label className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 bg-slate-50/70 cursor-pointer">
            <div>
              <span className="block text-[12px] font-bold text-slate-800">
                Documents Missing Only
              </span>
              <span className="block text-[11px] text-slate-500">
                Show accounts missing NID or Birth Certificate
              </span>
            </div>
            <input
              type="checkbox"
              checked={draft.documentsMissing}
              onChange={(e) => setDraft({ ...draft, documentsMissing: e.target.checked })}
              className="w-4 h-4 accent-[#04203F] rounded"
            />
          </label>

          {/* Joined Date Range */}
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">
              Joined Date Range
            </label>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <span className="block text-[10px] text-slate-400 mb-0.5">From</span>
                <input
                  type="date"
                  value={draft.joinedFrom}
                  onChange={(e) => setDraft({ ...draft, joinedFrom: e.target.value })}
                  className="w-full h-[36px] px-2.5 rounded-xl border border-slate-200 bg-white text-[12px] text-slate-800 outline-none focus:border-[#0E9AA7]"
                />
              </div>
              <div>
                <span className="block text-[10px] text-slate-400 mb-0.5">To</span>
                <input
                  type="date"
                  value={draft.joinedTo}
                  onChange={(e) => setDraft({ ...draft, joinedTo: e.target.value })}
                  className="w-full h-[36px] px-2.5 rounded-xl border border-slate-200 bg-white text-[12px] text-slate-800 outline-none focus:border-[#0E9AA7]"
                />
              </div>
            </div>
          </div>

          {/* Sticky Footer */}
          <div className="pt-3 border-t border-slate-200 flex items-center gap-2">
            <button
              type="button"
              onClick={handleReset}
              className="h-[38px] px-3.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
            <button
              type="submit"
              className="flex-1 h-[38px] px-4 rounded-xl bg-[#04203F] hover:bg-[#073363] text-white text-[12px] font-bold cursor-pointer"
            >
              Apply Filters
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
};

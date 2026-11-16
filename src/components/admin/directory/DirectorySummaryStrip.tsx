import React from 'react';
import {
  Ban,
  CheckCircle2,
  Clock,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';
import {
  DirectoryStatusFilter,
  ResellerSummaryMetrics,
} from '../../../lib/resellerDirectoryService';

interface DirectorySummaryStripProps {
  metrics: ResellerSummaryMetrics | null;
  loading: boolean;
  isSuperAdmin: boolean;
  activeStatus: DirectoryStatusFilter;
  onSelectStatus: (status: DirectoryStatusFilter) => void;
}

export const DirectorySummaryStrip: React.FC<DirectorySummaryStripProps> = ({
  metrics,
  loading,
  isSuperAdmin,
  activeStatus,
  onSelectStatus,
}) => {
  const tileCols = isSuperAdmin
    ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
    : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5';

  if (loading && !metrics) {
    return (
      <div className={`grid ${tileCols} gap-2.5`}>
        {Array.from({ length: isSuperAdmin ? 6 : 5 }).map((_, idx) => (
          <div
            key={idx}
            className="h-[68px] rounded-xl bg-white/80 border border-slate-200/80 p-3 animate-pulse flex flex-col justify-between"
          >
            <div className="h-2.5 w-20 bg-slate-200 rounded" />
            <div className="h-5 w-12 bg-slate-200 rounded" />
          </div>
        ))}
      </div>
    );
  }

  const m = metrics || {
    totalResellers: 0,
    activeCount: 0,
    pendingCount: 0,
    pendingOver1hCount: 0,
    suspendedCount: 0,
    rejectedCount: 0,
    newThisWeekCount: 0,
    teamCount: 0,
    totalWalletBalance: null,
  };

  const tiles: Array<{
    id: string;
    label: string;
    value: string;
    icon: React.ReactNode;
    filterStatus?: DirectoryStatusFilter;
    badge?: string | null;
    toneClass: string;
  }> = [
    {
      id: 'total',
      label: 'Total Resellers',
      value: m.totalResellers.toLocaleString(),
      icon: <Users className="w-3.5 h-3.5 text-[#04203F]" />,
      filterStatus: 'all',
      toneClass: 'text-[#04203F]',
    },
    {
      id: 'active',
      label: 'Active',
      value: m.activeCount.toLocaleString(),
      icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
      filterStatus: 'approved',
      toneClass: 'text-emerald-700',
    },
    {
      id: 'pending',
      label: 'Pending',
      value: m.pendingCount.toLocaleString(),
      icon: <Clock className="w-3.5 h-3.5 text-amber-600" />,
      filterStatus: 'pending',
      badge: m.pendingOver1hCount > 0 ? `${m.pendingOver1hCount} >1h` : null,
      toneClass: 'text-amber-700',
    },
    {
      id: 'suspended',
      label: 'Suspended',
      value: m.suspendedCount.toLocaleString(),
      icon: <Ban className="w-3.5 h-3.5 text-rose-600" />,
      filterStatus: 'suspended',
      toneClass: 'text-rose-700',
    },
    {
      id: 'new_week',
      label: 'New This Week',
      value: m.newThisWeekCount.toLocaleString(),
      icon: <Sparkles className="w-3.5 h-3.5 text-[#0E9AA7]" />,
      toneClass: 'text-[#0E9AA7]',
    },
  ];

  if (isSuperAdmin) {
    tiles.push({
      id: 'wallet_total',
      label: 'Total Wallet',
      value:
        m.totalWalletBalance !== null
          ? `৳${Math.round(m.totalWalletBalance).toLocaleString()}`
          : '—',
      icon: <Wallet className="w-3.5 h-3.5 text-[#04203F]" />,
      toneClass: 'text-[#04203F]',
    });
  }

  return (
    <div className={`grid ${tileCols} gap-2.5`}>
      {tiles.map((tile) => {
        const isClickable = Boolean(tile.filterStatus);
        const isActive = tile.filterStatus && activeStatus === tile.filterStatus;

        return (
          <button
            key={tile.id}
            type="button"
            disabled={!isClickable}
            onClick={() => tile.filterStatus && onSelectStatus(tile.filterStatus)}
            className={`text-left rounded-xl px-3 py-2.5 border transition-colors duration-150 bg-white/85 backdrop-blur-md ${
              isActive
                ? 'border-[#0E9AA7] ring-1 ring-[#0E9AA7]/25 bg-cyan-50/40'
                : 'border-slate-200/85 hover:border-slate-300'
            } ${isClickable ? 'cursor-pointer' : 'cursor-default'}`}
          >
            <div className="flex items-center justify-between gap-1.5">
              <span className="text-[11px] font-semibold text-slate-500 truncate">
                {tile.label}
              </span>
              {tile.icon}
            </div>
            <div className="mt-1 flex items-center justify-between gap-1.5">
              <span
                className={`text-[17px] leading-tight font-extrabold tabular-nums ${tile.toneClass}`}
              >
                {tile.value}
              </span>
              {tile.badge && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-rose-600 text-white text-[10px] font-bold tabular-nums shrink-0">
                  {tile.badge}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
};

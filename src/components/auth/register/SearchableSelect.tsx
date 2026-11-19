import React, { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, ChevronDown, Check, X, MapPin } from 'lucide-react';

export interface SelectOption {
  id: string;
  name: string;
  bn_name?: string;
  badge?: string;
  subtitle?: string;
  postOffice?: string;
  postalCode?: string;
  isCity?: boolean;
  cityCorpId?: string;
}

interface SearchableSelectProps {
  label: string;
  placeholder?: string;
  options: SelectOption[];
  value: string; // Current name or ID
  onChange: (option: SelectOption | null, customText?: string) => void;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  allowCustom?: boolean;
  customValue?: string;
  onCustomChange?: (val: string) => void;
  helperText?: string;
  theme?: 'dark' | 'light';
}

export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  label,
  placeholder = 'Select option...',
  options,
  value,
  onChange,
  disabled = false,
  required = false,
  error,
  allowCustom = true,
  customValue = '',
  onCustomChange,
  helperText,
  theme = 'dark',
}) => {
  const isLight = theme === 'light';
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCustomMode, setIsCustomMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  const filteredOptions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return options.slice(0, 100);
    return options
      .filter((opt) => {
        const en = (opt.name || '').toLowerCase();
        const bn = (opt.bn_name || '').toLowerCase();
        const po = (opt.postOffice || '').toLowerCase();
        const pc = (opt.postalCode || '').toLowerCase();
        return en.includes(q) || bn.includes(q) || po.includes(q) || pc.includes(q);
      })
      .slice(0, 100);
  }, [options, searchQuery]);

  const selectedOption = useMemo(() => {
    return options.find((opt) => opt.name.toLowerCase() === value.toLowerCase() || opt.id === value);
  }, [options, value]);

  const handleSelect = (option: SelectOption) => {
    setIsCustomMode(false);
    onChange(option);
    setIsOpen(false);
  };

  const handleChooseCustom = () => {
    setIsCustomMode(true);
    onChange(null, customValue || '');
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative w-full space-y-1">
      <div className="flex items-center justify-between">
        <label
          className={`text-[12px] font-bold tracking-wide flex items-center gap-1 ${
            isLight ? 'text-slate-700' : 'text-slate-200'
          }`}
        >
          {label}{' '}
          {required && (
            <span className={isLight ? 'text-rose-500 font-black' : 'text-[#3DD055] font-black'}>
              *
            </span>
          )}
        </label>
        {isCustomMode && (
          <button
            type="button"
            onClick={() => {
              setIsCustomMode(false);
              onChange(null);
            }}
            className="text-[11px] text-[#0E9AA7] hover:underline font-semibold cursor-pointer"
          >
            ← Back to list
          </button>
        )}
      </div>

      {isCustomMode ? (
        <div className="relative">
          <input
            type="text"
            placeholder={`Enter custom ${label.toLowerCase()}...`}
            value={customValue}
            onChange={(e) => {
              if (onCustomChange) onCustomChange(e.target.value);
            }}
            className={
              isLight
                ? 'w-full h-10 px-3 bg-white border border-slate-200 rounded-[12px] text-[#04203F] placeholder:text-slate-400 text-[13px] font-medium outline-none focus:border-[#0E9AA7] focus:ring-2 focus:ring-[#0E9AA7]/20 transition-all'
                : 'w-full min-h-[50px] px-4 py-3 bg-white/[0.08] backdrop-blur-[24px] border border-white/20 rounded-2xl text-white placeholder-slate-400 text-sm font-semibold outline-none focus:border-[#3DD055] focus:ring-2 focus:ring-[#0E9AA7]/50 transition-all shadow-[0_4px_20px_rgba(0,0,0,0.15)]'
            }
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setIsOpen(!isOpen)}
          className={
            isLight
              ? `w-full h-10 px-3 bg-white border rounded-[12px] text-left flex items-center justify-between transition-all cursor-pointer select-none ${
                  disabled
                    ? 'opacity-50 cursor-not-allowed bg-slate-100 border-slate-200'
                    : error
                    ? 'border-rose-400 ring-2 ring-rose-500/15'
                    : isOpen
                    ? 'border-[#0E9AA7] ring-2 ring-[#0E9AA7]/20'
                    : 'border-slate-200 hover:border-slate-300'
                }`
              : `w-full min-h-[50px] px-4 py-3 bg-white/[0.08] backdrop-blur-[24px] border rounded-2xl text-left flex items-center justify-between transition-all cursor-pointer select-none ${
                  disabled
                    ? 'opacity-40 cursor-not-allowed border-white/10'
                    : error
                    ? 'border-rose-500/80 ring-2 ring-rose-500/20'
                    : isOpen
                    ? 'border-[#3DD055] ring-2 ring-[#0E9AA7]/50 shadow-[0_0_20px_rgba(14,154,167,0.25)]'
                    : 'border-white/20 hover:border-white/35 hover:bg-white/[0.11]'
                }`
          }
        >
          <div className="flex items-center gap-2 min-w-0 pr-2">
            <MapPin
              className={`w-4 h-4 shrink-0 ${
                value ? (isLight ? 'text-[#0E9AA7]' : 'text-[#3DD055]') : 'text-slate-400'
              }`}
            />
            <span
              className={`truncate font-medium ${isLight ? 'text-[13px]' : 'text-sm'} ${
                value
                  ? isLight
                    ? 'text-[#04203F] font-semibold'
                    : 'text-white font-semibold'
                  : 'text-slate-400'
              }`}
            >
              {selectedOption ? (
                <>
                  {selectedOption.name}
                  {selectedOption.bn_name && (
                    <span className="text-slate-400 ml-1.5 font-normal text-xs">
                      ({selectedOption.bn_name})
                    </span>
                  )}
                  {selectedOption.badge && (
                    <span
                      className={`ml-2 text-[10px] px-1.5 py-0.5 rounded font-bold border ${
                        isLight
                          ? 'bg-teal-50 text-[#0E9AA7] border-teal-200'
                          : 'bg-cyan-500/25 text-cyan-300 border-cyan-400/30'
                      }`}
                    >
                      {selectedOption.badge}
                    </span>
                  )}
                </>
              ) : value ? (
                value
              ) : (
                placeholder
              )}
            </span>
          </div>
          <ChevronDown
            className={`w-4 h-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${
              isLight ? 'text-slate-400' : 'text-slate-300'
            } ${isOpen ? (isLight ? 'rotate-180 text-[#0E9AA7]' : 'rotate-180 text-[#3DD055]') : ''}`}
          />
        </button>
      )}

      {helperText && !error && (
        <p className={`text-[11px] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>{helperText}</p>
      )}
      {error && (
        <p
          className={`text-[11px] font-semibold flex items-center gap-1 mt-1 ${
            isLight ? 'text-rose-600' : 'text-rose-400'
          }`}
        >
          <span>{error}</span>
        </p>
      )}

      {/* Dropdown Menu Modal */}
      <AnimatePresence>
        {isOpen && !disabled && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            className={
              isLight
                ? 'absolute left-0 right-0 top-full mt-1.5 bg-white/98 backdrop-blur-xl border border-slate-200 rounded-[12px] shadow-[0_14px_34px_rgba(4,32,63,0.16)] z-50 overflow-hidden'
                : 'absolute left-0 right-0 top-full mt-2 bg-[#09152C]/95 backdrop-blur-[28px] border border-white/25 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.6),0_0_25px_rgba(14,154,167,0.2)] z-50 overflow-hidden'
            }
          >
            {/* Search Input Header */}
            <div className={`p-2 border-b relative ${isLight ? 'border-slate-100' : 'border-white/10'}`}>
              <Search className="w-4 h-4 text-slate-400 absolute left-4.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder={`Search ${options.length} ${label.toLowerCase()}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={
                  isLight
                    ? 'w-full h-9 pl-8 pr-8 bg-slate-50 border border-slate-200 rounded-lg text-[12.5px] text-[#04203F] placeholder:text-slate-400 outline-none focus:border-[#0E9AA7] transition-colors'
                    : 'w-full pl-9 pr-8 py-2 bg-white/[0.08] border border-white/15 rounded-xl text-xs sm:text-sm text-white placeholder-slate-400 outline-none focus:border-[#3DD055] transition-colors'
                }
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className={`absolute right-3.5 top-1/2 -translate-y-1/2 p-1 cursor-pointer ${
                    isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Options List */}
            <div
              className={`max-h-56 overflow-y-auto p-1 divide-y ${
                isLight ? 'divide-slate-100' : 'scrollbar-thin scrollbar-thumb-slate-700/80 divide-white/[0.04]'
              }`}
            >
              {filteredOptions.length > 0 ? (
                filteredOptions.map((opt) => {
                  const isSelected =
                    (value || '').toLowerCase() === opt.name.toLowerCase() || value === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => handleSelect(opt)}
                      className={`w-full px-3 py-2 rounded-lg text-left text-[12.5px] flex items-center justify-between transition-colors cursor-pointer ${
                        isLight
                          ? isSelected
                            ? 'bg-teal-50 text-[#0E9AA7] font-bold'
                            : 'text-slate-700 hover:bg-slate-50 font-medium'
                          : isSelected
                          ? 'bg-[#3DD055]/20 text-[#3DD055] font-bold'
                          : 'text-slate-200 hover:bg-white/[0.08] hover:text-white font-medium'
                      }`}
                    >
                      <div className="flex flex-col truncate pr-2">
                        <div className="flex items-center gap-1.5">
                          <span>{opt.name}</span>
                          {opt.bn_name && (
                            <span className="text-slate-400 text-[11px] font-normal">
                              ({opt.bn_name})
                            </span>
                          )}
                          {opt.badge && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${
                                isLight
                                  ? 'bg-teal-50 text-[#0E9AA7] border-teal-200'
                                  : 'bg-cyan-500/20 text-cyan-300 border-cyan-400/30'
                              }`}
                            >
                              {opt.badge}
                            </span>
                          )}
                        </div>
                        {opt.subtitle && (
                          <span className="text-[11px] text-slate-400 font-normal mt-0.5">
                            {opt.subtitle}
                          </span>
                        )}
                      </div>
                      {isSelected && (
                        <Check
                          className={`w-4 h-4 shrink-0 ${
                            isLight ? 'text-[#0E9AA7]' : 'text-[#3DD055]'
                          }`}
                        />
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="p-4 text-center text-xs text-slate-400">
                  No matching {label.toLowerCase()} found.
                </div>
              )}

              {/* Allow Custom / Other Option */}
              {allowCustom && (
                <div className={`p-1 pt-1.5 border-t ${isLight ? 'border-slate-100' : 'border-white/10'}`}>
                  <button
                    type="button"
                    onClick={handleChooseCustom}
                    className="w-full px-3 py-2 rounded-lg text-left text-xs text-[#0E9AA7] hover:bg-[#0E9AA7]/10 transition-colors font-bold flex items-center justify-between cursor-pointer"
                  >
                    <span>+ Not listed / Type Other</span>
                    <span className="text-[10px] bg-[#0E9AA7]/15 px-1.5 py-0.5 rounded text-[#0E9AA7]">
                      Custom
                    </span>
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

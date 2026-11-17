import React from 'react';
import {
  BdDivision,
  BdDistrict,
  BdUpazilaThana,
} from '../../../data/bd/geocodeService';
import {
  CartCustomerDetails,
  SavedCustomerProfile,
} from './orderCalculations';
import {
  AlertTriangle,
  BookmarkCheck,
  ChevronDown,
  ChevronUp,
  Search,
  Truck,
  User,
  UserCheck,
  X,
} from 'lucide-react';

interface CustomerDeliveryFormProps {
  idPrefix?: string;
  customer: CartCustomerDetails;
  onChangeCustomer: (next: CartCustomerDetails) => void;
  customerErrors: Record<string, string>;
  onClearFieldError: (fields: string[]) => void;
  divisions: BdDivision[];
  districts: BdDistrict[];
  upazilas: BdUpazilaThana[];
  advanceDraft: string;
  onChangeAdvanceDraft: (value: string) => void;
  customerPaysTotal: number;
  codPayableOnDelivery: number;
  clampedAdvance: number;
  deliveryCharge: number;
  isInsideDhaka: boolean;
  // Collapsible mode (used inside Cart drawer)
  collapsible?: boolean;
  isOpen?: boolean;
  onToggleOpen?: () => void;
  // Optional Saved Customers picker + Save checkbox (used in New Order Step 3)
  savedCustomers?: SavedCustomerProfile[];
  onSelectSavedCustomer?: (profile: SavedCustomerProfile) => void;
  saveThisCustomer?: boolean;
  onToggleSaveThisCustomer?: (checked: boolean) => void;
  // Optional 24h duplicate order alert
  duplicateOrderWarning?: string | null;
}

export const CustomerDeliveryForm: React.FC<CustomerDeliveryFormProps> = ({
  idPrefix = 'order',
  customer,
  onChangeCustomer,
  customerErrors,
  onClearFieldError,
  divisions,
  districts,
  upazilas,
  advanceDraft,
  onChangeAdvanceDraft,
  customerPaysTotal,
  codPayableOnDelivery,
  clampedAdvance,
  deliveryCharge,
  isInsideDhaka,
  collapsible = false,
  isOpen = true,
  onToggleOpen,
  savedCustomers = [],
  onSelectSavedCustomer,
  saveThisCustomer,
  onToggleSaveThisCustomer,
  duplicateOrderWarning,
}) => {
  const [customerSearch, setCustomerSearch] = React.useState('');
  const [showSavedPicker, setShowSavedPicker] = React.useState(false);

  const filteredSavedCustomers = React.useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return savedCustomers.slice(0, 12);
    return savedCustomers
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.mobile.toLowerCase().includes(q) ||
          c.districtName.toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [savedCustomers, customerSearch]);

  const showBody = collapsible ? isOpen : true;

  return (
    <div className="bg-white/95 border border-slate-200/90 rounded-xl overflow-hidden">
      {collapsible ? (
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={isOpen}
          className="w-full px-3.5 py-3 flex items-center justify-between gap-2 text-left hover:bg-slate-50/70 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <div className="flex items-center gap-2 min-w-0">
            <User className="w-4 h-4 text-slate-600 shrink-0" />
            <div className="min-w-0">
              <span className="text-[13px] font-bold text-slate-900 block">
                Customer & Delivery Details
              </span>
              <span className="text-[11.5px] text-slate-500 block truncate">
                {customer.name
                  ? `${customer.name}${
                      customer.mobile ? ` · ${customer.mobile}` : ''
                    }${
                      customer.districtName ? ` · ${customer.districtName}` : ''
                    }`
                  : 'Name, mobile, Bangladesh area & address'}
              </span>
            </div>
          </div>
          {isOpen ? (
            <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
          )}
        </button>
      ) : (
        <div className="px-3.5 py-3 border-b border-slate-100 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <User className="w-4 h-4 text-slate-600 shrink-0" />
            <span className="text-[13px] font-bold text-slate-900">
              Customer & Delivery Details
            </span>
          </div>

          {savedCustomers.length > 0 && onSelectSavedCustomer && (
            <button
              type="button"
              onClick={() => setShowSavedPicker((v) => !v)}
              className={`min-h-[34px] px-2.5 rounded-lg text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                showSavedPicker
                  ? 'bg-slate-900 text-white'
                  : 'bg-blue-50 hover:bg-blue-100 text-blue-700'
              }`}
            >
              <UserCheck className="w-3.5 h-3.5" />
              <span>Saved customers ({savedCustomers.length})</span>
            </button>
          )}
        </div>
      )}

      {showBody && (
        <div
          className={`px-3.5 pb-3.5 pt-2.5 ${
            collapsible ? 'border-t border-slate-100' : ''
          } space-y-3 text-[12.5px]`}
        >
          {/* Saved Customers Picker Drawer/Panel */}
          {savedCustomers.length > 0 && onSelectSavedCustomer && (collapsible || showSavedPicker) && (
            <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] font-bold text-slate-700 flex items-center gap-1.5">
                  <UserCheck className="w-3.5 h-3.5 text-blue-600" />
                  <span>Quick fill from saved / past customers</span>
                </span>
                {showSavedPicker && (
                  <button
                    type="button"
                    onClick={() => setShowSavedPicker(false)}
                    aria-label="Close saved customers"
                    className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {savedCustomers.length > 4 && (
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Filter by name, phone, or district..."
                    className="w-full h-[34px] pl-8 pr-3 rounded-lg border border-slate-200 bg-white text-[12px] text-slate-900 outline-none focus:border-blue-500"
                  />
                </div>
              )}

              <div className="flex gap-2 overflow-x-auto pb-1">
                {filteredSavedCustomers.map((saved) => (
                  <button
                    key={saved.id}
                    type="button"
                    onClick={() => {
                      onSelectSavedCustomer(saved);
                      setShowSavedPicker(false);
                    }}
                    className="shrink-0 max-w-[200px] text-left p-2 rounded-lg bg-white hover:bg-blue-50/60 border border-slate-200 hover:border-blue-400 transition-colors cursor-pointer"
                  >
                    <p className="text-[12px] font-bold text-slate-900 truncate">
                      {saved.name}
                    </p>
                    <p className="text-[11px] font-mono text-slate-600 truncate">
                      {saved.mobile}
                    </p>
                    <p className="text-[10.5px] text-slate-400 truncate mt-0.5">
                      {saved.districtName || saved.address}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Duplicate Order Warning (Same mobile + product within 24h) */}
          {duplicateOrderWarning && (
            <div
              role="alert"
              className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-[12px] flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="leading-snug">{duplicateOrderWarning}</p>
            </div>
          )}

          {/* Name & Primary Mobile */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="space-y-1">
              <label
                htmlFor={`${idPrefix}-cust-name`}
                className="text-[11.5px] font-semibold text-slate-700 block"
              >
                Customer Name <span className="text-rose-500">*</span>
              </label>
              <input
                id={`${idPrefix}-cust-name`}
                type="text"
                placeholder="e.g. Rahat Ahmed"
                value={customer.name}
                onChange={(e) => {
                  onChangeCustomer({ ...customer, name: e.target.value });
                  if (customerErrors.name) onClearFieldError(['name']);
                }}
                className={`w-full h-[40px] px-3 rounded-xl border text-[12.5px] text-slate-900 outline-none transition-colors ${
                  customerErrors.name
                    ? 'border-rose-400 bg-rose-50/40'
                    : 'border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500'
                }`}
              />
              {customerErrors.name && (
                <p className="text-[11px] text-rose-600">
                  {customerErrors.name}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <label
                htmlFor={`${idPrefix}-cust-mobile`}
                className="text-[11.5px] font-semibold text-slate-700 block"
              >
                Mobile (BD) <span className="text-rose-500">*</span>
              </label>
              <input
                id={`${idPrefix}-cust-mobile`}
                type="tel"
                inputMode="numeric"
                placeholder="01712345678"
                value={customer.mobile}
                onChange={(e) => {
                  onChangeCustomer({ ...customer, mobile: e.target.value });
                  if (customerErrors.mobile) onClearFieldError(['mobile']);
                }}
                className={`w-full h-[40px] px-3 rounded-xl border text-[12.5px] text-slate-900 tabular-nums outline-none transition-colors ${
                  customerErrors.mobile
                    ? 'border-rose-400 bg-rose-50/40'
                    : 'border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500'
                }`}
              />
              {customerErrors.mobile && (
                <p className="text-[11px] text-rose-600">
                  {customerErrors.mobile}
                </p>
              )}
            </div>
          </div>

          {/* Alternate Mobile */}
          <div className="space-y-1">
            <label
              htmlFor={`${idPrefix}-cust-alt-mobile`}
              className="text-[11.5px] font-semibold text-slate-700 block"
            >
              Alternate Mobile (Optional)
            </label>
            <input
              id={`${idPrefix}-cust-alt-mobile`}
              type="tel"
              inputMode="numeric"
              placeholder="018XXXXXXXX"
              value={customer.altMobile}
              onChange={(e) => {
                onChangeCustomer({
                  ...customer,
                  altMobile: e.target.value,
                });
                if (customerErrors.altMobile) onClearFieldError(['altMobile']);
              }}
              className={`w-full h-[40px] px-3 rounded-xl border text-[12.5px] text-slate-900 tabular-nums outline-none transition-colors ${
                customerErrors.altMobile
                  ? 'border-rose-400 bg-rose-50/40'
                  : 'border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500'
              }`}
            />
            {customerErrors.altMobile && (
              <p className="text-[11px] text-rose-600">
                {customerErrors.altMobile}
              </p>
            )}
          </div>

          {/* Bangladesh Geo Area Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1">
              <label
                htmlFor={`${idPrefix}-cust-division`}
                className="text-[11.5px] font-semibold text-slate-700 block"
              >
                Division <span className="text-rose-500">*</span>
              </label>
              <select
                id={`${idPrefix}-cust-division`}
                value={customer.divisionId}
                onChange={(e) => {
                  const div = divisions.find((d) => d.id === e.target.value);
                  onChangeCustomer({
                    ...customer,
                    divisionId: div ? div.id : '',
                    divisionName: div ? div.name : '',
                    districtId: '',
                    districtName: '',
                    upazilaId: '',
                    upazilaName: '',
                  });
                  onClearFieldError(['division', 'district', 'upazila']);
                }}
                className={`w-full h-[40px] px-2.5 rounded-xl border text-[12px] text-slate-900 outline-none ${
                  customerErrors.division
                    ? 'border-rose-400 bg-rose-50/40'
                    : 'border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500'
                }`}
              >
                <option value="">Select division</option>
                {divisions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {customerErrors.division && (
                <p className="text-[11px] text-rose-600">
                  {customerErrors.division}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <label
                htmlFor={`${idPrefix}-cust-district`}
                className="text-[11.5px] font-semibold text-slate-700 block"
              >
                District <span className="text-rose-500">*</span>
              </label>
              <select
                id={`${idPrefix}-cust-district`}
                disabled={!customer.divisionId}
                value={customer.districtId}
                onChange={(e) => {
                  const dist = districts.find((d) => d.id === e.target.value);
                  onChangeCustomer({
                    ...customer,
                    districtId: dist ? dist.id : '',
                    districtName: dist ? dist.name : '',
                    upazilaId: '',
                    upazilaName: '',
                  });
                  onClearFieldError(['district', 'upazila']);
                }}
                className={`w-full h-[40px] px-2.5 rounded-xl border text-[12px] text-slate-900 outline-none disabled:opacity-50 ${
                  customerErrors.district
                    ? 'border-rose-400 bg-rose-50/40'
                    : 'border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500'
                }`}
              >
                <option value="">Select district</option>
                {districts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {customerErrors.district && (
                <p className="text-[11px] text-rose-600">
                  {customerErrors.district}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <label
                htmlFor={`${idPrefix}-cust-upazila`}
                className="text-[11.5px] font-semibold text-slate-700 block"
              >
                Upazila / Thana <span className="text-rose-500">*</span>
              </label>
              <select
                id={`${idPrefix}-cust-upazila`}
                disabled={!customer.districtId}
                value={customer.upazilaId}
                onChange={(e) => {
                  const upa = upazilas.find((u) => u.id === e.target.value);
                  onChangeCustomer({
                    ...customer,
                    upazilaId: upa ? upa.id : '',
                    upazilaName: upa ? upa.name : '',
                  });
                  onClearFieldError(['upazila']);
                }}
                className={`w-full h-[40px] px-2.5 rounded-xl border text-[12px] text-slate-900 outline-none disabled:opacity-50 ${
                  customerErrors.upazila
                    ? 'border-rose-400 bg-rose-50/40'
                    : 'border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500'
                }`}
              >
                <option value="">Select area</option>
                {upazilas.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
              {customerErrors.upazila && (
                <p className="text-[11px] text-rose-600">
                  {customerErrors.upazila}
                </p>
              )}
            </div>
          </div>

          {/* Full Delivery Address */}
          <div className="space-y-1">
            <label
              htmlFor={`${idPrefix}-cust-address`}
              className="text-[11.5px] font-semibold text-slate-700 block"
            >
              Full Delivery Address <span className="text-rose-500">*</span>
            </label>
            <textarea
              id={`${idPrefix}-cust-address`}
              rows={2}
              placeholder="House, Road, Block, Landmark"
              value={customer.address}
              onChange={(e) => {
                onChangeCustomer({
                  ...customer,
                  address: e.target.value,
                });
                if (customerErrors.address) onClearFieldError(['address']);
              }}
              className={`w-full p-2.5 rounded-xl border text-[12.5px] text-slate-900 outline-none transition-colors ${
                customerErrors.address
                  ? 'border-rose-400 bg-rose-50/40'
                  : 'border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500'
              }`}
            />
            {customerErrors.address && (
              <p className="text-[11px] text-rose-600">
                {customerErrors.address}
              </p>
            )}
          </div>

          {/* Courier Note & Advance Received */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="space-y-1">
              <label
                htmlFor={`${idPrefix}-courier-note`}
                className="text-[11.5px] font-semibold text-slate-700 block"
              >
                Note for Courier (Optional)
              </label>
              <input
                id={`${idPrefix}-courier-note`}
                type="text"
                placeholder="Call before delivery, fragile, etc."
                value={customer.courierNote}
                onChange={(e) =>
                  onChangeCustomer({
                    ...customer,
                    courierNote: e.target.value,
                  })
                }
                className="w-full h-[40px] px-3 rounded-xl border border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500 text-[12.5px] text-slate-900 outline-none"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor={`${idPrefix}-advance-received`}
                className="text-[11.5px] font-semibold text-slate-700 block"
              >
                Advance Already Received (Optional)
              </label>
              <div className="relative h-[40px]">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[12.5px] font-semibold text-slate-400 pointer-events-none">
                  ৳
                </span>
                <input
                  id={`${idPrefix}-advance-received`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={customerPaysTotal}
                  placeholder="0"
                  value={advanceDraft}
                  onChange={(e) => onChangeAdvanceDraft(e.target.value)}
                  className="w-full h-full pl-7 pr-3 rounded-xl border border-slate-200 bg-slate-50/60 focus:bg-white focus:border-blue-500 text-[12.5px] font-bold text-slate-900 tabular-nums outline-none"
                />
              </div>
            </div>
          </div>

          {/* Delivery Zone & Customer Pays on Delivery (COD) Strip */}
          <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-2.5 space-y-1 text-[12px] tabular-nums">
            <div className="flex items-center justify-between text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <Truck className="w-3.5 h-3.5 text-slate-400" />
                <span>
                  Delivery zone:{' '}
                  <strong className="text-slate-800">
                    {customer.districtName
                      ? isInsideDhaka
                        ? 'Inside Dhaka'
                        : `Outside Dhaka (${customer.districtName})`
                      : 'Outside Dhaka'}
                  </strong>
                </span>
              </span>
              <span className="font-bold text-slate-900">
                ৳{deliveryCharge.toLocaleString('en-BD')}
              </span>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-slate-200/70">
              <span className="font-semibold text-slate-700">
                Customer pays on delivery (COD)
              </span>
              <span className="font-extrabold text-slate-900 text-[13px]">
                ৳{codPayableOnDelivery.toLocaleString('en-BD')}
                {clampedAdvance > 0 && (
                  <span className="text-[11px] font-normal text-slate-500">
                    {' '}
                    (after ৳{clampedAdvance.toLocaleString('en-BD')} adv.)
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* Save This Customer Checkbox */}
          {typeof saveThisCustomer === 'boolean' && onToggleSaveThisCustomer && (
            <label className="flex items-center gap-2.5 min-h-[38px] px-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={saveThisCustomer}
                onChange={(e) => onToggleSaveThisCustomer(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-blue-500 cursor-pointer"
              />
              <span className="text-[12px] font-medium text-slate-700 inline-flex items-center gap-1.5">
                <BookmarkCheck className="w-3.5 h-3.5 text-slate-500" />
                <span>Save this customer for future orders</span>
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
};

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  UserProfile,
  ChatMessage,
  ChatConversation,
  ChatReplyRef,
} from '../../types';
import {
  subscribeToChatMessages,
  subscribeToChatConversation,
  fetchOlderChatMessages,
  sendTextMessage,
  sendMediaMessage,
  markChatAsRead,
  setChatTypingStatus,
  getOrCreateChatConversation,
  deleteChatMessage,
  submitChatRating,
} from '../../lib/chatService';
import { validateImageFile, compressImageToBlob } from '../../hooks/useImageUpload';
import { formatResellerId } from '../../lib/resellerIdHelper';
import { useNetwork } from '../../context/NetworkContext';
import { triggerHaptic } from '../../lib/nativeFeedback';
import { VoiceRecorder } from './VoiceRecorder';
import { VoicePlayer } from './VoicePlayer';
import { OrderAttachmentPickerModal } from './OrderAttachmentPickerModal';
import { ProductAttachmentPickerModal } from './ProductAttachmentPickerModal';
import {
  Send,
  Image as ImageIcon,
  Camera,
  Mic,
  Paperclip,
  ShoppingBag,
  Package,
  X,
  Check,
  CheckCheck,
  Phone,
  MessageSquare,
  Sparkles,
  Loader2,
  ArrowLeft,
  ArrowDown,
  Shield,
  MoreVertical,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  ExternalLink,
  Reply,
  Copy,
  Trash2,
  WifiOff,
  AlertCircle,
  Clock,
  Star,
} from 'lucide-react';

interface LiveChatWindowProps {
  chatId: string;
  currentUser: UserProfile;
  partnerInfo?: {
    name: string;
    shopName?: string;
    photoUrl?: string;
    mobile?: string;
    role?: string;
  };
  onBack?: () => void;
  onOpenOrder?: (orderId: string) => void;
  onOpenProduct?: (productId: string) => void;
  fullScreen?: boolean;
  className?: string;
}

interface PendingLocalMessage {
  localId: string;
  type: 'text' | 'image' | 'voice' | 'order_link' | 'product_link';
  text?: string;
  mediaPreviewUrl?: string;
  file?: File | Blob;
  duration?: number;
  order?: { id: string; orderNumber: string; status: string; totalAmount: number };
  product?: { id: string; name: string; imageUrl?: string; resellerPrice: number };
  replyTo?: ChatReplyRef;
  createdAtMs: number;
  status: 'sending' | 'failed';
  errorMsg?: string;
}

const SUPPORT_WORKING_HOURS = {
  startHour: 9, // 9:00 AM Bangladesh Time (UTC+6)
  endHour: 22, // 10:00 PM Bangladesh Time (UTC+6)
};

const QUICK_REPLIES = [
  'Order status',
  'Payout / withdrawal',
  'Account approval',
  'Product stock',
  'Return / complaint',
];

const CANNED_RESPONSES = [
  '👋 আসসালামু আলাইকুম! আপনাকে কীভাবে সহযোগিতা করতে পারি?',
  '📦 আপনার অর্ডারটির স্ট্যাটাস আমরা চেক করছি, অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।',
  '✅ আপনার পেমেন্ট/উইথড্রয়াল রিকোয়েস্ট ভেরিফাই করা হয়েছে।',
  '🚚 আপনার পার্সেলটি কুরিয়ারে হস্তান্তর করা হয়েছে। ট্র্যাকিং কোড পেয়ে যাবেন।',
  '🙏 ধন্যবাদ আমাদের সাথে থাকার জন্য! যেকোনো প্রয়োজনে মেসেজ দিন।',
  '📞 বিস্তারিত জানতে আমাদের হটলাইনে কল করতে পারেন: 01722063777',
];

const SUPPORT_HOTLINE = '01722063777';
const SUPPORT_WHATSAPP = '8801722063777';

function isWithinSupportHours(): boolean {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const dhakaDate = new Date(utcMs + 6 * 3600000);
  const hour = dhakaDate.getHours();
  return hour >= SUPPORT_WORKING_HOURS.startHour && hour < SUPPORT_WORKING_HOURS.endHour;
}

function getTimestampMs(ts: any): number {
  if (!ts) return Date.now();
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts?.seconds === 'number') return ts.seconds * 1000;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = new Date(ts).getTime();
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

function formatDayLabel(ms: number): string {
  const target = new Date(ms);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const diffDays = Math.round((todayStart - targetStart) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (target.getFullYear() === now.getFullYear()) {
    return target.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  }
  return target.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

function getDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function renderTextWithLinks(text: string, isSelf: boolean): React.ReactNode {
  const urlRegex = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
  const parts = text.split(urlRegex);
  return parts.map((part, idx) => {
    if (/^(https?:\/\/|www\.)/i.test(part)) {
      const cleanMatch = part.match(/^(.*?)([.,!?;:)\]]*)$/);
      const urlCore = cleanMatch?.[1] || part;
      const trailing = cleanMatch?.[2] || '';
      const href = urlCore.startsWith('http') ? urlCore : `https://${urlCore}`;
      return (
        <React.Fragment key={idx}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={`underline underline-offset-2 break-all ${
              isSelf
                ? 'text-white decoration-white/80 hover:decoration-white font-medium'
                : 'text-[#0E9AA7] hover:text-[#04203F]'
            }`}
          >
            {urlCore}
          </a>
          {trailing}
        </React.Fragment>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function buildReplySnippet(msg: ChatMessage): ChatReplyRef {
  let snippet = (msg.text || '').trim();
  if (msg.type === 'image' && (!snippet || snippet === '📷 Photo')) snippet = 'Photo';
  else if (msg.type === 'voice') snippet = 'Voice message';
  else if (msg.type === 'order_link') snippet = `Order #${msg.orderNumber || msg.orderId?.slice(0, 8) || ''}`;
  else if (msg.type === 'product_link') snippet = msg.productName || 'Product';
  if (snippet.length > 90) snippet = `${snippet.slice(0, 87)}...`;

  return {
    id: msg.id,
    senderName: msg.senderRole === 'reseller' ? msg.senderName || 'Reseller' : 'ReSellBD Support',
    senderRole: msg.senderRole,
    text: snippet,
    type: msg.type,
  };
}

export const LiveChatWindow: React.FC<LiveChatWindowProps> = ({
  chatId,
  currentUser,
  partnerInfo,
  onBack,
  onOpenOrder,
  onOpenProduct,
  fullScreen = false,
  className = '',
}) => {
  const { isOnline } = useNetwork();
  const isReseller = currentUser.role === 'reseller';

  // Core message & conversation state
  const [liveMessages, setLiveMessages] = useState<ChatMessage[]>([]);
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [retrySeed, setRetrySeed] = useState(0);

  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingLocalMessage[]>([]);

  // Composer state (draft preserved in sessionStorage so typed text is never lost)
  const draftStorageKey = `resellbd_chat_draft_${chatId}`;
  const [inputText, setInputText] = useState(() => {
    try {
      return sessionStorage.getItem(`resellbd_chat_draft_${chatId}`) || '';
    } catch {
      return '';
    }
  });
  const [isSending, setIsSending] = useState(false);
  const sendingLockRef = useRef(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);

  // Image draft preview state
  const [selectedImageFile, setSelectedImageFile] = useState<Blob | File | null>(null);
  const [selectedImageName, setSelectedImageName] = useState<string>('');
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageCaption, setImageCaption] = useState('');
  const [isCompressingPhoto, setIsCompressingPhoto] = useState(false);

  // Reply, copy, delete with undo, clear view
  const [replyingTo, setReplyingTo] = useState<ChatReplyRef | null>(null);
  const [activeActionMsg, setActiveActionMsg] = useState<ChatMessage | null>(null);
  const [confirmDeleteMsg, setConfirmDeleteMsg] = useState<ChatMessage | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const [undoDeleteState, setUndoDeleteState] = useState<{
    msg: ChatMessage;
    timerId: ReturnType<typeof setTimeout>;
  } | null>(null);
  const pendingDeleteTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [clearedBeforeMs, setClearedBeforeMs] = useState<number | null>(null);

  // UI Popovers & Pickers
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showCannedMenu, setShowCannedMenu] = useState(false);
  const [showOrderPicker, setShowOrderPicker] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);

  // Fullscreen image viewer + zoom
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);

  // Scroll & unread jump state
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);

  // Visual viewport keyboard adaptation when fullScreen
  const [viewportStyle, setViewportStyle] = useState<{ height: number | null; offsetTop: number }>({
    height: null,
    offsetTop: 0,
  });

  // Working hours status (re-evaluated every 60s)
  const [supportOnline, setSupportOnline] = useState(() => isWithinSupportHours());

  // Toast feedback
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // End-of-chat rating state (only used if conversation resolved flag is set)
  const [ratingStars, setRatingStars] = useState(0);
  const [ratingComment, setRatingComment] = useState('');
  const [ratingSubmitting, setRatingSubmitting] = useState(false);
  const [ratingDismissed, setRatingDismissed] = useState(false);

  // Refs for inputs & gestures
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeStateRef = useRef<{ msgId: string | null; startX: number; startY: number }>({
    msgId: null,
    startX: 0,
    startY: 0,
  });
  const [swipingMsg, setSwipingMsg] = useState<{ id: string; offsetX: number } | null>(null);

  const showToast = useCallback((text: string) => {
    setToastMsg(text);
    setTimeout(() => {
      setToastMsg((prev) => (prev === text ? null : prev));
    }, 2600);
  }, []);

  // Re-check working hours once per minute
  useEffect(() => {
    const id = setInterval(() => {
      setSupportOnline(isWithinSupportHours());
    }, 60000);
    return () => clearInterval(id);
  }, []);

  // Reload draft if chatId prop changes on an already-mounted instance
  useEffect(() => {
    try {
      setInputText(sessionStorage.getItem(draftStorageKey) || '');
    } catch {
      setInputText('');
    }
  }, [draftStorageKey]);

  // Persist typed draft per chatId
  useEffect(() => {
    try {
      if (inputText) {
        sessionStorage.setItem(draftStorageKey, inputText);
      } else {
        sessionStorage.removeItem(draftStorageKey);
      }
    } catch {
      // ignore storage errors
    }
  }, [draftStorageKey, inputText]);

  // Revoke previous object URL when photo preview changes or unmounts
  useEffect(() => {
    return () => {
      if (imagePreviewUrl && imagePreviewUrl.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(imagePreviewUrl);
        } catch {
          // ignore
        }
      }
    };
  }, [imagePreviewUrl]);

  // VisualViewport & document scroll lock when true full-screen (prevents double scrollbars)
  useEffect(() => {
    if (!fullScreen) return;

    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    const updateViewport = () => {
      const vv = window.visualViewport;
      if (vv) {
        setViewportStyle({
          height: Math.round(vv.height),
          offsetTop: Math.round(vv.offsetTop),
        });
      } else {
        setViewportStyle({
          height: window.innerHeight,
          offsetTop: 0,
        });
      }
      if (isNearBottomRef.current) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        });
      }
    };

    updateViewport();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', updateViewport);
    vv?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
      vv?.removeEventListener('resize', updateViewport);
      vv?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [fullScreen]);

  // Handle Escape and Android hardware back for inner overlays (lightbox, pickers, action sheets)
  const hasInnerOverlay = Boolean(
    lightboxImage ||
      confirmDeleteMsg ||
      activeActionMsg ||
      showOrderPicker ||
      showProductPicker ||
      showHeaderMenu ||
      showAttachMenu ||
      showCannedMenu
  );

  useEffect(() => {
    if (!fullScreen) return;

    window.dispatchEvent(
      new CustomEvent('sky_fullscreen_overlay', { detail: { open: hasInnerOverlay } })
    );

    const handleHardwareBack = () => {
      if (lightboxImage) {
        setLightboxImage(null);
      } else if (confirmDeleteMsg) {
        setConfirmDeleteMsg(null);
      } else if (activeActionMsg) {
        setActiveActionMsg(null);
      } else if (showOrderPicker) {
        setShowOrderPicker(false);
      } else if (showProductPicker) {
        setShowProductPicker(false);
      } else if (showAttachMenu) {
        setShowAttachMenu(false);
      } else if (showHeaderMenu) {
        setShowHeaderMenu(false);
      } else if (showCannedMenu) {
        setShowCannedMenu(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && hasInnerOverlay) {
        handleHardwareBack();
      }
    };

    window.addEventListener('sky_fullscreen_overlay_back', handleHardwareBack);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('sky_fullscreen_overlay_back', handleHardwareBack);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [
    fullScreen,
    hasInnerOverlay,
    lightboxImage,
    confirmDeleteMsg,
    activeActionMsg,
    showOrderPicker,
    showProductPicker,
    showAttachMenu,
    showHeaderMenu,
    showCannedMenu,
  ]);

  useEffect(() => {
    if (!fullScreen) return;
    return () => {
      window.dispatchEvent(new CustomEvent('sky_fullscreen_overlay', { detail: { open: false } }));
    };
  }, [fullScreen]);

  // Flush any pending message deletions on unmount so undo timers don't leak or drop deletes
  useEffect(() => {
    return () => {
      pendingDeleteTimersRef.current.forEach((timerId, msgId) => {
        clearTimeout(timerId);
        deleteChatMessage(chatId, msgId).catch(() => {});
      });
      pendingDeleteTimersRef.current.clear();
    };
  }, [chatId]);

  // Subscribe to realtime messages & conversation
  useEffect(() => {
    if (!chatId) return;

    setLoadingInitial(true);
    setSubscriptionError(null);
    setOlderMessages([]);
    setHasMoreOlder(false);
    prevMsgCountRef.current = 0;

    if (isReseller) {
      getOrCreateChatConversation(currentUser.uid, currentUser).catch((e) => {
        console.warn('Initial chat creation check:', e);
      });
    }

    markChatAsRead(chatId, currentUser.role, currentUser.uid);

    const unsubMessages = subscribeToChatMessages(
      chatId,
      (msgList, moreAvailable) => {
        setLiveMessages(msgList);
        setLoadingInitial(false);
        setSubscriptionError(null);
        setHasMoreOlder((prev) => prev || Boolean(moreAvailable));
        markChatAsRead(chatId, currentUser.role, currentUser.uid, msgList);
      },
      (err) => {
        setLoadingInitial(false);
        setSubscriptionError(err?.message || 'Could not load messages. Please try again.');
      },
      50
    );

    const unsubConv = subscribeToChatConversation(chatId, (conv) => {
      setConversation(conv);
    });

    return () => {
      unsubMessages();
      unsubConv();
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      setChatTypingStatus(chatId, currentUser.role, false);
    };
  }, [chatId, currentUser.role, currentUser.uid, isReseller, retrySeed]);

  // Merge older + live messages deduplicated & sorted
  const combinedServerMessages = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    olderMessages.forEach((m) => byId.set(m.id, m));
    liveMessages.forEach((m) => byId.set(m.id, m));

    return Array.from(byId.values())
      .filter((m) => {
        if (pendingDeleteIds.has(m.id)) return false;
        if (clearedBeforeMs && getTimestampMs(m.createdAt) <= clearedBeforeMs) return false;
        return true;
      })
      .sort((a, b) => getTimestampMs(a.createdAt) - getTimestampMs(b.createdAt));
  }, [olderMessages, liveMessages, pendingDeleteIds, clearedBeforeMs]);

  const otherIsTyping = isReseller ? conversation?.typingAdmin : conversation?.typingReseller;

  // Auto-resize textarea (up to 4 lines ~ 96px)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, 96);
    el.style.height = `${Math.max(nextHeight, 38)}px`;
  }, [inputText]);

  // Scroll to bottom on new messages if user was near bottom (or first load)
  useEffect(() => {
    const totalCount = combinedServerMessages.length + pendingMessages.length;
    const isInitialLoad = prevMsgCountRef.current === 0 && totalCount > 0;
    const hasNewMessages = totalCount > prevMsgCountRef.current;

    if (isInitialLoad || isNearBottomRef.current) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({
          behavior: isInitialLoad ? 'auto' : 'smooth',
        });
      });
      setNewBelowCount(0);
    } else if (hasNewMessages) {
      setNewBelowCount((c) => c + (totalCount - prevMsgCountRef.current));
    }

    prevMsgCountRef.current = totalCount;
  }, [combinedServerMessages, pendingMessages, otherIsTyping]);

  // Load older messages on scroll top
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || !hasMoreOlder || combinedServerMessages.length === 0) return;
    const oldest = combinedServerMessages[0];
    if (!oldest?.createdAt) return;

    const listEl = listContainerRef.current;
    const prevScrollHeight = listEl?.scrollHeight || 0;

    setLoadingOlder(true);
    try {
      const { messages: olderBatch, hasMore } = await fetchOlderChatMessages(
        chatId,
        oldest.createdAt,
        35
      );
      if (olderBatch.length > 0) {
        setOlderMessages((prev) => {
          const map = new Map<string, ChatMessage>();
          olderBatch.forEach((m) => map.set(m.id, m));
          prev.forEach((m) => map.set(m.id, m));
          return Array.from(map.values());
        });
        requestAnimationFrame(() => {
          if (listEl) {
            const newScrollHeight = listEl.scrollHeight;
            listEl.scrollTop = Math.max(0, newScrollHeight - prevScrollHeight);
          }
        });
      }
      setHasMoreOlder(hasMore && olderBatch.length > 0);
    } catch (err) {
      console.warn('Could not load older messages:', err);
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, combinedServerMessages, hasMoreOlder, loadingOlder]);

  const handleListScroll = () => {
    const el = listContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 120;
    isNearBottomRef.current = nearBottom;
    setShowJumpButton(!nearBottom && combinedServerMessages.length > 0);
    if (nearBottom) {
      setNewBelowCount(0);
    }

    if (el.scrollTop < 48 && hasMoreOlder && !loadingOlder) {
      handleLoadOlder();
    }
  };

  const scrollToBottom = () => {
    isNearBottomRef.current = true;
    setNewBelowCount(0);
    setShowJumpButton(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Handle typing indicator debounce
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setInputText(text);

    if (chatId && isOnline) {
      setChatTypingStatus(chatId, currentUser.role, text.trim().length > 0, currentUser.fullName);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        setChatTypingStatus(chatId, currentUser.role, false);
      }, 2000);
    }
  };

  // Send Text Message (with double-fire guard + offline pending queue)
  const handleSendText = async () => {
    const trimmed = inputText.trim();
    if (!trimmed || sendingLockRef.current || isSending) return;

    const currentReply = replyingTo || undefined;
    const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    setInputText('');
    setReplyingTo(null);
    isNearBottomRef.current = true;

    const pendingItem: PendingLocalMessage = {
      localId,
      type: 'text',
      text: trimmed,
      replyTo: currentReply,
      createdAtMs: Date.now(),
      status: isOnline ? 'sending' : 'failed',
      errorMsg: isOnline ? undefined : 'Offline — tap Retry when connected',
    };
    setPendingMessages((prev) => [...prev, pendingItem]);

    if (!isOnline) {
      triggerHaptic('light');
      return;
    }

    sendingLockRef.current = true;
    setIsSending(true);
    try {
      await sendTextMessage(chatId, currentUser, trimmed, {
        replyTo: currentReply,
      });
      setPendingMessages((prev) => prev.filter((p) => p.localId !== localId));
      setChatTypingStatus(chatId, currentUser.role, false);
      triggerHaptic('light');
    } catch (err: any) {
      console.error('Failed to send text message:', err);
      setPendingMessages((prev) =>
        prev.map((p) =>
          p.localId === localId
            ? { ...p, status: 'failed', errorMsg: 'Not sent — tap Retry' }
            : p
        )
      );
    } finally {
      sendingLockRef.current = false;
      setIsSending(false);
    }
  };

  // Handle Image Selection (gallery or camera) using shared validation & 1280px EXIF-aware compression
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setShowAttachMenu(false);
    try {
      validateImageFile(file);
    } catch (err: any) {
      showToast(err?.message || 'Please choose a valid image file (JPG, PNG, WEBP)');
      return;
    }

    setIsCompressingPhoto(true);
    try {
      const { blob, ext } = await compressImageToBlob(file, {
        maxLongestSide: 1280,
        initialQuality: 0.78,
        targetMaxBytes: 420 * 1024,
      });
      const baseName = file.name ? file.name.replace(/\.[^.]+$/, '') : 'chat_photo';
      const compressedFile = new File([blob], `${baseName}.${ext}`, {
        type: blob.type || 'image/jpeg',
      });
      setSelectedImageFile(compressedFile);
      setSelectedImageName(compressedFile.name);
      setImagePreviewUrl(URL.createObjectURL(compressedFile));
    } catch (err: any) {
      console.warn('Shared compression fallback:', err);
      showToast(err?.message || 'Could not process photo');
    } finally {
      setIsCompressingPhoto(false);
    }
  };

  // Send Image Message (already compressed up to 1280px, offline retry safe)
  const handleSendImage = async () => {
    if (!selectedImageFile || sendingLockRef.current || isSending || isCompressingPhoto) return;

    const fileToSend = selectedImageFile;
    const fileNameToSend = selectedImageName || (fileToSend instanceof File ? fileToSend.name : 'photo.jpg');
    const captionToSend = imageCaption.trim();
    const currentReply = replyingTo || undefined;
    const localId = `local_img_${Date.now()}`;

    let localPreview: string | undefined;
    try {
      localPreview = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () =>
          typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Preview failed'));
        reader.onerror = () => reject(new Error('Preview error'));
        reader.readAsDataURL(fileToSend);
      });
    } catch {
      localPreview = imagePreviewUrl || undefined;
    }

    setSelectedImageFile(null);
    setSelectedImageName('');
    setImagePreviewUrl(null);
    setImageCaption('');
    setReplyingTo(null);
    isNearBottomRef.current = true;

    const pendingItem: PendingLocalMessage = {
      localId,
      type: 'image',
      text: captionToSend || undefined,
      mediaPreviewUrl: localPreview,
      file: fileToSend,
      replyTo: currentReply,
      createdAtMs: Date.now(),
      status: isOnline ? 'sending' : 'failed',
      errorMsg: isOnline ? undefined : 'Offline — tap Retry when connected',
    };
    setPendingMessages((prev) => [...prev, pendingItem]);

    if (!isOnline) {
      triggerHaptic('light');
      return;
    }

    sendingLockRef.current = true;
    setIsSending(true);
    try {
      await sendMediaMessage(chatId, currentUser, fileToSend, 'image', {
        caption: captionToSend || undefined,
        fileName: fileNameToSend,
        replyTo: currentReply,
      });
      setPendingMessages((prev) => prev.filter((p) => p.localId !== localId));
      triggerHaptic('light');
    } catch (err) {
      console.error('Failed to send image:', err);
      setPendingMessages((prev) =>
        prev.map((p) =>
          p.localId === localId
            ? { ...p, status: 'failed', errorMsg: 'Photo failed — tap Retry' }
            : p
        )
      );
    } finally {
      sendingLockRef.current = false;
      setIsSending(false);
    }
  };

  // Send Voice Recording
  const handleSendVoice = async (audioBlob: Blob, duration: number) => {
    setIsRecordingVoice(false);
    if (sendingLockRef.current || isSending) return;

    const localId = `local_voice_${Date.now()}`;
    const currentReply = replyingTo || undefined;
    setReplyingTo(null);
    isNearBottomRef.current = true;

    const pendingItem: PendingLocalMessage = {
      localId,
      type: 'voice',
      text: '🎤 Voice Message',
      file: audioBlob,
      duration,
      replyTo: currentReply,
      createdAtMs: Date.now(),
      status: isOnline ? 'sending' : 'failed',
      errorMsg: isOnline ? undefined : 'Offline — tap Retry when connected',
    };
    setPendingMessages((prev) => [...prev, pendingItem]);

    if (!isOnline) return;

    sendingLockRef.current = true;
    setIsSending(true);
    try {
      await sendMediaMessage(chatId, currentUser, audioBlob, 'voice', {
        duration,
        replyTo: currentReply,
      });
      setPendingMessages((prev) => prev.filter((p) => p.localId !== localId));
    } catch (err) {
      console.error('Failed to send voice note:', err);
      setPendingMessages((prev) =>
        prev.map((p) =>
          p.localId === localId
            ? { ...p, status: 'failed', errorMsg: 'Voice failed — tap Retry' }
            : p
        )
      );
    } finally {
      sendingLockRef.current = false;
      setIsSending(false);
    }
  };

  // Send Order Card Attachment
  const handleSelectOrder = async (order: {
    id: string;
    orderNumber: string;
    status: string;
    totalAmount: number;
  }) => {
    if (sendingLockRef.current || isSending) return;
    const localId = `local_ord_${Date.now()}`;
    const currentReply = replyingTo || undefined;
    setReplyingTo(null);
    isNearBottomRef.current = true;

    const label = `📦 Attached Order #${order.orderNumber}`;
    setPendingMessages((prev) => [
      ...prev,
      {
        localId,
        type: 'order_link',
        text: label,
        order,
        replyTo: currentReply,
        createdAtMs: Date.now(),
        status: isOnline ? 'sending' : 'failed',
        errorMsg: isOnline ? undefined : 'Offline — tap Retry when connected',
      },
    ]);

    if (!isOnline) return;

    sendingLockRef.current = true;
    setIsSending(true);
    try {
      await sendTextMessage(chatId, currentUser, label, {
        order,
        replyTo: currentReply,
      });
      setPendingMessages((prev) => prev.filter((p) => p.localId !== localId));
    } catch (err) {
      console.error('Failed to attach order:', err);
      setPendingMessages((prev) =>
        prev.map((p) =>
          p.localId === localId ? { ...p, status: 'failed', errorMsg: 'Order failed — tap Retry' } : p
        )
      );
    } finally {
      sendingLockRef.current = false;
      setIsSending(false);
    }
  };

  // Send Product Card Attachment
  const handleSelectProduct = async (product: {
    id: string;
    name: string;
    imageUrl?: string;
    resellerPrice: number;
  }) => {
    if (sendingLockRef.current || isSending) return;
    const localId = `local_prod_${Date.now()}`;
    const currentReply = replyingTo || undefined;
    setReplyingTo(null);
    isNearBottomRef.current = true;

    const label = `🛍️ Attached Product: ${product.name}`;
    setPendingMessages((prev) => [
      ...prev,
      {
        localId,
        type: 'product_link',
        text: label,
        product,
        replyTo: currentReply,
        createdAtMs: Date.now(),
        status: isOnline ? 'sending' : 'failed',
        errorMsg: isOnline ? undefined : 'Offline — tap Retry when connected',
      },
    ]);

    if (!isOnline) return;

    sendingLockRef.current = true;
    setIsSending(true);
    try {
      await sendTextMessage(chatId, currentUser, label, {
        product,
        replyTo: currentReply,
      });
      setPendingMessages((prev) => prev.filter((p) => p.localId !== localId));
    } catch (err) {
      console.error('Failed to attach product:', err);
      setPendingMessages((prev) =>
        prev.map((p) =>
          p.localId === localId ? { ...p, status: 'failed', errorMsg: 'Product failed — tap Retry' } : p
        )
      );
    } finally {
      sendingLockRef.current = false;
      setIsSending(false);
    }
  };

  // Retry failed local pending message
  const handleRetryPending = async (item: PendingLocalMessage) => {
    if (!isOnline) {
      showToast('Still offline — connect to internet and retry');
      return;
    }

    setPendingMessages((prev) =>
      prev.map((p) => (p.localId === item.localId ? { ...p, status: 'sending', errorMsg: undefined } : p))
    );

    try {
      if (item.type === 'text' && item.text) {
        await sendTextMessage(chatId, currentUser, item.text, { replyTo: item.replyTo });
      } else if (item.type === 'order_link' && item.order) {
        await sendTextMessage(chatId, currentUser, item.text || `📦 Attached Order #${item.order.orderNumber}`, {
          order: item.order,
          replyTo: item.replyTo,
        });
      } else if (item.type === 'product_link' && item.product) {
        await sendTextMessage(chatId, currentUser, item.text || `🛍️ Attached Product: ${item.product.name}`, {
          product: item.product,
          replyTo: item.replyTo,
        });
      } else if (item.type === 'image' && item.file) {
        await sendMediaMessage(chatId, currentUser, item.file, 'image', {
          caption: item.text,
          replyTo: item.replyTo,
        });
      } else if (item.type === 'voice' && item.file) {
        await sendMediaMessage(chatId, currentUser, item.file, 'voice', {
          duration: item.duration,
          replyTo: item.replyTo,
        });
      }
      setPendingMessages((prev) => prev.filter((p) => p.localId !== item.localId));
    } catch {
      setPendingMessages((prev) =>
        prev.map((p) =>
          p.localId === item.localId ? { ...p, status: 'failed', errorMsg: 'Retry failed — tap Retry' } : p
        )
      );
    }
  };

  // Delete own message with confirm + 5s Undo snackbar
  const handleConfirmDelete = () => {
    const target = confirmDeleteMsg;
    if (!target) return;
    setConfirmDeleteMsg(null);
    setActiveActionMsg(null);

    setPendingDeleteIds((prev) => {
      const next = new Set(prev);
      next.add(target.id);
      return next;
    });

    if (undoDeleteState) {
      clearTimeout(undoDeleteState.timerId);
    }

    const timerId = setTimeout(async () => {
      pendingDeleteTimersRef.current.delete(target.id);
      setUndoDeleteState((curr) => (curr?.msg.id === target.id ? null : curr));
      try {
        await deleteChatMessage(chatId, target.id);
      } catch (err) {
        console.warn('Could not delete message:', err);
        setPendingDeleteIds((prev) => {
          const next = new Set(prev);
          next.delete(target.id);
          return next;
        });
        showToast('Could not delete message');
      }
    }, 5000);

    pendingDeleteTimersRef.current.set(target.id, timerId);
    setUndoDeleteState({ msg: target, timerId });
  };

  const handleUndoDelete = () => {
    if (!undoDeleteState) return;
    const { msg, timerId } = undoDeleteState;
    clearTimeout(timerId);
    pendingDeleteTimersRef.current.delete(msg.id);
    setPendingDeleteIds((prev) => {
      const next = new Set(prev);
      next.delete(msg.id);
      return next;
    });
    setUndoDeleteState(null);
    triggerHaptic('light');
  };

  const handleCopyMessageText = (msg: ChatMessage) => {
    const content = (msg.text || '').trim();
    if (!content) return;
    try {
      navigator.clipboard.writeText(content);
      triggerHaptic('light');
      showToast('Copied to clipboard');
    } catch {
      showToast('Could not copy text');
    }
    setActiveActionMsg(null);
  };

  const handleSubmitRating = async () => {
    if (!ratingStars || ratingSubmitting) return;
    setRatingSubmitting(true);
    try {
      await submitChatRating(chatId, ratingStars, ratingComment);
      showToast('Thanks for your feedback!');
    } catch {
      showToast('Could not submit rating');
    } finally {
      setRatingSubmitting(false);
    }
  };

  const handleQuickReplyTap = (chipText: string) => {
    triggerHaptic('light');
    setInputText(chipText);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  // Quick swipe-right to reply + long-press action handlers
  const handleBubbleTouchStart = (msg: ChatMessage, e: React.TouchEvent) => {
    const touch = e.touches[0];
    swipeStateRef.current = { msgId: msg.id, startX: touch.clientX, startY: touch.clientY };

    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      triggerHaptic('medium');
      setActiveActionMsg(msg);
      swipeStateRef.current.msgId = null;
      setSwipingMsg(null);
    }, 450);
  };

  const handleBubbleTouchMove = (msg: ChatMessage, e: React.TouchEvent) => {
    const state = swipeStateRef.current;
    if (state.msgId !== msg.id) return;
    const touch = e.touches[0];
    const dx = touch.clientX - state.startX;
    const dy = Math.abs(touch.clientY - state.startY);

    if (dy > 14 || Math.abs(dx) > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }

    if (dx > 8 && dy < 24) {
      setSwipingMsg({ id: msg.id, offsetX: Math.min(dx, 44) });
    }
  };

  const handleBubbleTouchEnd = (msg: ChatMessage) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (swipingMsg?.id === msg.id && swipingMsg.offsetX >= 34) {
      triggerHaptic('light');
      setReplyingTo(buildReplySnippet(msg));
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    swipeStateRef.current.msgId = null;
    setSwipingMsg(null);
  };

  // Format time label
  const formatMsgTime = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Partner / Header Display values
  const partnerDisplayName = isReseller
    ? 'ReSellBD Support'
    : partnerInfo?.name || conversation?.resellerName || 'Reseller';
  const partnerMobile = partnerInfo?.mobile || conversation?.resellerMobile || SUPPORT_HOTLINE;
  const partnerWaDigits = (() => {
    const digits = partnerMobile.replace(/\D/g, '');
    if (!digits) return SUPPORT_WHATSAPP;
    if (digits.startsWith('88')) return digits;
    if (digits.startsWith('0')) return `88${digits}`;
    return digits;
  })();
  const partnerPhoto = isReseller ? undefined : partnerInfo?.photoUrl || conversation?.resellerPhotoUrl;
  const adminResellerIdLabel = !isReseller && conversation?.resellerId
    ? formatResellerId(conversation.resellerId)
    : '';

  const showQuickReplyChips =
    isReseller &&
    !inputText.trim() &&
    !imagePreviewUrl &&
    !loadingInitial &&
    (combinedServerMessages.length === 0 ||
      !combinedServerMessages.some((m) => m.senderId === currentUser.uid));

  const showOptionalRating =
    isReseller &&
    Boolean((conversation as any)?.resolved === true || (conversation as any)?.status === 'resolved') &&
    !conversation?.rating &&
    !ratingDismissed;

  // Build unified render timeline with pending local messages appended
  const timelineItems = useMemo(() => {
    const serverEntries = combinedServerMessages.map((msg) => ({
      kind: 'server' as const,
      id: msg.id,
      senderId: msg.senderId,
      timeMs: getTimestampMs(msg.createdAt),
      msg,
    }));

    const localEntries = pendingMessages.map((p) => ({
      kind: 'local' as const,
      id: p.localId,
      senderId: currentUser.uid,
      timeMs: p.createdAtMs,
      pending: p,
    }));

    return [...serverEntries, ...localEntries].sort((a, b) => a.timeMs - b.timeMs);
  }, [combinedServerMessages, pendingMessages, currentUser.uid]);

  // Outer shell class depending on fullScreen vs embedded (AdminLiveChatHub)
  const containerClass = fullScreen
    ? `fixed inset-x-0 z-50 mx-auto w-full max-w-2xl flex flex-col bg-slate-50 overflow-hidden md:border-x md:border-slate-200/80 shadow-2xl ${className}`
    : `flex flex-col h-full bg-slate-50 rounded-2xl overflow-hidden border border-slate-200/90 shadow-xs relative ${className}`;

  const containerStyle = fullScreen
    ? {
        height: viewportStyle.height ? `${viewportStyle.height}px` : '100dvh',
        top: `${viewportStyle.offsetTop}px`,
      }
    : undefined;

  return (
    <div className={containerClass} style={containerStyle}>
      {/* 1. SLIM GLASS HEADER */}
      <header
        className={`bg-white/88 backdrop-blur-xl saturate-150 border-b border-slate-200/85 px-3 sm:px-4 shrink-0 z-20 flex items-center justify-between gap-2 shadow-[0_2px_12px_rgba(4,32,63,0.04)] ${
          fullScreen ? 'pt-[max(env(safe-area-inset-top,0px),0.55rem)] pb-2.5' : 'py-2.5'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {onBack && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onBack();
              }}
              className="w-10 h-10 -ml-1.5 rounded-xl flex items-center justify-center text-[#04203F] hover:bg-slate-100 active:scale-95 transition-colors motion-reduce:transition-none cursor-pointer shrink-0"
              aria-label="Back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}

          <div className="relative shrink-0">
            {partnerPhoto ? (
              <img
                src={partnerPhoto}
                alt={partnerDisplayName}
                className="w-9 h-9 rounded-full object-cover border border-slate-200"
              />
            ) : (
              <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-[#04203F] to-[#0E9AA7] flex items-center justify-center text-white font-bold text-sm shadow-xs">
                {isReseller ? <Shield className="w-4 h-4" /> : partnerDisplayName.charAt(0).toUpperCase()}
              </div>
            )}
            <span
              className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-white ${
                supportOnline || !isReseller ? 'bg-[#3DD055]' : 'bg-amber-400'
              }`}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <h2 className="text-[16px] font-bold text-[#04203F] tracking-tight leading-tight truncate">
                {partnerDisplayName}
              </h2>
              {adminResellerIdLabel && (
                <span className="font-mono text-[10px] font-semibold text-[#0E9AA7] bg-[#0E9AA7]/10 px-1.5 py-0.5 rounded-md shrink-0">
                  {adminResellerIdLabel}
                </span>
              )}
            </div>
            <p className="text-[11px] font-medium text-slate-500 truncate leading-tight mt-0.5">
              {otherIsTyping ? (
                <span className="text-[#0E9AA7] font-semibold">Typing...</span>
              ) : isReseller ? (
                supportOnline ? (
                  'Online - replies within minutes'
                ) : (
                  'Offline - we will reply soon'
                )
              ) : (
                partnerInfo?.shopName || conversation?.resellerShopName || 'Reseller'
              )}
            </p>
          </div>
        </div>

        {/* Right Header Actions: Canned (Admin) + Compact Menu */}
        <div className="flex items-center gap-1 shrink-0 relative">
          {!isReseller && (
            <button
              type="button"
              onClick={() => {
                setShowCannedMenu((v) => !v);
                setShowHeaderMenu(false);
              }}
              className="h-9 px-2.5 bg-[#0E9AA7]/10 hover:bg-[#0E9AA7]/15 text-[#04203F] rounded-xl text-[12px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
              title="Quick Canned Replies"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#0E9AA7]" />
              <span className="hidden sm:inline">Replies</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setShowHeaderMenu((v) => !v);
              setShowCannedMenu(false);
            }}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-600 hover:text-[#04203F] hover:bg-slate-100 transition-colors cursor-pointer"
            aria-label="Chat menu"
          >
            <MoreVertical className="w-5 h-5" />
          </button>

          {showHeaderMenu && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setShowHeaderMenu(false)}
              />
              <div className="absolute right-0 top-11 z-30 w-48 bg-white/95 backdrop-blur-xl rounded-xl border border-slate-200 shadow-xl p-1.5 space-y-0.5">
                <a
                  href={`tel:${partnerMobile}`}
                  onClick={() => setShowHeaderMenu(false)}
                  className="w-full px-3 py-2.5 rounded-lg text-[13px] font-medium text-slate-800 hover:bg-slate-100 flex items-center gap-2.5 transition-colors"
                >
                  <Phone className="w-4 h-4 text-[#0E9AA7]" />
                  <span>Call support</span>
                </a>
                <a
                  href={`https://wa.me/${partnerWaDigits}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setShowHeaderMenu(false)}
                  className="w-full px-3 py-2.5 rounded-lg text-[13px] font-medium text-slate-800 hover:bg-slate-100 flex items-center gap-2.5 transition-colors"
                >
                  <MessageSquare className="w-4 h-4 text-[#3DD055]" />
                  <span>WhatsApp support</span>
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setClearedBeforeMs(Date.now());
                    setShowHeaderMenu(false);
                    showToast('Chat view cleared locally');
                  }}
                  className="w-full px-3 py-2.5 rounded-lg text-[13px] font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-2.5 transition-colors text-left cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4 text-slate-500" />
                  <span>Clear view</span>
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Admin Canned Replies Popover */}
      {showCannedMenu && (
        <div className="absolute top-16 right-3 z-30 bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-slate-200 p-2 max-w-sm w-[calc(100%-1.5rem)]">
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-slate-100">
            <span className="font-bold text-[12px] text-[#04203F] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#0E9AA7]" />
              Quick Replies
            </span>
            <button
              type="button"
              onClick={() => setShowCannedMenu(false)}
              className="text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="max-h-60 overflow-y-auto p-1 space-y-1">
            {CANNED_RESPONSES.map((res, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setInputText(res);
                  setShowCannedMenu(false);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                className="w-full text-left p-2 hover:bg-slate-100 text-[12.5px] text-slate-700 rounded-xl transition-colors leading-relaxed cursor-pointer"
              >
                {res}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Offline Status Banner */}
      {!isOnline && (
        <div className="bg-amber-50 border-b border-amber-200/80 px-3 py-1.5 flex items-center justify-center gap-2 text-[11px] font-medium text-amber-900 shrink-0 z-10">
          <WifiOff className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <span>You are offline. Unsent messages stay saved here so you can retry.</span>
        </div>
      )}

      {/* 2. INDEPENDENTLY SCROLLING MESSAGE LIST + OVERLAP-FREE JUMP BUTTON */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={listContainerRef}
          onScroll={handleListScroll}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 sm:px-4 py-3 space-y-1 bg-gradient-to-b from-slate-50 via-slate-50 to-slate-100/80"
        >
        {/* Honest Privacy / Storage Notice */}
        <div className="flex justify-center pb-2">
          <div className="bg-white/80 backdrop-blur-md border border-slate-200/80 text-slate-600 text-[11px] font-medium px-3 py-1.5 rounded-xl flex items-center gap-1.5 max-w-md text-center shadow-2xs">
            <Shield className="w-3.5 h-3.5 text-[#0E9AA7] shrink-0" />
            <span>Chats are saved so support can help you faster</span>
          </div>
        </div>

        {/* Restore button if user locally cleared view */}
        {clearedBeforeMs && (
          <div className="flex justify-center pb-2">
            <button
              type="button"
              onClick={() => setClearedBeforeMs(null)}
              className="text-[11px] font-semibold text-[#0E9AA7] bg-white border border-slate-200 px-3 py-1 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              Previous messages hidden locally · Tap to restore
            </button>
          </div>
        )}

        {/* Load older messages control */}
        {hasMoreOlder && !clearedBeforeMs && (
          <div className="flex justify-center py-1">
            <button
              type="button"
              onClick={handleLoadOlder}
              disabled={loadingOlder}
              className="text-[11px] font-semibold text-slate-600 bg-white/90 hover:bg-white border border-slate-200 px-3 py-1 rounded-lg flex items-center gap-1.5 shadow-2xs cursor-pointer disabled:opacity-60"
            >
              {loadingOlder && <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none text-[#0E9AA7]" />}
              <span>{loadingOlder ? 'Loading older messages...' : 'Load older messages'}</span>
            </button>
          </div>
        )}

        {/* Loading Skeletons */}
        {loadingInitial && timelineItems.length === 0 && (
          <div className="space-y-3 py-2" aria-label="Loading messages">
            <div className="flex justify-start gap-2">
              <div className="w-7 h-7 rounded-full bg-slate-200 animate-pulse motion-reduce:animate-none shrink-0" />
              <div className="w-52 h-14 rounded-2xl bg-white/90 border border-slate-200/70 animate-pulse motion-reduce:animate-none" />
            </div>
            <div className="flex justify-end">
              <div className="w-44 h-11 rounded-2xl bg-[#0E9AA7]/20 animate-pulse motion-reduce:animate-none" />
            </div>
            <div className="flex justify-start gap-2">
              <div className="w-7 h-7 rounded-full bg-slate-200 animate-pulse motion-reduce:animate-none shrink-0" />
              <div className="w-64 h-16 rounded-2xl bg-white/90 border border-slate-200/70 animate-pulse motion-reduce:animate-none" />
            </div>
            <div className="flex justify-end">
              <div className="w-36 h-10 rounded-2xl bg-[#0E9AA7]/20 animate-pulse motion-reduce:animate-none" />
            </div>
          </div>
        )}

        {/* Error State with Retry */}
        {!loadingInitial && subscriptionError && (
          <div className="mx-auto max-w-sm my-6 bg-white/90 backdrop-blur-md border border-rose-200 rounded-2xl p-4 text-center space-y-2.5 shadow-xs">
            <AlertCircle className="w-6 h-6 text-rose-500 mx-auto" />
            <p className="text-[13px] font-semibold text-[#04203F]">Unable to load chat</p>
            <p className="text-[11px] text-slate-500">{subscriptionError}</p>
            <button
              type="button"
              onClick={() => setRetrySeed((s) => s + 1)}
              className="px-4 py-2 bg-[#0E9AA7] hover:bg-[#0c8591] text-white text-[12px] font-semibold rounded-xl cursor-pointer transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Friendly Empty State */}
        {!loadingInitial && !subscriptionError && timelineItems.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center space-y-2">
            <div className="w-12 h-12 rounded-2xl bg-[#0E9AA7]/10 border border-[#0E9AA7]/20 flex items-center justify-center text-[#0E9AA7]">
              <MessageSquare className="w-6 h-6" />
            </div>
            <h3 className="text-[15px] font-bold text-[#04203F]">
              {isReseller ? 'Hi! How can we help today?' : 'No messages yet'}
            </h3>
            <p className="text-[12px] text-slate-500 max-w-xs leading-relaxed">
              {isReseller
                ? 'Tap a topic below or send a message about your orders, withdrawals, or products.'
                : 'Start a conversation with this reseller below.'}
            </p>
          </div>
        )}

        {/* Grouped Message List + Date Separators */}
        {timelineItems.map((entry, index) => {
          const prev = index > 0 ? timelineItems[index - 1] : null;
          const next = index < timelineItems.length - 1 ? timelineItems[index + 1] : null;

          const getGroupKey = (senderId: string) =>
            isReseller ? (senderId === currentUser.uid ? 'self' : 'support') : senderId;

          const currGroup = getGroupKey(entry.senderId);
          const prevGroup = prev ? getGroupKey(prev.senderId) : null;
          const nextGroup = next ? getGroupKey(next.senderId) : null;

          const currDay = getDayKey(entry.timeMs);
          const prevDay = prev ? getDayKey(prev.timeMs) : null;
          const nextDay = next ? getDayKey(next.timeMs) : null;
          const showDateSeparator = currDay !== prevDay;

          const isFirstInGroup =
            !prev ||
            prevDay !== currDay ||
            prevGroup !== currGroup ||
            entry.timeMs - prev.timeMs > 5 * 60 * 1000;

          const isLastInGroup =
            !next ||
            nextDay !== currDay ||
            nextGroup !== currGroup ||
            next.timeMs - entry.timeMs > 5 * 60 * 1000;

          const isSelf = entry.senderId === currentUser.uid;

          // Render Local Pending / Failed Bubble
          if (entry.kind === 'local') {
            const p = entry.pending;
            return (
              <React.Fragment key={entry.id}>
                {showDateSeparator && (
                  <div className="flex justify-center py-2">
                    <span className="text-[11px] font-semibold text-slate-500 bg-white/85 border border-slate-200/80 px-2.5 py-0.5 rounded-lg">
                      {formatDayLabel(entry.timeMs)}
                    </span>
                  </div>
                )}

                <div className={`flex flex-col items-end ${isFirstInGroup ? 'mt-2' : 'mt-0.5'}`}>
                  <div
                    className={`relative max-w-[85%] sm:max-w-[74%] rounded-2xl px-3.5 py-2.5 shadow-xs space-y-1.5 ${
                      p.status === 'failed'
                        ? 'bg-rose-50 text-rose-950 border border-rose-300 rounded-br-sm'
                        : 'bg-[#0E9AA7]/90 text-white rounded-br-sm'
                    }`}
                  >
                    {p.replyTo && (
                      <div
                        className={`px-2.5 py-1.5 rounded-lg border-l-2 text-[11px] ${
                          p.status === 'failed'
                            ? 'bg-rose-100/70 border-rose-400 text-rose-800'
                            : 'bg-black/15 border-white/60 text-white/90'
                        }`}
                      >
                        <div className="font-semibold truncate">{p.replyTo.senderName}</div>
                        <div className="truncate opacity-85">{p.replyTo.text}</div>
                      </div>
                    )}

                    {p.type === 'image' && p.mediaPreviewUrl && (
                      <img
                        src={p.mediaPreviewUrl}
                        alt="Uploading preview"
                        className="rounded-xl max-h-60 w-auto object-cover opacity-90"
                      />
                    )}

                    {p.text && (
                      <p className="text-[14px] leading-[1.45] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                        {p.text}
                      </p>
                    )}

                    {p.status === 'failed' && (
                      <div className="flex items-center justify-between gap-3 pt-1 text-[11px] font-semibold text-rose-700">
                        <span>{p.errorMsg || 'Failed to send'}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleRetryPending(p)}
                            className="px-2 py-0.5 bg-rose-600 hover:bg-rose-700 text-white rounded-md cursor-pointer"
                          >
                            Retry
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingMessages((list) => list.filter((x) => x.localId !== p.localId))
                            }
                            className="text-rose-600 hover:underline cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {isLastInGroup && (
                    <div className="flex items-center gap-1 mt-0.5 text-[11px] text-slate-400 pr-1">
                      <span>{formatMsgTime(entry.timeMs)}</span>
                      {p.status === 'sending' ? (
                        <Clock className="w-3 h-3 text-slate-400" />
                      ) : (
                        <AlertCircle className="w-3 h-3 text-rose-500" />
                      )}
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          }

          // Render Persisted Firestore Message Bubble
          const msg = entry.msg;
          const isSeen = Boolean(
            msg.read || (msg.readBy && msg.readBy.some((uid) => uid !== currentUser.uid))
          );
          const swipeOffset = swipingMsg?.id === msg.id ? swipingMsg.offsetX : 0;

          return (
            <React.Fragment key={entry.id}>
              {showDateSeparator && (
                <div className="flex justify-center py-2">
                  <span className="text-[11px] font-semibold text-slate-500 bg-white/85 border border-slate-200/80 px-2.5 py-0.5 rounded-lg">
                    {formatDayLabel(entry.timeMs)}
                  </span>
                </div>
              )}

              <div className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'} ${isFirstInGroup ? 'mt-2.5' : 'mt-0.5'}`}>
                {/* Sender name on first bubble of incoming support group */}
                {!isSelf && isFirstInGroup && (
                  <span className="text-[11px] font-semibold text-slate-500 mb-1 ml-9">
                    {msg.senderRole === 'reseller' ? msg.senderName : 'ReSellBD Support'}
                  </span>
                )}

                <div className={`flex items-end gap-2 max-w-full ${isSelf ? 'justify-end' : 'justify-start'}`}>
                  {/* Avatar on last bubble of incoming group */}
                  {!isSelf && (
                    <div className="w-7 shrink-0 flex justify-center">
                      {isLastInGroup ? (
                        partnerPhoto ? (
                          <img
                            src={partnerPhoto}
                            alt={msg.senderName}
                            className="w-7 h-7 rounded-full object-cover border border-slate-200"
                          />
                        ) : (
                          <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-[#04203F] to-[#0E9AA7] flex items-center justify-center text-white text-[11px] font-bold">
                            {isReseller ? <Shield className="w-3.5 h-3.5" /> : (msg.senderName || 'R').charAt(0).toUpperCase()}
                          </div>
                        )
                      ) : null}
                    </div>
                  )}

                  {/* Swipeable Message Bubble */}
                  <div className="relative flex items-center max-w-[82%] sm:max-w-[72%] group">
                    {swipeOffset > 12 && (
                      <div className="absolute -left-7 text-[#0E9AA7]">
                        <Reply className="w-4 h-4" />
                      </div>
                    )}

                    {/* Quick Desktop Hover Action Trigger */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveActionMsg(activeActionMsg?.id === msg.id ? null : msg);
                      }}
                      className={`hidden sm:flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-[#04203F] hover:bg-white/90 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shrink-0 ${
                        isSelf ? 'order-first mr-1' : 'order-last ml-1'
                      }`}
                      aria-label="Message actions"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>

                    <div
                      onTouchStart={(e) => handleBubbleTouchStart(msg, e)}
                      onTouchMove={(e) => handleBubbleTouchMove(msg, e)}
                      onTouchEnd={() => handleBubbleTouchEnd(msg)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setActiveActionMsg(msg);
                      }}
                      style={
                        swipeOffset > 0
                          ? { transform: `translateX(${swipeOffset}px)` }
                          : undefined
                      }
                      className={`relative rounded-2xl px-3.5 py-2.5 shadow-[0_1px_4px_rgba(4,32,63,0.06)] space-y-1.5 transition-transform duration-150 motion-reduce:transition-none ${
                        isSelf
                          ? `bg-gradient-to-br from-[#0E9AA7] to-[#0a828d] text-white ${
                              !isFirstInGroup ? 'rounded-tr-md' : ''
                            } ${isLastInGroup ? 'rounded-br-sm' : 'rounded-br-md'}`
                          : `bg-white/95 backdrop-blur-md text-slate-900 border border-slate-200/80 ${
                              !isFirstInGroup ? 'rounded-tl-md' : ''
                            } ${isLastInGroup ? 'rounded-bl-sm' : 'rounded-bl-md'}`
                      }`}
                    >
                      {/* Quoted Reply Reference */}
                      {msg.replyTo && (
                        <div
                          className={`px-2.5 py-1.5 rounded-xl border-l-2 text-[11px] ${
                            isSelf
                              ? 'bg-black/15 border-white/65 text-white/95'
                              : 'bg-slate-100 border-[#0E9AA7] text-slate-700'
                          }`}
                        >
                          <div className="font-semibold truncate">{msg.replyTo.senderName}</div>
                          <div className="truncate opacity-85">{msg.replyTo.text}</div>
                        </div>
                      )}

                      {/* IMAGE */}
                      {msg.type === 'image' && msg.mediaUrl && (
                        <div className="space-y-1.5">
                          <div
                            onClick={() => {
                              setLightboxImage(msg.mediaUrl || null);
                              setLightboxZoom(1);
                            }}
                            className="rounded-xl overflow-hidden cursor-pointer relative group/img border border-black/10 bg-slate-900/10 max-h-72"
                          >
                            <img
                              src={msg.mediaUrl}
                              alt="Photo attachment"
                              className="w-full h-auto max-h-72 object-cover"
                              loading="lazy"
                            />
                            <div className="absolute bottom-1.5 right-1.5 bg-black/55 text-white px-2 py-0.5 rounded-lg text-[10px] font-semibold flex items-center gap-1 opacity-90 sm:opacity-0 sm:group-hover/img:opacity-100 transition-opacity motion-reduce:transition-none">
                              <ZoomIn className="w-3 h-3" />
                              <span>View</span>
                            </div>
                          </div>
                          {msg.text && msg.text !== '📷 Photo' && (
                            <p className="text-[14px] leading-[1.45] whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text">
                              {renderTextWithLinks(msg.text, isSelf)}
                            </p>
                          )}
                        </div>
                      )}

                      {/* VOICE */}
                      {msg.type === 'voice' && msg.mediaUrl && (
                        <VoicePlayer
                          audioUrl={msg.mediaUrl}
                          duration={msg.mediaDuration || 0}
                          isSelf={isSelf}
                        />
                      )}

                      {/* ORDER REFERENCE CARD */}
                      {msg.type === 'order_link' && msg.orderId && (
                        <div
                          className={`p-2.5 rounded-xl border space-y-1.5 min-w-[200px] ${
                            isSelf
                              ? 'bg-white/15 border-white/25 text-white'
                              : 'bg-slate-50 border-slate-200 text-slate-900'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 font-bold text-[12.5px]">
                              <ShoppingBag className={`w-4 h-4 ${isSelf ? 'text-white' : 'text-[#0E9AA7]'}`} />
                              <span>Order #{msg.orderNumber || msg.orderId.slice(0, 8)}</span>
                            </div>
                            <span
                              className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${
                                isSelf ? 'bg-white/20 text-white' : 'bg-[#04203F] text-white'
                              }`}
                            >
                              {msg.orderStatus || 'ACTIVE'}
                            </span>
                          </div>
                          {msg.orderAmount ? (
                            <div className="text-[12px] font-semibold opacity-95 tabular-nums">
                              Total: ৳{msg.orderAmount.toLocaleString()}
                            </div>
                          ) : null}
                          {onOpenOrder && (
                            <button
                              type="button"
                              onClick={() => onOpenOrder(msg.orderId!)}
                              className={`w-full py-1.5 text-center font-semibold text-[11px] rounded-lg transition-colors flex items-center justify-center gap-1 cursor-pointer ${
                                isSelf
                                  ? 'bg-white/20 hover:bg-white/30 text-white'
                                  : 'bg-[#0E9AA7] hover:bg-[#0c8591] text-white'
                              }`}
                            >
                              <span>View Order</span>
                              <ExternalLink className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      )}

                      {/* PRODUCT REFERENCE CARD */}
                      {msg.type === 'product_link' && msg.productId && (
                        <div
                          className={`p-2.5 rounded-xl border space-y-1.5 min-w-[200px] ${
                            isSelf
                              ? 'bg-white/15 border-white/25 text-white'
                              : 'bg-slate-50 border-slate-200 text-slate-900'
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            {msg.productImage ? (
                              <img
                                src={msg.productImage}
                                alt={msg.productName}
                                className="w-11 h-11 rounded-lg object-cover border border-black/10 shrink-0"
                              />
                            ) : (
                              <div className="w-11 h-11 rounded-lg bg-slate-200 flex items-center justify-center text-slate-500 shrink-0">
                                <Package className="w-5 h-5" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="font-bold text-[12.5px] truncate">{msg.productName}</p>
                              {msg.productPrice ? (
                                <p className={`text-[11px] font-bold ${isSelf ? 'text-cyan-100' : 'text-[#0E9AA7]'}`}>
                                  ৳{msg.productPrice.toLocaleString()}
                                </p>
                              ) : null}
                            </div>
                          </div>
                          {onOpenProduct && (
                            <button
                              type="button"
                              onClick={() => onOpenProduct(msg.productId!)}
                              className={`w-full py-1.5 text-center font-semibold text-[11px] rounded-lg transition-colors flex items-center justify-center gap-1 cursor-pointer ${
                                isSelf
                                  ? 'bg-white/20 hover:bg-white/30 text-white'
                                  : 'bg-[#04203F] hover:bg-slate-800 text-white'
                              }`}
                            >
                              <span>View Product</span>
                              <ExternalLink className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      )}

                      {/* STANDARD TEXT */}
                      {msg.type === 'text' && msg.text && (
                        <p className="text-[14px] leading-[1.45] whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text">
                          {renderTextWithLinks(msg.text, isSelf)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Time & Read Status Ticks under group */}
                {isLastInGroup && (
                  <div
                    className={`flex items-center gap-1 mt-1 text-[11px] text-slate-400 tabular-nums ${
                      isSelf ? 'pr-1' : 'pl-9'
                    }`}
                  >
                    <span>{formatMsgTime(entry.timeMs)}</span>
                    {isSelf && (
                      <span title={isSeen ? 'Seen' : 'Sent'}>
                        {isSeen ? (
                          <CheckCheck className="w-3.5 h-3.5 text-[#0E9AA7] inline" />
                        ) : (
                          <Check className="w-3.5 h-3.5 text-slate-400 inline" />
                        )}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}

        {/* Typing Indicator Bubble */}
        {otherIsTyping && (
          <div className="flex items-end gap-2 mt-2">
            <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-[#04203F] to-[#0E9AA7] flex items-center justify-center text-white shrink-0">
              <Shield className="w-3.5 h-3.5" />
            </div>
            <div className="px-3.5 py-2.5 bg-white/95 backdrop-blur-md border border-slate-200/80 rounded-2xl rounded-bl-sm shadow-2xs flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0E9AA7] animate-bounce motion-reduce:animate-none" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-[#0E9AA7] animate-bounce motion-reduce:animate-none" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-[#0E9AA7] animate-bounce motion-reduce:animate-none" style={{ animationDelay: '300ms' }} />
              <span className="text-[11px] font-medium text-slate-500 ml-1">Typing...</span>
            </div>
          </div>
        )}

        {/* Optional End-of-Chat Rating (Only if support marked chat resolved) */}
        {showOptionalRating && (
          <div className="mx-auto max-w-md my-3 bg-white/95 backdrop-blur-md border border-slate-200 rounded-2xl p-3.5 shadow-xs space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-bold text-[#04203F]">Rate your support experience</span>
              <button
                type="button"
                onClick={() => setRatingDismissed(true)}
                className="text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                aria-label="Dismiss rating"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRatingStars(star)}
                  className="p-1.5 rounded-lg hover:bg-amber-50 transition-colors cursor-pointer"
                  aria-label={`Rate ${star} stars`}
                >
                  <Star
                    className={`w-6 h-6 ${
                      star <= ratingStars ? 'text-amber-400 fill-amber-400' : 'text-slate-300'
                    }`}
                  />
                </button>
              ))}
            </div>
            {ratingStars > 0 && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={ratingComment}
                  onChange={(e) => setRatingComment(e.target.value)}
                  placeholder="Optional comment..."
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[12.5px] focus:outline-none focus:border-[#0E9AA7]"
                />
                <button
                  type="button"
                  onClick={handleSubmitRating}
                  disabled={ratingSubmitting}
                  className="px-3.5 py-2 bg-[#0E9AA7] hover:bg-[#0c8591] text-white text-[12px] font-semibold rounded-xl cursor-pointer disabled:opacity-60"
                >
                  {ratingSubmitting ? 'Saving...' : 'Submit'}
                </button>
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>

        {/* Floating "New messages" / Scroll to bottom button (anchored cleanly inside list wrapper) */}
        {showJumpButton && (
          <div className="absolute bottom-3 right-3 sm:right-4 z-20 pointer-events-auto">
            <button
              type="button"
              onClick={scrollToBottom}
              className="px-3 py-2 bg-[#04203F] hover:bg-slate-800 text-white text-[12px] font-semibold rounded-xl shadow-lg flex items-center gap-1.5 transition-all cursor-pointer active:scale-95 motion-reduce:transition-none"
            >
              <ArrowDown className="w-3.5 h-3.5 text-[#3DD055]" />
              <span>
                {newBelowCount > 0 ? `New messages (${newBelowCount})` : 'New messages'}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Message Action Sheet Modal (Reply / Copy / Delete) */}
      {activeActionMsg && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-3"
          onClick={() => setActiveActionMsg(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white w-full max-w-xs rounded-2xl border border-slate-200 shadow-2xl p-2 space-y-1"
          >
            <button
              type="button"
              onClick={() => {
                setReplyingTo(buildReplySnippet(activeActionMsg));
                setActiveActionMsg(null);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              className="w-full px-3.5 py-2.5 rounded-xl text-[13px] font-semibold text-slate-800 hover:bg-slate-100 flex items-center gap-2.5 cursor-pointer"
            >
              <Reply className="w-4 h-4 text-[#0E9AA7]" />
              <span>Reply</span>
            </button>

            {activeActionMsg.text && (
              <button
                type="button"
                onClick={() => handleCopyMessageText(activeActionMsg)}
                className="w-full px-3.5 py-2.5 rounded-xl text-[13px] font-semibold text-slate-800 hover:bg-slate-100 flex items-center gap-2.5 cursor-pointer"
              >
                <Copy className="w-4 h-4 text-slate-600" />
                <span>Copy text</span>
              </button>
            )}

            {activeActionMsg.senderId === currentUser.uid && (
              <button
                type="button"
                onClick={() => {
                  setConfirmDeleteMsg(activeActionMsg);
                  setActiveActionMsg(null);
                }}
                className="w-full px-3.5 py-2.5 rounded-xl text-[13px] font-semibold text-rose-600 hover:bg-rose-50 flex items-center gap-2.5 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                <span>Delete message</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveActionMsg(null)}
              className="w-full px-3.5 py-2 rounded-xl text-[12px] font-medium text-slate-500 hover:bg-slate-50 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDeleteMsg && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setConfirmDeleteMsg(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white w-full max-w-xs rounded-2xl border border-slate-200 shadow-2xl p-4 space-y-3"
          >
            <h4 className="text-[15px] font-bold text-[#04203F]">Delete message?</h4>
            <p className="text-[12px] text-slate-500">
              This will remove your message from the chat. You can undo for 5 seconds.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmDeleteMsg(null)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-[12.5px] font-semibold hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-[12.5px] font-semibold cursor-pointer"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5-second Undo Snackbar for deleted message */}
      {undoDeleteState && (
        <div className="mx-3 mb-2 bg-[#04203F] text-white px-3.5 py-2 rounded-xl shadow-lg flex items-center justify-between text-[12px] shrink-0">
          <span>Message deleted</span>
          <button
            type="button"
            onClick={handleUndoDelete}
            className="font-bold text-[#3DD055] hover:underline px-2 py-0.5 cursor-pointer"
          >
            Undo
          </button>
        </div>
      )}

      {/* Toast Feedback */}
      {toastMsg && (
        <div className="mx-auto mb-1.5 bg-[#04203F]/90 text-white px-3 py-1 rounded-lg text-[11px] font-medium shadow-md shrink-0">
          {toastMsg}
        </div>
      )}

      {/* Replying-to Preview Strip */}
      {replyingTo && (
        <div className="bg-white border-t border-slate-200 px-3 py-2 flex items-center justify-between gap-2 shrink-0">
          <div className="border-l-2 border-[#0E9AA7] pl-2.5 min-w-0 flex-1">
            <div className="text-[11px] font-bold text-[#0E9AA7] truncate">
              Replying to {replyingTo.senderName}
            </div>
            <div className="text-[12px] text-slate-600 truncate">{replyingTo.text}</div>
          </div>
          <button
            type="button"
            onClick={() => setReplyingTo(null)}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer shrink-0"
            aria-label="Cancel reply"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 3. PHOTO COMPRESSION / PREVIEW BAR BEFORE SENDING */}
      {isCompressingPhoto && (
        <div className="bg-white border-t border-slate-200 px-3 py-2.5 flex items-center gap-2 text-[12px] font-medium text-slate-600 shrink-0">
          <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none text-[#0E9AA7] shrink-0" />
          <span>Preparing photo...</span>
        </div>
      )}
      {imagePreviewUrl && (
        <div className="bg-white border-t border-slate-200 px-3 py-2.5 flex items-center gap-2.5 shrink-0">
          <div className="relative w-14 h-14 rounded-xl overflow-hidden border border-slate-200 shrink-0 bg-slate-100">
            <img src={imagePreviewUrl} alt="Selected photo" className="w-full h-full object-cover" />
            <button
              type="button"
              onClick={() => {
                setImagePreviewUrl(null);
                setSelectedImageFile(null);
                setSelectedImageName('');
                setImageCaption('');
              }}
              className="absolute top-0.5 right-0.5 bg-slate-900/75 hover:bg-slate-900 text-white p-0.5 rounded-full cursor-pointer"
              aria-label="Remove photo"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <input
              type="text"
              value={imageCaption}
              onChange={(e) => setImageCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSendImage();
                }
              }}
              placeholder="Add caption (optional)..."
              className="flex-1 min-w-0 bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 text-[13px] text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#0E9AA7]"
            />
            <button
              type="button"
              onClick={handleSendImage}
              disabled={isSending || isCompressingPhoto}
              className="h-10 px-3.5 bg-[#0E9AA7] hover:bg-[#0c8591] disabled:opacity-50 text-white font-semibold text-[12.5px] rounded-xl flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              {isSending ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Send className="w-4 h-4" />}
              <span>Send</span>
            </button>
          </div>
        </div>
      )}

      {/* Quick-Reply Chips Above Input */}
      {showQuickReplyChips && (
        <div className="bg-slate-50/95 border-t border-slate-200/70 px-3 py-2 flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0">
          {QUICK_REPLIES.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => handleQuickReplyTap(chip)}
              className="px-2.5 py-1.5 bg-white hover:bg-[#0E9AA7]/10 border border-slate-200/90 hover:border-[#0E9AA7]/40 text-[#04203F] text-[12px] font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors cursor-pointer"
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      {/* 4. COMPOSER FOOTER (AUTO-RESIZE TEXTAREA + PHOTO GALLERY/CAMERA + ATTACH ORDER + VOICE + SEND) */}
      <footer
        className={`bg-white/95 backdrop-blur-xl border-t border-slate-200/90 px-2.5 sm:px-3.5 pt-2 shrink-0 relative ${
          fullScreen ? 'pb-[max(env(safe-area-inset-bottom,0px),0.55rem)]' : 'pb-2.5'
        }`}
      >
        {isRecordingVoice ? (
          <VoiceRecorder
            onSendVoice={handleSendVoice}
            onCancel={() => setIsRecordingVoice(false)}
          />
        ) : (
          <div className="space-y-1.5">
            {/* Hidden Inputs for Photo Gallery & Camera */}
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileChange}
            />

            {/* Main Composer Row */}
            <div className="flex items-end gap-1.5">
              {/* Attach Popover Button (Gallery / Camera / Order / Product) */}
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setShowAttachMenu((v) => !v)}
                  className="w-10 h-10 rounded-xl text-slate-600 hover:text-[#04203F] hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer"
                  aria-label="Attach photo or item"
                  title="Attach photo, order, or product"
                >
                  <Paperclip className="w-5 h-5" />
                </button>

                {showAttachMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setShowAttachMenu(false)}
                    />
                    <div className="absolute bottom-12 left-0 z-30 bg-white rounded-2xl shadow-2xl border border-slate-200 p-1.5 w-48 space-y-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          galleryInputRef.current?.click();
                          setShowAttachMenu(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] font-semibold text-slate-700 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
                      >
                        <ImageIcon className="w-4 h-4 text-[#0E9AA7]" />
                        <span>Photo from gallery</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          cameraInputRef.current?.click();
                          setShowAttachMenu(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] font-semibold text-slate-700 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
                      >
                        <Camera className="w-4 h-4 text-[#3DD055]" />
                        <span>Take photo</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowOrderPicker(true);
                          setShowAttachMenu(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] font-semibold text-slate-700 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
                      >
                        <ShoppingBag className="w-4 h-4 text-blue-600" />
                        <span>Attach order</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowProductPicker(true);
                          setShowAttachMenu(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[12.5px] font-semibold text-slate-700 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
                      >
                        <Package className="w-4 h-4 text-amber-600" />
                        <span>Share product</span>
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Compact Attach Order Button (icon-only <360px, "Order" 360px-639px, "Attach order" >=640px) */}
              <button
                type="button"
                onClick={() => setShowOrderPicker(true)}
                className="h-10 min-w-[40px] px-2.5 rounded-xl bg-slate-100 hover:bg-slate-200/80 text-slate-700 text-[11.5px] font-semibold flex items-center justify-center gap-1.5 shrink-0 transition-colors motion-reduce:transition-none cursor-pointer"
                aria-label="Attach order"
                title="Attach order"
              >
                <ShoppingBag className="w-4 h-4 text-[#0E9AA7] shrink-0" />
                <span className="hidden min-[360px]:inline sm:hidden">Order</span>
                <span className="hidden sm:inline">Attach order</span>
              </button>

              {/* Auto-Resizing Textarea (up to 4 lines) */}
              <textarea
                ref={textareaRef}
                rows={1}
                value={inputText}
                onChange={handleInputChange}
                onKeyDown={(e) => {
                  const isDesktopPointer =
                    typeof window !== 'undefined' &&
                    window.matchMedia?.('(pointer: fine)').matches;
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && isDesktopPointer) {
                    e.preventDefault();
                    handleSendText();
                  }
                }}
                placeholder="Type a message..."
                className="flex-1 min-w-0 bg-slate-100 focus:bg-white border border-slate-200 focus:border-[#0E9AA7] rounded-xl px-3 py-2 text-[14px] leading-[1.35] text-slate-900 placeholder-slate-400 focus:outline-none resize-none max-h-[96px] overflow-y-auto transition-colors motion-reduce:transition-none"
              />

              {/* Voice Mic Button */}
              {!inputText.trim() && (
                <button
                  type="button"
                  onClick={() => setIsRecordingVoice(true)}
                  className="w-10 h-10 bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-[#0E9AA7] rounded-xl flex items-center justify-center transition-colors cursor-pointer shrink-0"
                  aria-label="Record voice message"
                  title="Record voice note"
                >
                  <Mic className="w-4.5 h-4.5" />
                </button>
              )}

              {/* Send Button (Always disabled when input is empty) */}
              <button
                type="button"
                onClick={handleSendText}
                disabled={!inputText.trim() || isSending}
                className="w-10 h-10 bg-[#0E9AA7] hover:bg-[#0c8591] disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
                aria-label="Send message"
                title="Send message"
              >
                {isSending ? <Loader2 className="w-4.5 h-4.5 animate-spin motion-reduce:animate-none" /> : <Send className="w-4.5 h-4.5" />}
              </button>
            </div>
          </div>
        )}
      </footer>

      {/* 5. FULL-SCREEN IMAGE VIEWER WITH ZOOM */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[70] bg-slate-950/95 backdrop-blur-sm flex flex-col justify-between p-4 pt-[max(env(safe-area-inset-top,0px),1rem)] pb-[max(env(safe-area-inset-bottom,0px),1rem)]"
          onClick={() => setLightboxImage(null)}
        >
          {/* Top Bar */}
          <div
            className="flex items-center justify-between text-white shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setLightboxZoom((z) => Math.max(1, Number((z - 0.5).toFixed(1))))}
                className="p-2 bg-white/15 hover:bg-white/25 rounded-xl cursor-pointer"
                aria-label="Zoom out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-[12px] font-mono px-2 min-w-[44px] text-center">
                {lightboxZoom.toFixed(1)}x
              </span>
              <button
                type="button"
                onClick={() => setLightboxZoom((z) => Math.min(4, Number((z + 0.5).toFixed(1))))}
                className="p-2 bg-white/15 hover:bg-white/25 rounded-xl cursor-pointer"
                aria-label="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              {lightboxZoom !== 1 && (
                <button
                  type="button"
                  onClick={() => setLightboxZoom(1)}
                  className="p-2 bg-white/15 hover:bg-white/25 rounded-xl cursor-pointer"
                  aria-label="Reset zoom"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <a
                href={lightboxImage}
                download="support_chat_image.jpg"
                onClick={(e) => e.stopPropagation()}
                className="px-3 py-2 bg-white/15 hover:bg-white/25 text-white font-semibold text-[12px] rounded-xl flex items-center gap-1.5"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Save</span>
              </a>
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                className="p-2 bg-white/15 hover:bg-white/25 text-white rounded-xl cursor-pointer"
                aria-label="Close image viewer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Pinch-Zoomable Image Stage */}
          <div
            className="flex-1 flex items-center justify-center overflow-auto my-3"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => {
              if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                pinchStartDistRef.current = Math.hypot(dx, dy);
                pinchStartZoomRef.current = lightboxZoom;
              }
            }}
            onTouchMove={(e) => {
              if (e.touches.length === 2 && pinchStartDistRef.current) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.hypot(dx, dy);
                const next = Math.min(
                  4,
                  Math.max(1, (dist / pinchStartDistRef.current) * pinchStartZoomRef.current)
                );
                setLightboxZoom(Number(next.toFixed(2)));
              }
            }}
            onTouchEnd={() => {
              pinchStartDistRef.current = null;
            }}
          >
            <img
              src={lightboxImage}
              alt="Enlarged attachment"
              onDoubleClick={() => setLightboxZoom((z) => (z > 1 ? 1 : 2))}
              style={{ transform: `scale(${lightboxZoom})`, transformOrigin: 'center center' }}
              className="max-w-full max-h-full object-contain rounded-xl transition-transform duration-150 motion-reduce:transition-none select-none"
            />
          </div>
        </div>
      )}

      {/* 6. ORDER PICKER MODAL */}
      <OrderAttachmentPickerModal
        isOpen={showOrderPicker}
        onClose={() => setShowOrderPicker(false)}
        user={currentUser}
        onSelectOrder={handleSelectOrder}
      />

      {/* 7. PRODUCT PICKER MODAL */}
      <ProductAttachmentPickerModal
        isOpen={showProductPicker}
        onClose={() => setShowProductPicker(false)}
        onSelectProduct={handleSelectProduct}
      />
    </div>
  );
};

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Clock, LogOut, Plus, Lock, Settings, X, Check, Banknote,
  Smartphone, ChevronLeft, UserPlus, AlertCircle, Delete, ShieldCheck,
  Users, Receipt, Trash2, CalendarClock, ChevronRight, Home, ListOrdered, FileBarChart2,
  UserMinus, PieChart, Download, TimerReset, AlertTriangle, SlidersHorizontal, Search
} from 'lucide-react';
import { fetchEmployees, insertEmployee, updateEmployeeActive, updateEmployeePin, fetchAttendance, insertAttendance, clockOutAttendance, insertBackfillAttendance, updateAttendanceTimes, fetchTransactions, insertTransaction, updateTransaction, voidTransaction, fetchClosings, upsertClosing, fetchPushSubscriptionForEndpoint, savePushSubscription, deletePushSubscription, uploadClosingPhoto, fetchCategoryLimits, upsertCategoryLimit, deleteCategoryLimit } from './api';
import { supabase } from './supabaseClient';

const LOGO_ICON = '/icons/logo-icon.jpg';
const LOGO_FULL = '/icons/logo-full.jpg';

const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1];
const CATEGORIES = [
  "Printing Income", "Xerox Income", "Rush ID Income", "Lamination Income",
  "School Supplies Income", "Personalzied School Essentials Income", "Photoprinting Income",
  "Mug Printing Income", "Sticker Printing Income", "Keychain Income", "Button Pin Income",
  "Toys Income", "Accessories Income", "Candies Income", "General Merchandise Income",
  "Supplies", "Utilities", "Equipment", "Transportation", "Miscellaneous", "Pink Wallet Migration"
];
const ROLES = ["Employee", "Manager", "Admin", "Owner"];
const DISCREPANCY_THRESHOLD = 30;
// Public VAPID key - safe to expose in client code by design (this is what
// authenticates push messages as coming from this app; the matching PRIVATE
// key stays server-side only, inside the Supabase Edge Function).
const VAPID_PUBLIC_KEY = 'BPAegFHAmir2L-9gRZ5XplSXDtPsWE11BDVGonHYOqab3SpWRaMwOXsURpfqm1v0jqDMQmRcduEOVL7Yy-ARqmI';

const peso = (n) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 }).format(Number(n) || 0);
const todayStr = (d = new Date()) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
// Transaction timestamps are stored as UTC ISO strings. Slicing the first 10
// characters gives the UTC calendar date, which is WRONG for a shop in a
// UTC+8 timezone during local midnight-8am (it would still show yesterday's
// UTC date). This always converts to the device's local calendar date instead.
const localDateKey = (iso) => todayStr(new Date(iso));
const mondayOf = (dateKey) => {
  const d = new Date(dateKey + 'T00:00:00');
  const diff = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - diff);
  return todayStr(d);
};
const addDaysToKey = (dateKey, n) => {
  const d = new Date(dateKey + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayStr(d);
};
function computeDigestStats(transactions, closings, predicate) {
  let cashIn = 0, cashOut = 0, count = 0;
  const catTotals = {};
  for (const t of transactions) {
    if (t.voided) continue;
    const dk = localDateKey(t.datetime);
    if (!predicate(dk)) continue;
    count++;
    const amt = Number(t.amount) || 0;
    if (t.destination === 'Cash') { t.type === 'Cash In' ? cashIn += amt : cashOut += amt; }
    const signed = (t.type === 'Cash In' ? 1 : -1) * amt;
    catTotals[t.category] = (catTotals[t.category] || 0) + signed;
  }
  let discrepancyDays = 0;
  for (const c of closings) {
    if (c.status !== 'Closed' || !predicate(c.date)) continue;
    if (Math.abs(c.cashDifference || 0) >= DISCREPANCY_THRESHOLD || Math.abs(c.gcashDifference || 0) >= DISCREPANCY_THRESHOLD) discrepancyDays++;
  }
  const topCategories = Object.entries(catTotals)
    .map(([category, net]) => ({ category, net }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 3);
  return { cashIn, cashOut, net: cashIn - cashOut, count, topCategories, discrepancyDays };
}
const uid = (p = 'ID') => `${p}-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();

// Phone camera photos are often 8-15MB+ at full resolution. Holding that in
// memory for a preview (and uploading it) is exactly what causes low-memory
// crashes on weaker Android devices. This shrinks the image to a reasonable
// size immediately, before it's ever held onto or displayed.
function compressImage(file, maxDimension = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDimension) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else if (height >= width && height > maxDimension) {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('Could not process image')); return; }
        resolve(new File([blob], 'drawer-photo.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Could not load image')); };
    img.src = objectUrl;
  });
}

const timeStr = (iso) => iso ? new Date(iso).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }) : '';
const dateTimeStr = (iso) => iso ? new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

const initials = (name) => (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows, columns) {
  const header = columns.map(c => csvCell(c.label)).join(',');
  const lines = rows.map(r => columns.map(c => csvCell(c.value(r))).join(','));
  return [header, ...lines].join('\n');
}
function downloadCSV(filename, csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const PING_SOUND_DATA_URI = '/ping.wav';

// iOS Safari (both in the browser and as an installed home-screen app) is
// notoriously strict about audio: even a properly "unlocked" raw
// AudioContext oscillator can silently get re-suspended later (e.g. after
// the screen locks) with no way to resume it outside a real tap. A real
// HTMLAudioElement is treated more leniently - once it has been played as a
// direct result of a genuine tap (even muted/paused immediately after),
// iOS keeps allowing that SAME element to be replayed programmatically
// (from timers, websocket events, etc.) for the rest of the page session.
let sharedAudioEl = null;
function getAudioEl() {
  if (!sharedAudioEl) {
    sharedAudioEl = new Audio(PING_SOUND_DATA_URI);
    sharedAudioEl.preload = 'auto';
  }
  return sharedAudioEl;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getExistingPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function enablePushNotifications(employee) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported on this browser.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  await savePushSubscription({
    employeeId: employee.id,
    employeeName: employee.name,
    role: employee.role,
    subscription,
  });
  return subscription;
}

async function disablePushNotifications() {
  const subscription = await getExistingPushSubscription();
  if (subscription) {
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await deletePushSubscription(endpoint);
  }
}

function unlockAudioForIOS() {
  const el = getAudioEl();
  const playAttempt = el.play();
  if (playAttempt && typeof playAttempt.then === 'function') {
    playAttempt.then(() => {
      el.pause();
      el.currentTime = 0;
    }).catch(() => {});
  }
}

function playPingSound() {
  try {
    const el = getAudioEl();
    el.currentTime = 0;
    const playAttempt = el.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch((e) => console.error('ping sound failed', e));
    }
  } catch (e) { console.error('ping sound failed', e); }
}


function PinDots({ value, length = 4 }) {
  return (
    <div className="pin-dots-row">
      {Array.from({ length }).map((_, i) => (
        <div key={i} className={`pin-dot ${i < value.length ? 'pin-dot-filled' : ''}`} />
      ))}
    </div>
  );
}

function Keypad({ onDigit, onDelete }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  return (
    <div className="keypad-grid">
      {keys.map((k, i) => k === '' ? <div key={i} /> : (
        <button
          key={i}
          type="button"
          onClick={() => k === 'del' ? onDelete() : onDigit(k)}
          className="keypad-btn"
        >
          {k === 'del' ? <Delete size={20} /> : k}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [attendance, setAttendance] = useState([]);

  useEffect(() => {
    const unlock = () => {
      unlockAudioForIOS();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchstart', unlock);
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('touchstart', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchstart', unlock);
    };
  }, []);
  const [transactions, setTransactions] = useState([]);
  const [closings, setClosings] = useState([]);
  const [categoryLimits, setCategoryLimits] = useState([]);

  const [now, setNow] = useState(new Date());
  const [currentEmployee, setCurrentEmployee] = useState(null);
  const [activeView, setActiveView] = useState('home');
  const [toasts, setToasts] = useState([]);
  const pendingIdsRef = useRef(new Set());
  const knownAttendanceIdsRef = useRef(null);
  const knownTransactionIdsRef = useRef(null);
  const knownClosingsRef = useRef(null);
  const currentEmployeeRef = useRef(null);

  const pushToast = (message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, message }]);
    playPingSound();
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  };
  const markOwnAction = (id) => {
    pendingIdsRef.current.add(id);
    setTimeout(() => pendingIdsRef.current.delete(id), 10000);
  };

  const [loginPicked, setLoginPicked] = useState(null);
  const [pin, setPin] = useState('');
  const [loginError, setLoginError] = useState('');
  const shakeRef = useRef(false);
  const [shake, setShake] = useState(false);

  const [showTxn, setShowTxn] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCloseDay, setShowCloseDay] = useState(false);
  const [showCashCount, setShowCashCount] = useState(false);
  const [showOpeningEntry, setShowOpeningEntry] = useState(false);
  const [closingDraft, setClosingDraft] = useState(null);
  const [closedReceipt, setClosedReceipt] = useState(null);

  const syncAttendance = async () => {
    const rows = await fetchAttendance();
    if (knownAttendanceIdsRef.current) {
      for (const a of rows) {
        if (!knownAttendanceIdsRef.current.has(a.id) && !pendingIdsRef.current.has(a.id)) {
          pushToast(`${a.employeeName} clocked in`);
        }
      }
    }
    knownAttendanceIdsRef.current = new Set(rows.map(a => a.id));
    setAttendance(rows);
  };

  const categoryLimitsRef = useRef([]);
  useEffect(() => { categoryLimitsRef.current = categoryLimits; }, [categoryLimits]);
  const notifiedLimitsRef = useRef(new Set());

  const syncTransactions = async () => {
    const rows = await fetchTransactions();
    const isFirstLoad = !knownTransactionIdsRef.current;
    const newRows = knownTransactionIdsRef.current
      ? rows.filter(t => !knownTransactionIdsRef.current.has(t.id) && !pendingIdsRef.current.has(t.id))
      : [];
    for (const t of newRows) {
      const sign = t.type === 'Cash In' ? '+' : '−';
      pushToast(`${t.createdByName} added ${sign}${peso(t.amount)} (${t.category})`);
    }
    if (!isFirstLoad) {
      for (const t of newRows) {
        if (t.type !== 'Cash Out') continue;
        const limitRow = categoryLimitsRef.current.find(l => l.category === t.category);
        if (!limitRow) continue;
        const monthKey = localDateKey(t.datetime).slice(0, 7);
        const dedupeKey = `${t.category}-${monthKey}`;
        if (notifiedLimitsRef.current.has(dedupeKey)) continue;
        let totalThisMonth = 0;
        for (const tx of rows) {
          if (tx.type === 'Cash Out' && tx.category === t.category && localDateKey(tx.datetime).slice(0, 7) === monthKey) {
            totalThisMonth += Number(tx.amount) || 0;
          }
        }
        const totalBefore = totalThisMonth - (Number(t.amount) || 0);
        if (totalThisMonth >= limitRow.monthlyLimit && totalBefore < limitRow.monthlyLimit) {
          notifiedLimitsRef.current.add(dedupeKey);
          const me = currentEmployeeRef.current;
          if (me && ['Manager', 'Admin', 'Owner'].includes(me.role)) {
            pushToast(`Spending limit reached: ${t.category} hit ${peso(totalThisMonth)} this month`);
          }
        }
      }
    }
    knownTransactionIdsRef.current = new Set(rows.map(t => t.id));
    setTransactions(rows);
  };

  const syncClosings = async () => {
    const rows = await fetchClosings();
    const me = currentEmployeeRef.current;
    const iCanManage = me && ['Manager', 'Admin', 'Owner'].includes(me.role);
    const iCanSeeDiscrepancies = me && (me.role === 'Admin' || me.role === 'Owner');
    if (knownClosingsRef.current) {
      for (const c of rows) {
        const prevStatus = knownClosingsRef.current.get(c.id);
        const justClosed = c.status === 'Closed' && prevStatus !== 'Closed';
        if (justClosed && !pendingIdsRef.current.has(c.id)) {
          if (iCanManage) {
            pushToast(`Day closed: ${c.date} closed by ${c.closedBy}`);
          }
          const hasDiscrepancy = Math.abs(c.cashDifference || 0) >= DISCREPANCY_THRESHOLD || Math.abs(c.gcashDifference || 0) >= DISCREPANCY_THRESHOLD;
          if (hasDiscrepancy && iCanSeeDiscrepancies) {
            const parts = [];
            if (Math.abs(c.cashDifference || 0) >= DISCREPANCY_THRESHOLD) {
              parts.push(`cash ${c.cashDifference >= 0 ? 'over' : 'short'} by ${peso(Math.abs(c.cashDifference))}`);
            }
            if (Math.abs(c.gcashDifference || 0) >= DISCREPANCY_THRESHOLD) {
              parts.push(`GCash ${c.gcashDifference >= 0 ? 'over' : 'short'} by ${peso(Math.abs(c.gcashDifference))}`);
            }
            pushToast(`Discrepancy on ${c.date}: ${parts.join(' · ')}`);
          }
        }
      }
    }
    knownClosingsRef.current = new Map(rows.map(c => [c.id, c.status]));
    setClosings(rows);
  };

  useEffect(() => {
    currentEmployeeRef.current = currentEmployee;
  }, [currentEmployee]);

  useEffect(() => {
    (async () => {
      try {
        const [e, , , , limits] = await Promise.all([
          fetchEmployees(), syncAttendance(), syncTransactions(), syncClosings(), fetchCategoryLimits(),
        ]);
        setEmployees(e);
        setCategoryLimits(limits);
        const savedId = localStorage.getItem('pwc_pos_employee_id');
        if (savedId) {
          const savedEmployee = e.find(emp => emp.id === savedId && emp.active !== false);
          if (savedEmployee) setCurrentEmployee(savedEmployee);
          else localStorage.removeItem('pwc_pos_employee_id');
        }
      } catch (err) {
        console.error('Failed to load data from Supabase', err);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Live sync: pick up changes made from other devices/tabs.
  // Both the realtime subscription AND the periodic poll below call the same
  // syncAttendance/syncTransactions/syncClosings functions, which detect new
  // or changed rows by comparing against what we've already seen - this way
  // the ping/toast fires reliably even if the realtime WebSocket connection
  // is flaky, since the poll acts as a guaranteed fallback using the same
  // detection logic.
  useEffect(() => {
    const refreshAll = () => {
      fetchEmployees().then(setEmployees).catch(console.error);
      syncAttendance().catch(console.error);
      syncTransactions().catch(console.error);
      syncClosings().catch(console.error);
      fetchCategoryLimits().then(setCategoryLimits).catch(console.error);
    };

    const channel = supabase.channel('pos-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employees' }, () => {
        fetchEmployees().then(setEmployees).catch(console.error);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, () => {
        syncAttendance().catch(console.error);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
        syncTransactions().catch(console.error);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'closings' }, () => {
        syncClosings().catch(console.error);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'category_limits' }, () => {
        fetchCategoryLimits().then(setCategoryLimits).catch(console.error);
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error('Realtime subscription issue:', status, '- falling back to periodic polling only.');
        }
      });

    const pollInterval = setInterval(refreshAll, 6000);

    return () => { supabase.removeChannel(channel); clearInterval(pollInterval); };
  }, []);


  const today = todayStr(now);

  const activeCashiers = useMemo(
    () => attendance.filter(a => a.date === today && !a.clockOut),
    [attendance, today]
  );
  const myAttendance = useMemo(
    () => currentEmployee ? attendance.find(a => a.date === today && a.employeeId === currentEmployee.id && !a.clockOut) : null,
    [attendance, today, currentEmployee]
  );
  const isClockedIn = !!myAttendance;

  const todaysTxns = useMemo(
    () => transactions.filter(t => !t.voided && localDateKey(t.datetime) === today).sort((a, b) => b.datetime.localeCompare(a.datetime)),
    [transactions, today]
  );

  const sums = useMemo(() => {
    let cashIn = 0, cashOut = 0, gcashIn = 0, gcashOut = 0;
    for (const t of todaysTxns) {
      const amt = Number(t.amount) || 0;
      if (t.destination === 'Cash') { t.type === 'Cash In' ? cashIn += amt : cashOut += amt; }
      else { t.type === 'Cash In' ? gcashIn += amt : gcashOut += amt; }
    }
    return { cashIn, cashOut, gcashIn, gcashOut, netCash: cashIn - cashOut, netGcash: gcashIn - gcashOut };
  }, [todaysTxns]);

  const lastClosedClosing = useMemo(() => {
    const closed = closings.filter(c => c.status === 'Closed' && c.date < today).sort((a, b) => b.date.localeCompare(a.date));
    return closed[0] || null;
  }, [closings, today]);

  const todaysClosing = useMemo(() => closings.find(c => c.date === today), [closings, today]);

  // Carries the running cash/GCash balance forward from the last CLOSED day,
  // folding in every transaction dated after that close and before
  // targetDate - even on days that were never formally closed. This keeps
  // the running total accurate regardless of skipped closings; only the
  // *photo/physical-count* step gets skipped on an unclosed day, not the
  // transactions themselves.
  const carryForwardTo = (targetDate) => {
    if (!lastClosedClosing) return { cash: 0, gcash: 0 };
    let cash = lastClosedClosing.countedCash || 0;
    let gcash = lastClosedClosing.countedGCash || 0;
    for (const t of transactions) {
      if (t.voided) continue;
      const d = localDateKey(t.datetime);
      if (d > lastClosedClosing.date && d < targetDate) {
        const amt = Number(t.amount) || 0;
        const signed = t.type === 'Cash In' ? amt : -amt;
        if (t.destination === 'Cash') cash += signed;
        else gcash += signed;
      }
    }
    return { cash, gcash };
  };

  const openingCash = todaysClosing ? todaysClosing.openingCash : (lastClosedClosing ? carryForwardTo(today).cash : 0);
  const openingGCash = todaysClosing ? todaysClosing.openingGCash : (lastClosedClosing ? carryForwardTo(today).gcash : 0);
  const expectedCash = openingCash + sums.cashIn - sums.cashOut;
  const expectedGCash = openingGCash + sums.gcashIn - sums.gcashOut;

  const needsManualOpening = !todaysClosing && !lastClosedClosing;

  // Any past date with recorded activity (a transaction or a clock-in) that
  // never got a real Closed record - these need Admin/Owner follow-up.
  const missedDays = useMemo(() => {
    const activityDates = new Set();
    for (const t of transactions) activityDates.add(localDateKey(t.datetime));
    for (const a of attendance) activityDates.add(a.date);
    const closedDates = new Set(closings.filter(c => c.status === 'Closed').map(c => c.date));
    return [...activityDates].filter(d => d < today && !closedDates.has(d)).sort();
  }, [transactions, attendance, closings, today]);

  const currentMonthKey = today.slice(0, 7);
  const overLimitCategories = useMemo(() => {
    if (categoryLimits.length === 0) return [];
    const spentByCategory = {};
    for (const t of transactions) {
      if (t.voided) continue;
      if (t.type !== 'Cash Out') continue;
      if (localDateKey(t.datetime).slice(0, 7) !== currentMonthKey) continue;
      spentByCategory[t.category] = (spentByCategory[t.category] || 0) + (Number(t.amount) || 0);
    }
    return categoryLimits
      .map(l => ({ category: l.category, limit: l.monthlyLimit, spent: spentByCategory[l.category] || 0 }))
      .filter(r => r.spent >= r.limit)
      .sort((a, b) => (b.spent - b.limit) - (a.spent - a.limit));
  }, [categoryLimits, transactions, currentMonthKey]);

  const [resolvingDate, setResolvingDate] = useState(null);

  const expectedForDate = (dateStr) => {
    const existingClosing = closings.find(c => c.date === dateStr);
    let baseCash, baseGCash;
    if (existingClosing) {
      // A record already exists for this date (e.g. a manually-entered
      // first-shift opening balance saved as a Draft) - use its own opening
      // figures rather than recomputing from a prior closed day.
      baseCash = existingClosing.openingCash;
      baseGCash = existingClosing.openingGCash;
    } else {
      const carried = carryForwardTo(dateStr);
      baseCash = carried.cash;
      baseGCash = carried.gcash;
    }
    let cashIn = 0, cashOut = 0, gcashIn = 0, gcashOut = 0;
    for (const t of transactions) {
      if (t.voided) continue;
      if (localDateKey(t.datetime) !== dateStr) continue;
      const amt = Number(t.amount) || 0;
      if (t.destination === 'Cash') { t.type === 'Cash In' ? cashIn += amt : cashOut += amt; }
      else { t.type === 'Cash In' ? gcashIn += amt : gcashOut += amt; }
    }
    return {
      openingCash: baseCash, openingGCash: baseGCash,
      expectedCash: baseCash + cashIn - cashOut,
      expectedGCash: baseGCash + gcashIn - gcashOut,
    };
  };

  const [resolveError, setResolveError] = useState('');

  const resolveMissedDay = async (dateStr, useExpected, manualCash, manualGCash, note) => {
    setResolveError('');
    try {
      const { openingCash: oc, openingGCash: og, expectedCash: ec, expectedGCash: eg } = expectedForDate(dateStr);
      const countedCash = useExpected ? ec : Number(manualCash) || 0;
      const countedGCash = useExpected ? eg : Number(manualGCash) || 0;
      const finalRec = {
        date: dateStr, openingCash: oc, openingGCash: og, expectedCash: ec, expectedGCash: eg,
        countedCash, cashDifference: countedCash - ec,
        countedGCash, gcashDifference: countedGCash - eg,
        denominations: null,
        notes: note || 'No physical count was performed — closed using system-calculated totals.',
        status: 'Closed', closedBy: currentEmployee.name, closedAt: new Date().toISOString(),
      };
      const saved = await upsertClosing(finalRec);
      markOwnAction(saved.id);
      setClosings(prev => [...prev.filter(c => c.date !== dateStr), saved]);
      setResolvingDate(null);
    } catch (err) {
      console.error('Resolving missed day failed', err);
      setResolveError('Something went wrong saving this. Please try again.');
    }
  };

  const resetLogin = () => { setLoginPicked(null); setPin(''); setLoginError(''); };

  const tryPin = async (nextPin) => {
    setPin(nextPin);
    if (nextPin.length === 4) {
      if (loginPicked.pin === nextPin) {
        setCurrentEmployee(loginPicked);
        localStorage.setItem('pwc_pos_employee_id', loginPicked.id);
        resetLogin();
      } else {
        setLoginError('Incorrect PIN');
        setShake(true);
        setTimeout(() => { setShake(false); setPin(''); }, 420);
      }
    }
  };

  const doClockIn = async () => {
    try {
      const rec = await insertAttendance({
        employeeId: currentEmployee.id, employeeName: currentEmployee.name,
        role: currentEmployee.role, date: today, clockIn: new Date().toISOString(), clockOut: null,
      });
      setAttendance(prev => [...prev, rec]);
      markOwnAction(rec.id);
      if (needsManualOpening) setShowOpeningEntry(true);
    } catch (err) { console.error('Clock in failed', err); }
  };

  const doClockOut = async () => {
    try {
      const clockOutIso = new Date().toISOString();
      await clockOutAttendance(myAttendance.id, clockOutIso);
      setAttendance(prev => prev.map(a => a.id === myAttendance.id ? { ...a, clockOut: clockOutIso } : a));
      setCurrentEmployee(null);
      localStorage.removeItem('pwc_pos_employee_id');
      setShowOpeningEntry(false);
      resetLogin();
    } catch (err) { console.error('Clock out failed', err); }
  };

  const doLogout = () => {
    setCurrentEmployee(null);
    localStorage.removeItem('pwc_pos_employee_id');
    resetLogin();
  };

  const saveOpeningBalances = async (cash, gcash) => {
    try {
      const rec = await upsertClosing({ date: today, openingCash: Number(cash) || 0, openingGCash: Number(gcash) || 0, status: 'Draft' });
      setClosings(prev => [...prev.filter(c => c.date !== today), rec]);
      setShowOpeningEntry(false);
    } catch (err) { console.error('Saving opening balances failed', err); }
  };

  const addTransaction = async (form) => {
    try {
      const rec = {
        id: uid('TXN'),
        amount: Number(form.amount),
        description: form.description,
        type: form.type,
        destination: form.destination,
        category: form.category,
        datetime: form.datetime,
        notes: form.notes,
        createdBy: form.createdBy,
        createdByName: employees.find(e => e.id === form.createdBy)?.name || currentEmployee.name,
      };
      await insertTransaction(rec);
      markOwnAction(rec.id);
      setTransactions(prev => [...prev, rec]);
      setShowTxn(false);
    } catch (err) { console.error('Adding transaction failed', err); }
  };

  const [showBackfill, setShowBackfill] = useState(false);
  const [backfillError, setBackfillError] = useState('');

  const addBackfillTransaction = async (form) => {
    setBackfillError('');
    try {
      const rec = {
        id: uid('TXN'),
        amount: Number(form.amount),
        description: form.description,
        type: form.type,
        destination: form.destination,
        category: form.category,
        datetime: form.datetime,
        notes: form.reason,
        createdBy: form.createdBy,
        createdByName: employees.find(e => e.id === form.createdBy)?.name || currentEmployee.name,
        isBackfill: true,
      };
      await insertTransaction(rec);
      markOwnAction(rec.id);
      setTransactions(prev => [...prev, rec]);
      setShowBackfill(false);
    } catch (err) {
      console.error('Adding backfill transaction failed', err);
      setBackfillError('Something went wrong saving this. Please try again.');
    }
  };

  const [editingTxn, setEditingTxn] = useState(null);
  const [txnActionError, setTxnActionError] = useState('');

  const editTransactionAction = async (id, fields, reason) => {
    setTxnActionError('');
    try {
      await updateTransaction(id, fields, currentEmployee.name, reason);
      setTransactions(prev => prev.map(t => t.id === id ? {
        ...t, ...fields, editedBy: currentEmployee.name, editedAt: new Date().toISOString(), editReason: reason,
      } : t));
      setEditingTxn(null);
    } catch (err) {
      console.error('Editing transaction failed', err);
      setTxnActionError('Something went wrong saving this edit. Please try again.');
    }
  };

  const voidTransactionAction = async (id, reason) => {
    setTxnActionError('');
    try {
      await voidTransaction(id, currentEmployee.name, reason);
      setTransactions(prev => prev.map(t => t.id === id ? {
        ...t, voided: true, voidedBy: currentEmployee.name, voidedAt: new Date().toISOString(), voidReason: reason,
      } : t));
      setEditingTxn(null);
    } catch (err) {
      console.error('Voiding transaction failed', err);
      setTxnActionError('Something went wrong voiding this. Please try again.');
    }
  };

  const [showBackfillAttendance, setShowBackfillAttendance] = useState(false);
  const [backfillAttendanceError, setBackfillAttendanceError] = useState('');

  const addBackfillAttendance = async (form) => {
    setBackfillAttendanceError('');
    try {
      const employee = employees.find(e => e.id === form.employeeId);
      const rec = await insertBackfillAttendance({
        employeeId: form.employeeId,
        employeeName: employee?.name || 'Unknown',
        role: employee?.role || 'Employee',
        date: localDateKey(form.clockIn),
        clockIn: form.clockIn,
        clockOut: form.clockOut || null,
        reason: form.reason,
      });
      markOwnAction(rec.id);
      setAttendance(prev => [...prev, rec]);
      setShowBackfillAttendance(false);
    } catch (err) {
      console.error('Adding backfill attendance failed', err);
      setBackfillAttendanceError('Something went wrong saving this. Please try again.');
    }
  };

  const [editingAttendance, setEditingAttendance] = useState(null);
  const [attendanceActionError, setAttendanceActionError] = useState('');

  const editAttendanceAction = async (id, clockIn, clockOut, reason) => {
    setAttendanceActionError('');
    try {
      await updateAttendanceTimes(id, clockIn, clockOut || null, currentEmployee.name, reason);
      setAttendance(prev => prev.map(a => a.id === id ? {
        ...a, clockIn, clockOut: clockOut || null, editedBy: currentEmployee.name, editedAt: new Date().toISOString(), editReason: reason,
      } : a));
      setEditingAttendance(null);
    } catch (err) {
      console.error('Editing attendance failed', err);
      setAttendanceActionError('Something went wrong saving this edit. Please try again.');
    }
  };

  const openCloseDay = () => {
    const draft = todaysClosing || { date: today, openingCash, openingGCash, status: 'Draft' };
    setClosingDraft(draft);
    setShowCloseDay(true);
  };

  const [closeCountError, setCloseCountError] = useState('');

  const confirmCashCount = async (denomCounts, countedGCash, notes, photoFile) => {
    setCloseCountError('');
    try {
      const countedCash = DENOMINATIONS.reduce((sum, d) => sum + d * (Number(denomCounts[d]) || 0), 0);
      const photoUrl = await uploadClosingPhoto(photoFile, `closing-${today}`);
      const finalRec = {
        date: today, openingCash, openingGCash, expectedCash, expectedGCash,
        countedCash, cashDifference: countedCash - expectedCash,
        countedGCash: Number(countedGCash) || 0, gcashDifference: (Number(countedGCash) || 0) - expectedGCash,
        denominations: denomCounts, notes: notes || null, photoUrl,
        status: 'Closed', closedBy: currentEmployee.name, closedAt: new Date().toISOString(),
      };
      const saved = await upsertClosing(finalRec);
      markOwnAction(saved.id);
      setClosings(prev => [...prev.filter(c => c.date !== today), saved]);
      setShowCashCount(false);
      setShowCloseDay(false);
      setClosedReceipt(saved);
    } catch (err) {
      console.error('Confirming cash count failed', err);
      setCloseCountError('Something went wrong saving the cash count. Please try again.');
    }
  };

  const addEmployee = async (form) => {
    try {
      const rec = await insertEmployee({ name: form.name, pin: form.pin, role: form.role, active: true });
      setEmployees(prev => [...prev, rec]);
    } catch (err) { console.error('Adding employee failed', err); }
  };

  const toggleEmployeeActive = async (id) => {
    try {
      const emp = employees.find(e => e.id === id);
      const nextActive = !emp.active;
      await updateEmployeeActive(id, nextActive);
      setEmployees(prev => prev.map(e => e.id === id ? { ...e, active: nextActive } : e));
    } catch (err) { console.error('Updating employee failed', err); }
  };

  const [pinChangeError, setPinChangeError] = useState('');

  const changeMyPin = async (newPin) => {
    setPinChangeError('');
    try {
      await updateEmployeePin(currentEmployee.id, newPin);
      setEmployees(prev => prev.map(e => e.id === currentEmployee.id ? { ...e, pin: newPin } : e));
      setCurrentEmployee(prev => ({ ...prev, pin: newPin }));
      return true;
    } catch (err) {
      console.error('Changing PIN failed', err);
      setPinChangeError('Something went wrong saving your new PIN. Please try again.');
      return false;
    }
  };

  const saveCategoryLimit = async (category, monthlyLimit) => {
    try {
      await upsertCategoryLimit(category, monthlyLimit, currentEmployee.name);
      setCategoryLimits(prev => [...prev.filter(l => l.category !== category), { category, monthlyLimit, updatedBy: currentEmployee.name }]);
    } catch (err) { console.error('Saving spending limit failed', err); }
  };

  const deleteCategoryLimitAction = async (category) => {
    try {
      await deleteCategoryLimit(category);
      setCategoryLimits(prev => prev.filter(l => l.category !== category));
    } catch (err) { console.error('Removing spending limit failed', err); }
  };

  const canManage = currentEmployee && (currentEmployee.role === 'Admin' || currentEmployee.role === 'Manager' || currentEmployee.role === 'Owner');

  if (!loaded) {
    return (
      <div className="pos-root pos-loading">
        <style>{STYLES}</style>
        <div className="lcd-display">LOADING…</div>
      </div>
    );
  }

  if (!currentEmployee) {
    return (
      <div className="pos-root">
        <style>{STYLES}</style>
        <div className="login-wrap">
          <div className="login-logo-wrap">
            <img src={LOGO_FULL} alt="PWC Prints & Crafts" className="login-logo" />
            <div className="brand-sub" style={{ textAlign: 'center' }}>Cashier register</div>
          </div>

          {!loginPicked ? (
            <>
              <p className="login-prompt">Who's on the register?</p>
              <div className="employee-grid">
                {employees.filter(e => e.active !== false).map(e => (
                  <button key={e.id} className="employee-card" onClick={() => { setLoginPicked(e); setPin(''); setLoginError(''); }}>
                    <div className="avatar-circle">{initials(e.name)}</div>
                    <div className="employee-card-name">{e.name}</div>
                    <div className="employee-card-role">{e.role}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className={`pin-panel ${shake ? 'pin-shake' : ''}`}>
              <button className="back-link" onClick={resetLogin}><ChevronLeft size={16} /> Not {loginPicked.name}?</button>
              <div className="avatar-circle avatar-lg">{initials(loginPicked.name)}</div>
              <div className="pin-panel-name">{loginPicked.name}</div>
              <div className="lcd-display">
                <PinDots value={pin} />
              </div>
              {loginError && <div className="error-line"><AlertCircle size={14} /> {loginError}</div>}
              <Keypad
                onDigit={(d) => { if (pin.length < 4) tryPin(pin + d); }}
                onDelete={() => setPin(pin.slice(0, -1))}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (showOpeningEntry) {
    return (
      <div className="pos-root">
        <style>{STYLES}</style>
        <OpeningEntryPage
          employeeName={currentEmployee.name}
          onCancel={doClockOut}
          onSave={saveOpeningBalances}
        />
      </div>
    );
  }

  return (
    <div className="pos-root">
      <style>{STYLES}</style>

      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map(t => (
            <div key={t.id} className="toast-item">{t.message}</div>
          ))}
        </div>
      )}

      <div className="content-area">

      <div className="topbar">
        <div className="brand-mark">
          <img src={LOGO_ICON} alt="PWC" className="brand-badge" />
          <div>
            <div className="brand-title-sm">PWC Printing Shop POS</div>
            <div className="brand-sub-sm">{now.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })} · {now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
          </div>
        </div>
        <div className="topbar-right">
          <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}><Settings size={18} /></button>
          <div className="me-chip">
            <div className="avatar-circle avatar-sm">{initials(currentEmployee.name)}</div>
            <div>
              <div className="me-name">{currentEmployee.name}</div>
              <div className="me-role">{currentEmployee.role}</div>
            </div>
          </div>
        </div>
      </div>

      {activeView === 'home' && (
        <>
          {missedDays.length > 0 && canManage && (
            <button className="missed-day-banner" onClick={() => setResolvingDate(missedDays[0])}>
              <AlertTriangle size={16} />
              <span>
                {missedDays.length === 1
                  ? `${missedDays[0]} was never closed — tap to resolve`
                  : `${missedDays.length} days were never closed — tap to resolve`}
              </span>
            </button>
          )}

          {overLimitCategories.length > 0 && canManage && (
            <button className="missed-day-banner spending-limit-banner" onClick={() => setActiveView('reports')}>
              <AlertTriangle size={16} />
              <span>
                {overLimitCategories.length === 1
                  ? `${overLimitCategories[0].category} is over its spending limit this month`
                  : `${overLimitCategories.length} categories are over their spending limit this month`}
              </span>
            </button>
          )}

          <div className="status-row">
            <div className="status-pill">
              <span className={`dot ${isClockedIn ? 'dot-on' : 'dot-off'}`} />
              {isClockedIn ? `Clocked in since ${timeStr(myAttendance.clockIn)}` : 'Not clocked in'}
            </div>
            <div className="status-actions">
              {!isClockedIn ? (
                <button className="btn btn-primary" onClick={doClockIn}><Clock size={16} /> Clock in</button>
              ) : (
                <button className="btn btn-danger-outline" onClick={doClockOut}><LogOut size={16} /> Clock out</button>
              )}
              <button className="btn btn-purple" onClick={doLogout}><UserMinus size={16} /> Log out</button>
            </div>
          </div>

          {activeCashiers.length > 0 && (
            <div className="active-strip">
              <Users size={14} />
              <span className="active-strip-label">On the floor:</span>
              {activeCashiers.map(a => <span key={a.id} className="active-chip">{a.employeeName}</span>)}
            </div>
          )}

          <div className="summary-grid">
            <div className="summary-card summary-card-muted">
              <div className="summary-label">Today's Opening Cash</div>
              <div className="summary-value">{peso(openingCash)}</div>
            </div>
            <div className="summary-card summary-card-muted">
              <div className="summary-label">Today's Opening GCash</div>
              <div className="summary-value">{peso(openingGCash)}</div>
            </div>
          </div>

          <div className="summary-grid">
            <div className="summary-card">
              <div className="summary-label"><Banknote size={13} /> Cash</div>
              <div className="summary-value">{peso(openingCash + sums.netCash)}</div>
              <div className="summary-foot">In {peso(sums.cashIn)} · Out {peso(sums.cashOut)}</div>
            </div>
            <div className="summary-card">
              <div className="summary-label"><Smartphone size={13} /> GCash</div>
              <div className="summary-value">{peso(openingGCash + sums.netGcash)}</div>
              <div className="summary-foot">In {peso(sums.gcashIn)} · Out {peso(sums.gcashOut)}</div>
            </div>
          </div>

          {activeCashiers.length > 0 && (
            <div className="action-row">
              <button
                className="btn btn-highlight btn-block"
                onClick={() => setShowTxn(true)}
                disabled={todaysClosing?.status === 'Closed' || !isClockedIn}
                title={todaysClosing?.status === 'Closed' ? 'Day is closed' : (!isClockedIn ? 'Clock in first to record a transaction' : '')}
              >
                <Plus size={18} /> New transaction
              </button>
              {todaysClosing?.status === 'Closed' ? (
                canManage ? (
                  <button className="closed-badge closed-badge-btn btn-block" onClick={() => setClosedReceipt(todaysClosing)}>
                    <Check size={14} /> Day closed — view summary
                  </button>
                ) : (
                  <div className="closed-badge btn-block">
                    <Check size={14} /> Day closed
                  </div>
                )
              ) : (
                <button className="btn btn-green btn-block" onClick={openCloseDay} disabled={!isClockedIn} title={!isClockedIn ? 'Clock in first to close the day' : ''}>
                  <CalendarClock size={16} /> Close day
                </button>
              )}
            </div>
          )}
          {activeCashiers.length === 0 && <div className="hint-line">Clock in to start recording transactions and closing the day.</div>}
          {activeCashiers.length > 0 && !isClockedIn && <div className="hint-line">Clock in to record transactions or close the day yourself.</div>}

          <div className="receipt-panel">
            <div className="receipt-tear" />
            <div className="receipt-header">
              <Receipt size={14} /> Today's transactions <span className="receipt-count">{todaysTxns.length}</span>
            </div>
            {todaysTxns.length === 0 ? (
              <div className="empty-state">No transactions yet today.</div>
            ) : (
              <div className="receipt-list">
                {todaysTxns.slice(0, 5).map(t => (
                  <div key={t.id} className="receipt-row">
                    <div className="receipt-row-top">
                      <span className="receipt-cat">{t.category}</span>
                      <span className={`receipt-amt ${t.type === 'Cash In' ? 'amt-in' : 'amt-out'}`}>
                        {t.type === 'Cash In' ? '+' : '−'}{peso(t.amount)}
                      </span>
                    </div>
                    <div className="receipt-row-bottom">
                      <span>{t.description || '—'}</span>
                      <span>{t.destination} · {timeStr(t.datetime)} · {t.createdByName}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {todaysTxns.length > 5 && (
              <button className="view-more-link" onClick={() => setActiveView('transactions')}>
                View more <ChevronRight size={14} />
              </button>
            )}
            <div className="receipt-tear receipt-tear-bottom" />
          </div>
        </>
      )}

      {activeView === 'transactions' && (
        <TransactionsView transactions={transactions} />
      )}

      {activeView === 'reports' && canManage && (
        <ReportsView
          transactions={transactions} attendance={attendance} closings={closings} categoryLimits={categoryLimits}
          canManage={canManage}
          onEditTxn={setEditingTxn}
          onAddBackfill={() => setShowBackfill(true)}
          onAddBackfillAttendance={() => setShowBackfillAttendance(true)}
          onEditAttendance={setEditingAttendance}
        />
      )}

      {activeView === 'analytics' && canManage && (
        <AnalyticsView employees={employees} attendance={attendance} transactions={transactions} closings={closings} />
      )}

      </div>

      <div className="bottom-nav">
        <button className={`nav-btn ${activeView === 'home' ? 'nav-btn-active' : ''}`} onClick={() => setActiveView('home')}>
          <Home size={19} /><span>Home</span>
        </button>
        <button className={`nav-btn ${activeView === 'transactions' ? 'nav-btn-active' : ''}`} onClick={() => setActiveView('transactions')}>
          <ListOrdered size={19} /><span>Transactions</span>
        </button>
        {canManage && (
          <button className={`nav-btn ${activeView === 'reports' ? 'nav-btn-active' : ''}`} onClick={() => setActiveView('reports')}>
            <FileBarChart2 size={19} /><span>Reports</span>
          </button>
        )}
        {canManage && (
          <button className={`nav-btn ${activeView === 'analytics' ? 'nav-btn-active' : ''}`} onClick={() => setActiveView('analytics')}>
            <PieChart size={19} /><span>Analytics</span>
          </button>
        )}
      </div>

      {showTxn && (
        <TxnModal
          onClose={() => setShowTxn(false)}
          onSave={addTransaction}
          activeCashiers={activeCashiers}
          defaultCreatedBy={currentEmployee.id}
        />
      )}
      {showSettings && (
        <SettingsModal
          employees={employees}
          currentEmployee={currentEmployee}
          categoryLimits={categoryLimits}
          canManage={canManage}
          pinChangeError={pinChangeError}
          onClose={() => { setShowSettings(false); setPinChangeError(''); }}
          onAdd={addEmployee}
          onToggle={toggleEmployeeActive}
          onSaveLimit={saveCategoryLimit}
          onDeleteLimit={deleteCategoryLimitAction}
          onChangeMyPin={changeMyPin}
        />
      )}
      {showCloseDay && closingDraft && (
        <CloseDayModal
          draft={closingDraft}
          expectedCash={expectedCash}
          expectedGCash={expectedGCash}
          sums={sums}
          onClose={() => setShowCloseDay(false)}
          onProceed={() => setShowCashCount(true)}
        />
      )}
      {showCashCount && (
        <CashCountModal
          expectedCash={expectedCash}
          expectedGCash={expectedGCash}
          externalError={closeCountError}
          onClose={() => { setShowCashCount(false); setCloseCountError(''); }}
          onConfirm={confirmCashCount}
        />
      )}
      {closedReceipt && (
        <ClosedReceiptModal record={closedReceipt} onClose={() => setClosedReceipt(null)} />
      )}
      {resolvingDate && (
        <ResolveMissedDayModal
          date={resolvingDate}
          expected={expectedForDate(resolvingDate)}
          externalError={resolveError}
          onClose={() => { setResolvingDate(null); setResolveError(''); }}
          onResolve={resolveMissedDay}
        />
      )}
      {showBackfill && (
        <BackfillEntryModal
          employees={employees}
          defaultCreatedBy={currentEmployee.id}
          externalError={backfillError}
          onClose={() => { setShowBackfill(false); setBackfillError(''); }}
          onSave={addBackfillTransaction}
        />
      )}
      {editingTxn && (
        <TxnEditModal
          transaction={editingTxn}
          externalError={txnActionError}
          onClose={() => { setEditingTxn(null); setTxnActionError(''); }}
          onSaveEdit={editTransactionAction}
          onVoid={voidTransactionAction}
        />
      )}
      {showBackfillAttendance && (
        <BackfillAttendanceModal
          employees={employees}
          externalError={backfillAttendanceError}
          onClose={() => { setShowBackfillAttendance(false); setBackfillAttendanceError(''); }}
          onSave={addBackfillAttendance}
        />
      )}
      {editingAttendance && (
        <AttendanceEditModal
          record={editingAttendance}
          externalError={attendanceActionError}
          onClose={() => { setEditingAttendance(null); setAttendanceActionError(''); }}
          onSave={editAttendanceAction}
        />
      )}
    </div>
  );
}

function groupByDate(items, dateKeyFn) {
  const groups = {};
  for (const item of items) {
    const key = dateKeyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
}

function dateHeading(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function TransactionsView({ transactions }) {
  const today = todayStr();
  const todays = useMemo(
    () => transactions.filter(t => !t.voided && localDateKey(t.datetime) === today).sort((a, b) => b.datetime.localeCompare(a.datetime)),
    [transactions, today]
  );

  return (
    <div className="view-panel">
      <div className="view-panel-header">
        <div className="view-panel-title">Transactions</div>
      </div>
      <div className="date-group-heading">{dateHeading(today)}</div>
      {todays.length === 0 ? (
        <div className="empty-state">No transactions yet today.</div>
      ) : (
        <div className="receipt-panel receipt-panel-flat">
          <div className="receipt-list">
            {todays.map(t => (
              <div key={t.id} className="receipt-row">
                <div className="receipt-row-top">
                  <span className="receipt-cat">{t.category}</span>
                  <span className={`receipt-amt ${t.type === 'Cash In' ? 'amt-in' : 'amt-out'}`}>
                    {t.type === 'Cash In' ? '+' : '−'}{peso(t.amount)}
                  </span>
                </div>
                <div className="receipt-row-bottom">
                  <span>{t.description || '—'}</span>
                  <span>{t.destination} · {timeStr(t.datetime)} · {t.createdByName}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportsView({ transactions, attendance, closings, categoryLimits, canManage, onEditTxn, onAddBackfill, onAddBackfillAttendance, onEditAttendance }) {
  const txns = useMemo(() => [...transactions].sort((a, b) => b.datetime.localeCompare(a.datetime)), [transactions]);
  const att = useMemo(() => [...attendance].sort((a, b) => (b.clockIn || '').localeCompare(a.clockIn || '')), [attendance]);
  const cls = useMemo(() => [...closings].sort((a, b) => b.date.localeCompare(a.date)), [closings]);

  const discrepancies = useMemo(() => cls.filter(c =>
    c.status === 'Closed' && (
      Math.abs(c.cashDifference || 0) >= DISCREPANCY_THRESHOLD ||
      Math.abs(c.gcashDifference || 0) >= DISCREPANCY_THRESHOLD
    )
  ), [cls]);

  const currentMonthKey = todayStr().slice(0, 7);
  const overLimitCategories = useMemo(() => {
    if (!categoryLimits || categoryLimits.length === 0) return [];
    const spentByCategory = {};
    for (const t of txns) {
      if (t.type !== 'Cash Out') continue;
      if (localDateKey(t.datetime).slice(0, 7) !== currentMonthKey) continue;
      spentByCategory[t.category] = (spentByCategory[t.category] || 0) + (Number(t.amount) || 0);
    }
    return categoryLimits
      .map(l => ({ category: l.category, limit: l.monthlyLimit, spent: spentByCategory[l.category] || 0 }))
      .filter(r => r.spent >= r.limit)
      .sort((a, b) => (b.spent - b.limit) - (a.spent - a.limit));
  }, [categoryLimits, txns, currentMonthKey]);

  const [searchText, setSearchText] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [filterCategory, setFilterCategory] = useState('All');
  const [filterType, setFilterType] = useState('All');
  const [filterDestination, setFilterDestination] = useState('All');
  const [expandedDates, setExpandedDates] = useState(() => new Set());

  const hasActiveFilter = filterCategory !== 'All' || filterType !== 'All' || filterDestination !== 'All';
  const searchActive = searchText.trim().length > 0;

  const filteredTxns = useMemo(() => {
    let list = txns;
    if (filterCategory !== 'All') list = list.filter(t => t.category === filterCategory);
    if (filterType !== 'All') list = list.filter(t => t.type === filterType);
    if (filterDestination !== 'All') list = list.filter(t => t.destination === filterDestination);
    if (searchActive) {
      const q = searchText.trim().toLowerCase();
      list = list.filter(t =>
        (t.description || '').toLowerCase().includes(q) ||
        (t.category || '').toLowerCase().includes(q) ||
        (t.createdByName || '').toLowerCase().includes(q) ||
        (t.id || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [txns, filterCategory, filterType, filterDestination, searchText]);

  const daySummaries = useMemo(() => {
    const groups = groupByDate(filteredTxns, t => localDateKey(t.datetime));
    return groups.map(([date, dayTxns]) => {
      let totalIn = 0, totalOut = 0;
      const employeeSet = new Set();
      for (const t of dayTxns) {
        employeeSet.add(t.createdByName);
        if (t.voided) continue;
        const amt = Number(t.amount) || 0;
        if (t.type === 'Cash In') totalIn += amt; else totalOut += amt;
      }
      const sortedTimes = [...dayTxns].sort((a, b) => a.datetime.localeCompare(b.datetime));
      return {
        date, txns: dayTxns, totalIn, totalOut,
        employees: [...employeeSet],
        startTime: timeStr(sortedTimes[0].datetime),
        endTime: timeStr(sortedTimes[sortedTimes.length - 1].datetime),
      };
    });
  }, [filteredTxns]);

  const showExpanded = searchActive || hasActiveFilter;

  const toggleExpand = (date) => {
    setExpandedDates(prev => {
      const next = new Set(prev);
      next.has(date) ? next.delete(date) : next.add(date);
      return next;
    });
  };

  const resetFilters = () => { setFilterCategory('All'); setFilterType('All'); setFilterDestination('All'); };

  return (
    <div className="view-panel">
      <div className="view-panel-title">Reports</div>

      {discrepancies.length > 0 && (
        <div className="receipt-panel receipt-panel-alert" style={{ marginTop: 14 }}>
          <div className="receipt-tear receipt-tear-alert" />
          <div className="receipt-header">
            <AlertTriangle size={14} /> Cash discrepancies <span className="receipt-count">{discrepancies.length}</span>
          </div>
          <div className="receipt-list">
            {discrepancies.map(c => (
              <div key={c.id} className="receipt-row">
                <div className="receipt-row-top">
                  <span className="receipt-cat">{c.date}</span>
                  <span className="receipt-amt">Closed by {c.closedBy}</span>
                </div>
                <div className="receipt-row-bottom">
                  {Math.abs(c.cashDifference || 0) >= DISCREPANCY_THRESHOLD && (
                    <span>Cash {c.cashDifference >= 0 ? 'over' : 'short'} by {peso(Math.abs(c.cashDifference))}</span>
                  )}
                  {Math.abs(c.gcashDifference || 0) >= DISCREPANCY_THRESHOLD && (
                    <span>GCash {c.gcashDifference >= 0 ? 'over' : 'short'} by {peso(Math.abs(c.gcashDifference))}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="receipt-tear receipt-tear-bottom receipt-tear-alert" />
        </div>
      )}

      {overLimitCategories.length > 0 && (
        <div className="receipt-panel receipt-panel-limit" style={{ marginTop: 14 }}>
          <div className="receipt-tear receipt-tear-limit" />
          <div className="receipt-header">
            <AlertTriangle size={14} /> Spending limit alerts <span className="receipt-count">{overLimitCategories.length}</span>
          </div>
          <div className="receipt-list">
            {overLimitCategories.map(r => (
              <div key={r.category} className="receipt-row">
                <div className="receipt-row-top">
                  <span className="receipt-cat">{r.category}</span>
                  <span className="receipt-amt">{peso(r.spent)} / {peso(r.limit)}</span>
                </div>
                <div className="receipt-row-bottom">
                  <span>Over by {peso(r.spent - r.limit)} this month</span>
                </div>
              </div>
            ))}
          </div>
          <div className="receipt-tear receipt-tear-bottom receipt-tear-limit" />
        </div>
      )}

      <div className="receipt-panel" style={{ marginTop: 14 }}>
        <div className="receipt-tear" />
        <div className="receipt-header">
          <Receipt size={14} /> All transactions <span className="receipt-count">{filteredTxns.length}</span>
        </div>

        {canManage && (
          <button className="btn btn-purple btn-block" style={{ marginBottom: 10 }} onClick={onAddBackfill}>
            <Plus size={14} /> Add backdated entry
          </button>
        )}

        <div className="search-filter-row">
          <div className="search-input-wrap">
            <Search size={14} className="search-input-icon" />
            <input
              className="field-input search-input"
              placeholder="Search description, category, employee…"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
            />
          </div>
          <button className={`btn btn-outline filter-btn ${hasActiveFilter ? 'filter-btn-active' : ''}`} onClick={() => setShowFilter(true)}>
            <SlidersHorizontal size={14} /> Filter
          </button>
        </div>

        {daySummaries.length === 0 ? (
          <div className="empty-state">No transactions found.</div>
        ) : showExpanded ? (
          daySummaries.map(day => (
            <div key={day.date} className="date-group">
              <div className="date-group-heading">{dateHeading(day.date)}</div>
              <div className="receipt-list">
                {day.txns.map(t => (
                  <div
                    key={t.id}
                    className={`receipt-row ${canManage ? 'receipt-row-editable' : ''} ${t.voided ? 'receipt-row-voided' : ''}`}
                    onClick={canManage ? () => onEditTxn(t) : undefined}
                  >
                    <div className="receipt-row-top">
                      <span className="receipt-cat">
                        {t.category}
                        {t.voided && <span className="row-badge row-badge-voided">VOIDED</span>}
                        {t.isBackfill && <span className="row-badge row-badge-backfill">BACKDATED</span>}
                        {!t.voided && t.editedBy && <span className="row-badge row-badge-edited">EDITED</span>}
                      </span>
                      <span className={`receipt-amt ${t.type === 'Cash In' ? 'amt-in' : 'amt-out'}`}>
                        {t.type === 'Cash In' ? '+' : '−'}{peso(t.amount)}
                      </span>
                    </div>
                    <div className="receipt-row-bottom">
                      <span>{t.description || '—'} · {t.id}</span>
                      <span>{t.destination} · {dateTimeStr(t.datetime)} · {t.createdByName}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="day-summary-list">
            {daySummaries.map(day => {
              const isOpen = expandedDates.has(day.date);
              return (
                <div key={day.date} className="day-summary-block">
                  <button className="day-summary-row" onClick={() => toggleExpand(day.date)}>
                    <div className="day-summary-top">
                      <span className="day-summary-date">{dateHeading(day.date)}</span>
                      <ChevronRight size={16} className={`day-chevron ${isOpen ? 'day-chevron-open' : ''}`} />
                    </div>
                    <div className="day-summary-bottom">
                      <span>In {peso(day.totalIn)} · Out {peso(day.totalOut)}</span>
                      <span>{day.txns.length} Transactions</span>
                    </div>
                    <div className="day-summary-meta">{day.employees.join(' • ')} ({day.startTime} – {day.endTime})</div>
                  </button>
                  {isOpen && (
                    <div className="receipt-list day-summary-expanded">
                      {day.txns.map(t => (
                        <div
                          key={t.id}
                          className={`receipt-row ${canManage ? 'receipt-row-editable' : ''} ${t.voided ? 'receipt-row-voided' : ''}`}
                          onClick={canManage ? () => onEditTxn(t) : undefined}
                        >
                          <div className="receipt-row-top">
                            <span className="receipt-cat">
                              {t.category}
                              {t.voided && <span className="row-badge row-badge-voided">VOIDED</span>}
                              {t.isBackfill && <span className="row-badge row-badge-backfill">BACKDATED</span>}
                              {!t.voided && t.editedBy && <span className="row-badge row-badge-edited">EDITED</span>}
                            </span>
                            <span className={`receipt-amt ${t.type === 'Cash In' ? 'amt-in' : 'amt-out'}`}>
                              {t.type === 'Cash In' ? '+' : '−'}{peso(t.amount)}
                            </span>
                          </div>
                          <div className="receipt-row-bottom">
                            <span>{t.description || '—'} · {t.id}</span>
                            <span>{t.destination} · {timeStr(t.datetime)} · {t.createdByName}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="receipt-tear receipt-tear-bottom" />
      </div>

      {showFilter && (
        <TransactionFilterModal
          category={filterCategory} type={filterType} destination={filterDestination}
          onChangeCategory={setFilterCategory} onChangeType={setFilterType} onChangeDestination={setFilterDestination}
          onReset={resetFilters}
          onClose={() => setShowFilter(false)}
        />
      )}

      <div className="receipt-panel" style={{ marginTop: 14 }}>
        <div className="receipt-tear" />
        <div className="receipt-header">
          <Users size={14} /> Employee clock in & out <span className="receipt-count">{att.length}</span>
        </div>
        {canManage && (
          <button className="btn btn-purple btn-block" style={{ marginBottom: 10 }} onClick={onAddBackfillAttendance}>
            <Plus size={14} /> Add backdated attendance
          </button>
        )}
        {att.length === 0 ? (
          <div className="empty-state">No clock in/out records yet.</div>
        ) : (
          <div className="receipt-list">
            {att.map(a => (
              <div
                key={a.id}
                className={`receipt-row ${canManage ? 'receipt-row-editable' : ''}`}
                onClick={canManage ? () => onEditAttendance(a) : undefined}
              >
                <div className="receipt-row-top">
                  <span className="receipt-cat">
                    {a.employeeName}
                    {a.isBackfill && <span className="row-badge row-badge-backfill">BACKDATED</span>}
                    {a.editedBy && <span className="row-badge row-badge-edited">EDITED</span>}
                  </span>
                  <span className="report-row-date">{a.date}</span>
                </div>
                <div className="receipt-row-bottom">
                  <span>In {timeStr(a.clockIn)}</span>
                  <span>{a.clockOut ? `Out ${timeStr(a.clockOut)}` : 'Still clocked in'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="receipt-tear receipt-tear-bottom" />
      </div>

      <div className="receipt-panel" style={{ marginTop: 14 }}>
        <div className="receipt-tear" />
        <div className="receipt-header">
          <CalendarClock size={14} /> Daily closing records <span className="receipt-count">{cls.length}</span>
        </div>
        {cls.length === 0 ? (
          <div className="empty-state">No daily closings recorded yet.</div>
        ) : (
          <div className="receipt-list">
            {cls.map(c => (
              <div key={c.id} className="receipt-row">
                <div className="receipt-row-top">
                  <span className="receipt-cat">{c.date}</span>
                  <span className="report-row-date">{c.status}</span>
                </div>
                {c.status === 'Closed' ? (
                  <>
                    <div className="receipt-row-bottom">
                      <span>Counted {peso(c.countedCash)} · Diff {c.cashDifference >= 0 ? '+' : '−'}{peso(Math.abs(c.cashDifference))}</span>
                      <span>Closed by {c.closedBy}</span>
                    </div>
                    {c.notes && <div className="closing-note-inline">{c.notes}</div>}
                    {c.photoUrl && <a href={c.photoUrl} target="_blank" rel="noreferrer" className="photo-link">View drawer photo</a>}
                  </>
                ) : (
                  <div className="receipt-row-bottom"><span>Opening {peso(c.openingCash)} · not yet closed</span></div>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="receipt-tear receipt-tear-bottom" />
      </div>
    </div>
  );
}

function TransactionFilterModal({ category, type, destination, onChangeCategory, onChangeType, onChangeDestination, onReset, onClose }) {
  return (
    <Modal title="Filter transactions" onClose={onClose}>
      <label className="field-label" style={{ marginTop: 0 }}>Category</label>
      <select className="field-input" value={category} onChange={e => onChangeCategory(e.target.value)}>
        <option value="All">All categories</option>
        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <label className="field-label">Type</label>
      <div className="toggle-row">
        {['All', 'Cash In', 'Cash Out'].map(v => (
          <button
            key={v}
            className={`toggle-btn ${type === v ? (v === 'Cash Out' ? 'toggle-on-red' : v === 'Cash In' ? 'toggle-on-green' : 'toggle-on-blue') : ''}`}
            onClick={() => onChangeType(v)}
          >
            {v}
          </button>
        ))}
      </div>

      <label className="field-label">Destination</label>
      <div className="toggle-row">
        {['All', 'Cash', 'GCash'].map(v => (
          <button key={v} className={`toggle-btn ${destination === v ? 'toggle-on-blue' : ''}`} onClick={() => onChangeDestination(v)}>{v}</button>
        ))}
      </div>

      <div className="filter-modal-actions">
        <button className="btn btn-outline btn-block" onClick={onReset}>Reset filters</button>
        <button className="btn btn-highlight btn-block" onClick={onClose}><Check size={16} /> Apply</button>
      </div>
    </Modal>
  );
}

function AnalyticsView({ employees, attendance, transactions, closings }) {
  const [expandedEmployees, setExpandedEmployees] = useState(() => new Set());
  const toggleEmployeeHours = (name) => {
    setExpandedEmployees(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const hoursByEmployee = useMemo(() => {
    const byEmployee = {};
    for (const a of attendance) {
      if (!a.clockOut) continue;
      const ms = new Date(a.clockOut) - new Date(a.clockIn);
      if (!(ms > 0)) continue;
      if (!byEmployee[a.employeeName]) byEmployee[a.employeeName] = { totalMs: 0, byDay: {} };
      byEmployee[a.employeeName].totalMs += ms;
      byEmployee[a.employeeName].byDay[a.date] = (byEmployee[a.employeeName].byDay[a.date] || 0) + ms;
    }
    return Object.entries(byEmployee)
      .map(([name, { totalMs, byDay }]) => ({
        name,
        totalHours: totalMs / 3600000,
        days: Object.entries(byDay)
          .map(([date, ms]) => ({ date, hours: ms / 3600000 }))
          .sort((a, b) => b.date.localeCompare(a.date)),
      }))
      .sort((a, b) => b.totalHours - a.totalHours);
  }, [attendance]);

  const today = todayStr();
  const thisMonday = mondayOf(today);
  const lastWeekStart = addDaysToKey(thisMonday, -7);
  const lastWeekEnd = addDaysToKey(thisMonday, -1);
  const weeklyDigest = useMemo(
    () => computeDigestStats(transactions, closings, dk => dk >= lastWeekStart && dk <= lastWeekEnd),
    [transactions, closings, lastWeekStart, lastWeekEnd]
  );

  const [thisYear, thisMonthNum] = today.split('-').map(Number);
  const lastMonthDate = new Date(thisYear, thisMonthNum - 2, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthLabel = lastMonthDate.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
  const monthlyDigest = useMemo(
    () => computeDigestStats(transactions, closings, dk => dk.slice(0, 7) === lastMonthKey),
    [transactions, closings, lastMonthKey]
  );

  const categoryTotals = useMemo(() => {
    const totals = {};
    for (const t of transactions) {
      if (t.voided) continue;
      const signed = (t.type === 'Cash In' ? 1 : -1) * (Number(t.amount) || 0);
      totals[t.category] = (totals[t.category] || 0) + signed;
    }
    const rows = Object.entries(totals).map(([category, net]) => ({ category, net }));
    rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    return rows;
  }, [transactions]);

  const maxAbs = Math.max(1, ...categoryTotals.map(r => Math.abs(r.net)));

  const formatHours = (h) => {
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${hh}h ${mm}m`;
  };

  const exportTransactions = () => {
    const csv = toCSV(transactions, [
      { label: 'ID', value: t => t.id },
      { label: 'Date/Time', value: t => dateTimeStr(t.datetime) },
      { label: 'Type', value: t => t.type },
      { label: 'Destination', value: t => t.destination },
      { label: 'Category', value: t => t.category },
      { label: 'Amount', value: t => t.amount },
      { label: 'Description', value: t => t.description },
      { label: 'Notes', value: t => t.notes },
      { label: 'Created By', value: t => t.createdByName },
      { label: 'Status', value: t => t.voided ? `Voided by ${t.voidedBy}: ${t.voidReason}` : (t.editedBy ? `Edited by ${t.editedBy}: ${t.editReason}` : 'Active') },
      { label: 'Backfilled', value: t => t.isBackfill ? 'Yes' : '' },
    ]);
    downloadCSV(`transactions-${todayStr()}.csv`, csv);
  };

  const exportAttendance = () => {
    const csv = toCSV(attendance, [
      { label: 'Employee', value: a => a.employeeName },
      { label: 'Role', value: a => a.role },
      { label: 'Date', value: a => a.date },
      { label: 'Clock In', value: a => dateTimeStr(a.clockIn) },
      { label: 'Clock Out', value: a => a.clockOut ? dateTimeStr(a.clockOut) : 'Still clocked in' },
    ]);
    downloadCSV(`attendance-${todayStr()}.csv`, csv);
  };

  const exportClosings = () => {
    const csv = toCSV(closings, [
      { label: 'Date', value: c => c.date },
      { label: 'Status', value: c => c.status },
      { label: 'Opening Cash', value: c => c.openingCash },
      { label: 'Opening GCash', value: c => c.openingGCash },
      { label: 'Expected Cash', value: c => c.expectedCash },
      { label: 'Counted Cash', value: c => c.countedCash },
      { label: 'Cash Difference', value: c => c.cashDifference },
      { label: 'Expected GCash', value: c => c.expectedGCash },
      { label: 'Counted GCash', value: c => c.countedGCash },
      { label: 'GCash Difference', value: c => c.gcashDifference },
      { label: 'Closed By', value: c => c.closedBy },
    ]);
    downloadCSV(`daily-closings-${todayStr()}.csv`, csv);
  };

  return (
    <div className="view-panel">
      <div className="view-panel-title">Analytics</div>

      <div className="receipt-panel" style={{ marginTop: 14 }}>
        <div className="receipt-tear" />
        <div className="receipt-header"><TimerReset size={14} /> Hours worked</div>
        {hoursByEmployee.length === 0 ? (
          <div className="empty-state">No completed shifts yet.</div>
        ) : (
          <div className="day-summary-list" style={{ marginTop: 4 }}>
            {hoursByEmployee.map(row => {
              const isOpen = expandedEmployees.has(row.name);
              return (
                <div key={row.name} className="day-summary-block">
                  <button className="day-summary-row" onClick={() => toggleEmployeeHours(row.name)}>
                    <div className="day-summary-top">
                      <span className="day-summary-date">{row.name}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="hours-row-value">{formatHours(row.totalHours)}</span>
                        <ChevronRight size={16} className={`day-chevron ${isOpen ? 'day-chevron-open' : ''}`} />
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="day-summary-expanded">
                      {row.days.map(d => (
                        <div key={d.date} className="hours-row">
                          <span className="hours-row-name">{d.date}</span>
                          <span className="hours-row-value">{formatHours(d.hours)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="receipt-tear receipt-tear-bottom" />
      </div>

      <div className="receipt-panel" style={{ marginTop: 14 }}>
        <div className="receipt-tear" />
        <div className="receipt-header"><CalendarClock size={14} /> Weekly digest</div>
        <div className="digest-range">{lastWeekStart} – {lastWeekEnd}</div>
        {weeklyDigest.count === 0 ? (
          <div className="empty-state">No transactions recorded that week.</div>
        ) : (
          <div className="close-summary" style={{ marginTop: 8 }}>
            <div className="close-row"><span>Cash in</span><span className="mono-val amt-in">+{peso(weeklyDigest.cashIn)}</span></div>
            <div className="close-row"><span>Cash out</span><span className="mono-val amt-out">−{peso(weeklyDigest.cashOut)}</span></div>
            <div className="close-row close-row-total"><span>Net</span><span className="mono-val">{peso(weeklyDigest.net)}</span></div>
            <div className="close-row"><span>Transactions</span><span className="mono-val">{weeklyDigest.count}</span></div>
            <div className="close-row"><span>Discrepancy days</span><span className="mono-val">{weeklyDigest.discrepancyDays}</span></div>
          </div>
        )}
        {weeklyDigest.topCategories.length > 0 && (
          <div className="digest-top-categories">
            <div className="digest-top-label">Top categories</div>
            {weeklyDigest.topCategories.map(c => (
              <div key={c.category} className="digest-top-row">
                <span>{c.category}</span>
                <span className={c.net >= 0 ? 'amt-in' : 'amt-out'}>{c.net >= 0 ? '+' : '−'}{peso(Math.abs(c.net))}</span>
              </div>
            ))}
          </div>
        )}
        <div className="receipt-tear receipt-tear-bottom" />
      </div>

      <div className="receipt-panel" style={{ marginTop: 14 }}>
        <div className="receipt-tear" />
        <div className="receipt-header"><CalendarClock size={14} /> Monthly digest</div>
        <div className="digest-range">{lastMonthLabel}</div>
        {monthlyDigest.count === 0 ? (
          <div className="empty-state">No transactions recorded that month.</div>
        ) : (
          <div className="close-summary" style={{ marginTop: 8 }}>
            <div className="close-row"><span>Cash in</span><span className="mono-val amt-in">+{peso(monthlyDigest.cashIn)}</span></div>
            <div className="close-row"><span>Cash out</span><span className="mono-val amt-out">−{peso(monthlyDigest.cashOut)}</span></div>
            <div className="close-row close-row-total"><span>Net</span><span className="mono-val">{peso(monthlyDigest.net)}</span></div>
            <div className="close-row"><span>Transactions</span><span className="mono-val">{monthlyDigest.count}</span></div>
            <div className="close-row"><span>Discrepancy days</span><span className="mono-val">{monthlyDigest.discrepancyDays}</span></div>
          </div>
        )}
        {monthlyDigest.topCategories.length > 0 && (
          <div className="digest-top-categories">
            <div className="digest-top-label">Top categories</div>
            {monthlyDigest.topCategories.map(c => (
              <div key={c.category} className="digest-top-row">
                <span>{c.category}</span>
                <span className={c.net >= 0 ? 'amt-in' : 'amt-out'}>{c.net >= 0 ? '+' : '−'}{peso(Math.abs(c.net))}</span>
              </div>
            ))}
          </div>
        )}
        <div className="receipt-tear receipt-tear-bottom" />
      </div>

      <div className="receipt-panel" style={{ marginTop: 14 }}>
        <div className="receipt-tear" />
        <div className="receipt-header"><PieChart size={14} /> Category breakdown</div>
        {categoryTotals.length === 0 ? (
          <div className="empty-state">No transactions recorded yet.</div>
        ) : (
          <div className="cat-list">
            {categoryTotals.map(row => (
              <div key={row.category} className="cat-row">
                <div className="cat-row-top">
                  <span>{row.category}</span>
                  <span className={row.net >= 0 ? 'amt-in' : 'amt-out'}>
                    {row.net >= 0 ? '+' : '−'}{peso(Math.abs(row.net))}
                  </span>
                </div>
                <div className="cat-bar-track">
                  <div
                    className="cat-bar-fill"
                    style={{
                      width: `${(Math.abs(row.net) / maxAbs) * 100}%`,
                      background: row.net >= 0 ? 'var(--success)' : 'var(--danger)',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="receipt-tear receipt-tear-bottom" />
      </div>

      <div className="receipt-panel" style={{ marginTop: 14 }}>
        <div className="receipt-tear" />
        <div className="receipt-header"><Download size={14} /> Export data</div>
        <div className="export-btn-list">
          <button className="btn btn-outline btn-block" onClick={exportTransactions}><Download size={14} /> Transactions CSV</button>
          <button className="btn btn-outline btn-block" onClick={exportAttendance}><Download size={14} /> Attendance CSV</button>
          <button className="btn btn-outline btn-block" onClick={exportClosings}><Download size={14} /> Daily closings CSV</button>
        </div>
        <div className="receipt-tear receipt-tear-bottom" />
      </div>
    </div>
  );
}

function OpeningEntryPage({ employeeName, onCancel, onSave }) {
  const [cash, setCash] = useState('');
  const [gcash, setGcash] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    if (cash === '' || Number(cash) < 0) { setError('Enter today\u2019s opening cash amount.'); return; }
    if (gcash === '' || Number(gcash) < 0) { setError('Enter today\u2019s opening GCash amount.'); return; }
    onSave(cash, gcash);
  };

  return (
    <div className="opening-page">
      <div className="brand-mark" style={{ justifyContent: 'center', marginBottom: 18 }}>
        <img src={LOGO_ICON} alt="PWC" className="brand-badge" />
        <div>
          <div className="brand-title">PWC Printing Shop POS</div>
          <div className="brand-sub">First shift setup</div>
        </div>
      </div>
      <p className="opening-page-intro">
        Hi {employeeName} — this is the very first recorded shift, so there's no previous day to carry balances from.
        Enter today's starting amounts from the shop notebook.
      </p>

      <label className="field-label">Opening cash</label>
      <input className="field-input mono-input" type="number" min="0" step="0.01" placeholder="0.00" value={cash} onChange={e => setCash(e.target.value)} />

      <label className="field-label">Opening GCash</label>
      <input className="field-input mono-input" type="number" min="0" step="0.01" placeholder="0.00" value={gcash} onChange={e => setGcash(e.target.value)} />

      {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}

      <button className="btn btn-highlight btn-block" style={{ marginTop: 14 }} onClick={submit}><Check size={16} /> Save and start shift</button>
      <button className="back-link" style={{ margin: '14px auto 0', display: 'flex' }} onClick={onCancel}><ChevronLeft size={16} /> Cancel and clock out</button>
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-card ${wide ? 'modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function TxnModal({ onClose, onSave, activeCashiers, defaultCreatedBy }) {
  const [type, setType] = useState('Cash In');
  const [destination, setDestination] = useState('Cash');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [notes, setNotes] = useState('');
  const [createdBy, setCreatedBy] = useState(defaultCreatedBy);
  const [datetime] = useState(() => new Date());
  const [error, setError] = useState('');

  const submit = () => {
    if (!amount || Number(amount) <= 0) { setError('Enter a valid amount.'); return; }
    if (!description.trim()) { setError('Add a short description.'); return; }
    onSave({ type, destination, amount, description, category, notes, createdBy, datetime: datetime.toISOString() });
  };

  return (
    <Modal title="New transaction" onClose={onClose}>
      <div className="toggle-row">
        {['Cash In', 'Cash Out'].map(v => (
          <button key={v} className={`toggle-btn ${type === v ? (v === 'Cash In' ? 'toggle-on-green' : 'toggle-on-red') : ''}`} onClick={() => setType(v)}>{v}</button>
        ))}
      </div>
      <div className="toggle-row">
        {['Cash', 'GCash'].map(v => (
          <button key={v} className={`toggle-btn ${destination === v ? 'toggle-on-blue' : ''}`} onClick={() => setDestination(v)}>{v}</button>
        ))}
      </div>

      <label className="field-label">Amount</label>
      <input className="field-input mono-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />

      <label className="field-label">Description</label>
      <input className="field-input" placeholder="e.g. 20 pages B&W printing" value={description} onChange={e => setDescription(e.target.value)} />

      <label className="field-label">Category</label>
      <select className="field-input" value={category} onChange={e => setCategory(e.target.value)}>
        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <label className="field-label">Date & time</label>
      <div className="field-input field-static mono-input">{dateTimeStr(datetime.toISOString())}</div>

      <label className="field-label">Created by</label>
      <select className="field-input" value={createdBy} onChange={e => setCreatedBy(e.target.value)}>
        {activeCashiers.map(a => <option key={a.employeeId} value={a.employeeId}>{a.employeeName}</option>)}
      </select>

      <label className="field-label">Notes (optional)</label>
      <textarea className="field-input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />

      {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}
      <button className="btn btn-highlight btn-block" style={{ marginTop: 12 }} onClick={submit}><Check size={16} /> Save transaction</button>
    </Modal>
  );
}

function TxnEditModal({ transaction, externalError, onClose, onSaveEdit, onVoid }) {
  const [amount, setAmount] = useState(String(transaction.amount));
  const [description, setDescription] = useState(transaction.description || '');
  const [category, setCategory] = useState(transaction.category);
  const [type, setType] = useState(transaction.type);
  const [destination, setDestination] = useState(transaction.destination);
  const [editReason, setEditReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [showVoidConfirm, setShowVoidConfirm] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidError, setVoidError] = useState('');
  const [voiding, setVoiding] = useState(false);

  useEffect(() => {
    if (externalError) { setError(externalError); setSubmitting(false); setVoidError(externalError); setVoiding(false); }
  }, [externalError]);

  const submitEdit = () => {
    setError('');
    if (!amount || Number(amount) <= 0) { setError('Enter a valid amount.'); return; }
    if (!description.trim()) { setError('Add a short description.'); return; }
    if (!editReason.trim()) { setError('Explain why this transaction is being edited.'); return; }
    setSubmitting(true);
    onSaveEdit(transaction.id, { amount: Number(amount), description, category, type, destination }, editReason.trim());
  };

  const submitVoid = () => {
    setVoidError('');
    if (!voidReason.trim()) { setVoidError('Explain why this transaction is being voided.'); return; }
    setVoiding(true);
    onVoid(transaction.id, voidReason.trim());
  };

  if (transaction.voided) {
    return (
      <Modal title="Transaction voided" onClose={onClose}>
        <div className="close-summary">
          <div className="close-row"><span>{transaction.category}</span><span className="mono-val">{peso(transaction.amount)}</span></div>
          <div className="close-row"><span>Voided by</span><span className="mono-val">{transaction.voidedBy}</span></div>
          <div className="close-row"><span>Reason</span><span className="mono-val">{transaction.voidReason}</span></div>
        </div>
        <button className="btn btn-outline btn-block" style={{ marginTop: 14 }} onClick={onClose}>Close</button>
      </Modal>
    );
  }

  return (
    <Modal title="Edit transaction" onClose={onClose}>
      {transaction.isBackfill && <div className="backfill-note">This is a backdated entry.</div>}
      <div className="toggle-row">
        {['Cash In', 'Cash Out'].map(v => (
          <button key={v} className={`toggle-btn ${type === v ? (v === 'Cash In' ? 'toggle-on-green' : 'toggle-on-red') : ''}`} onClick={() => setType(v)}>{v}</button>
        ))}
      </div>
      <div className="toggle-row">
        {['Cash', 'GCash'].map(v => (
          <button key={v} className={`toggle-btn ${destination === v ? 'toggle-on-blue' : ''}`} onClick={() => setDestination(v)}>{v}</button>
        ))}
      </div>

      <label className="field-label">Amount</label>
      <input className="field-input mono-input" type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />

      <label className="field-label">Description</label>
      <input className="field-input" value={description} onChange={e => setDescription(e.target.value)} />

      <label className="field-label">Category</label>
      <select className="field-input" value={category} onChange={e => setCategory(e.target.value)}>
        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <div className="field-static-row">
        <span>Recorded {dateTimeStr(transaction.datetime)} by {transaction.createdByName}</span>
      </div>

      <label className="field-label">Reason for this edit (required)</label>
      <textarea className="field-input" rows={2} value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="e.g. wrong amount typed in" />

      {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}
      <button className="btn btn-highlight btn-block" style={{ marginTop: 12 }} onClick={submitEdit} disabled={submitting}>
        <Check size={16} /> {submitting ? 'Saving…' : 'Save edit'}
      </button>

      <div className="divider" />

      {!showVoidConfirm ? (
        <button className="btn btn-danger-outline btn-block" onClick={() => setShowVoidConfirm(true)}>
          <Trash2 size={16} /> Void this transaction
        </button>
      ) : (
        <>
          <p className="modal-sub">Voiding keeps this transaction visible for the record, but removes it from all totals. This can't be undone.</p>
          <label className="field-label" style={{ marginTop: 0 }}>Reason for voiding (required)</label>
          <textarea className="field-input" rows={2} value={voidReason} onChange={e => setVoidReason(e.target.value)} placeholder="e.g. duplicate entry" />
          {voidError && <div className="error-line"><AlertCircle size={14} /> {voidError}</div>}
          <button className="btn btn-danger-outline btn-block" style={{ marginTop: 10 }} onClick={submitVoid} disabled={voiding}>
            <Trash2 size={16} /> {voiding ? 'Voiding…' : 'Confirm void'}
          </button>
        </>
      )}
    </Modal>
  );
}

function BackfillAttendanceModal({ employees, externalError, onClose, onSave }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id || '');
  const toLocalInput = (d) => {
    const dt = new Date(d);
    dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
    return dt.toISOString().slice(0, 16);
  };
  const [clockIn, setClockIn] = useState(() => toLocalInput(new Date()));
  const [clockOut, setClockOut] = useState(() => toLocalInput(new Date()));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (externalError) { setError(externalError); setSubmitting(false); }
  }, [externalError]);

  const submit = () => {
    if (!employeeId) { setError('Select an employee.'); return; }
    if (!clockIn) { setError('Enter a clock-in time.'); return; }
    if (clockOut && new Date(clockOut) < new Date(clockIn)) { setError('Clock-out can\u2019t be before clock-in.'); return; }
    if (!reason.trim()) { setError('Explain why this attendance is being backdated (e.g. WiFi outage).'); return; }
    setSubmitting(true);
    onSave({
      employeeId,
      clockIn: new Date(clockIn).toISOString(),
      clockOut: clockOut ? new Date(clockOut).toISOString() : null,
      reason: reason.trim(),
    });
  };

  return (
    <Modal title="Add backdated attendance" onClose={onClose}>
      <p className="modal-sub">
        For recording a shift after the fact — e.g. from a paper log during a WiFi outage.
      </p>

      <label className="field-label" style={{ marginTop: 0 }}>Employee</label>
      <select className="field-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
        {employees.filter(e => e.active !== false).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>

      <label className="field-label">Clock in</label>
      <input className="field-input" type="datetime-local" value={clockIn} onChange={e => setClockIn(e.target.value)} />

      <label className="field-label">Clock out (leave blank if still clocked in)</label>
      <input className="field-input" type="datetime-local" value={clockOut} onChange={e => setClockOut(e.target.value)} />

      <label className="field-label">Reason for backdating (required)</label>
      <textarea className="field-input" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. WiFi outage on Aug 27, recorded from notebook" />

      {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}
      <button className="btn btn-highlight btn-block" style={{ marginTop: 12 }} onClick={submit} disabled={submitting}>
        <Check size={16} /> {submitting ? 'Saving…' : 'Save backdated attendance'}
      </button>
    </Modal>
  );
}

function AttendanceEditModal({ record, externalError, onClose, onSave }) {
  const toLocalInput = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
    return dt.toISOString().slice(0, 16);
  };
  const [clockIn, setClockIn] = useState(toLocalInput(record.clockIn));
  const [clockOut, setClockOut] = useState(toLocalInput(record.clockOut));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (externalError) { setError(externalError); setSubmitting(false); }
  }, [externalError]);

  const submit = () => {
    if (!clockIn) { setError('Enter a clock-in time.'); return; }
    if (clockOut && new Date(clockOut) < new Date(clockIn)) { setError('Clock-out can\u2019t be before clock-in.'); return; }
    if (!reason.trim()) { setError('Explain why this record is being edited.'); return; }
    setSubmitting(true);
    onSave(record.id, new Date(clockIn).toISOString(), clockOut ? new Date(clockOut).toISOString() : null, reason.trim());
  };

  return (
    <Modal title="Edit attendance" onClose={onClose}>
      {record.isBackfill && <div className="backfill-note">This is a backdated entry.</div>}
      <div className="field-static-row" style={{ marginTop: 0 }}>
        <span>{record.employeeName} · {record.role}</span>
      </div>

      <label className="field-label">Clock in</label>
      <input className="field-input" type="datetime-local" value={clockIn} onChange={e => setClockIn(e.target.value)} />

      <label className="field-label">Clock out (leave blank if still clocked in)</label>
      <input className="field-input" type="datetime-local" value={clockOut} onChange={e => setClockOut(e.target.value)} />

      <label className="field-label">Reason for this edit (required)</label>
      <textarea className="field-input" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. forgot to clock out, corrected from memory" />

      {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}
      <button className="btn btn-highlight btn-block" style={{ marginTop: 12 }} onClick={submit} disabled={submitting}>
        <Check size={16} /> {submitting ? 'Saving…' : 'Save edit'}
      </button>
    </Modal>
  );
}

function BackfillEntryModal({ employees, defaultCreatedBy, externalError, onClose, onSave }) {
  const [type, setType] = useState('Cash In');
  const [destination, setDestination] = useState('Cash');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [createdBy, setCreatedBy] = useState(defaultCreatedBy);
  const [datetime, setDatetime] = useState(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (externalError) { setError(externalError); setSubmitting(false); }
  }, [externalError]);

  const submit = () => {
    if (!amount || Number(amount) <= 0) { setError('Enter a valid amount.'); return; }
    if (!description.trim()) { setError('Add a short description.'); return; }
    if (!reason.trim()) { setError('Explain why this entry is being backdated (e.g. WiFi outage).'); return; }
    setSubmitting(true);
    onSave({ type, destination, amount, description, category, createdBy, datetime: new Date(datetime).toISOString(), reason: reason.trim() });
  };

  return (
    <Modal title="Add backdated entry" onClose={onClose}>
      <p className="modal-sub">
        For recording transactions after the fact — e.g. from a paper notebook during a WiFi outage.
        This is clearly marked as backfilled and won't affect the normal transaction flow.
      </p>
      <div className="toggle-row">
        {['Cash In', 'Cash Out'].map(v => (
          <button key={v} className={`toggle-btn ${type === v ? (v === 'Cash In' ? 'toggle-on-green' : 'toggle-on-red') : ''}`} onClick={() => setType(v)}>{v}</button>
        ))}
      </div>
      <div className="toggle-row">
        {['Cash', 'GCash'].map(v => (
          <button key={v} className={`toggle-btn ${destination === v ? 'toggle-on-blue' : ''}`} onClick={() => setDestination(v)}>{v}</button>
        ))}
      </div>

      <label className="field-label">Amount</label>
      <input className="field-input mono-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />

      <label className="field-label">Description</label>
      <input className="field-input" placeholder="e.g. 20 pages B&W printing" value={description} onChange={e => setDescription(e.target.value)} />

      <label className="field-label">Category</label>
      <select className="field-input" value={category} onChange={e => setCategory(e.target.value)}>
        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <label className="field-label">Actual date & time this happened</label>
      <input className="field-input" type="datetime-local" value={datetime} onChange={e => setDatetime(e.target.value)} />

      <label className="field-label">Who handled this transaction</label>
      <select className="field-input" value={createdBy} onChange={e => setCreatedBy(e.target.value)}>
        {employees.filter(e => e.active !== false).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>

      <label className="field-label">Reason for backdating (required)</label>
      <textarea className="field-input" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. WiFi outage on Aug 27, recorded from notebook" />

      {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}
      <button className="btn btn-highlight btn-block" style={{ marginTop: 12 }} onClick={submit} disabled={submitting}>
        <Check size={16} /> {submitting ? 'Saving…' : 'Save backdated entry'}
      </button>
    </Modal>
  );
}

function SettingsModal({ employees, currentEmployee, categoryLimits, canManage, pinChangeError, onClose, onAdd, onToggle, onSaveLimit, onDeleteLimit, onChangeMyPin }) {
  const [name, setName] = useState('');
  const [pinVal, setPinVal] = useState('');
  const [role, setRole] = useState('Employee');
  const [error, setError] = useState('');
  const [notifStatus, setNotifStatus] = useState('checking');
  const [notifError, setNotifError] = useState('');
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [pinFormError, setPinFormError] = useState('');
  const [pinSaved, setPinSaved] = useState(false);
  const [changingPin, setChangingPin] = useState(false);
  const [limitInputs, setLimitInputs] = useState(() => {
    const initial = {};
    for (const c of CATEGORIES) {
      const existing = categoryLimits.find(l => l.category === c);
      initial[c] = existing ? String(existing.monthlyLimit) : '';
    }
    return initial;
  });
  const [limitSaved, setLimitSaved] = useState('');

  const canGetNotifications = currentEmployee && ['Manager', 'Admin', 'Owner'].includes(currentEmployee.role);

  useEffect(() => {
    if (pinChangeError) { setPinFormError(pinChangeError); setChangingPin(false); }
  }, [pinChangeError]);

  const handleChangePin = async () => {
    setPinFormError('');
    if (currentPinInput !== currentEmployee.pin) { setPinFormError('Current PIN is incorrect.'); return; }
    if (!/^\d{4}$/.test(newPinInput)) { setPinFormError('New PIN must be exactly 4 digits.'); return; }
    if (newPinInput !== confirmPinInput) { setPinFormError('New PIN and confirmation don\u2019t match.'); return; }
    if (employees.some(e => e.pin === newPinInput && e.active !== false && e.id !== currentEmployee.id)) {
      setPinFormError('That PIN is already in use by someone else.');
      return;
    }
    setChangingPin(true);
    const success = await onChangeMyPin(newPinInput);
    setChangingPin(false);
    if (success) {
      setCurrentPinInput(''); setNewPinInput(''); setConfirmPinInput('');
      setPinSaved(true);
      setTimeout(() => setPinSaved(false), 2000);
    }
  };

  const handleSaveLimit = async (category) => {
    const val = limitInputs[category];
    if (val.trim() === '') {
      await onDeleteLimit(category);
    } else {
      await onSaveLimit(category, Number(val));
    }
    setLimitSaved(category);
    setTimeout(() => setLimitSaved(''), 1500);
  };

  useEffect(() => {
    if (!canGetNotifications) return;
    if (!('Notification' in window)) { setNotifStatus('unsupported'); return; }
    getExistingPushSubscription()
      .then(sub => setNotifStatus(sub ? 'enabled' : 'disabled'))
      .catch(() => setNotifStatus('unsupported'));
  }, [canGetNotifications]);

  const handleEnableNotifs = async () => {
    setNotifError('');
    setNotifStatus('working');
    try {
      await enablePushNotifications(currentEmployee);
      setNotifStatus('enabled');
    } catch (e) {
      setNotifError(e.message || 'Could not enable notifications.');
      setNotifStatus('disabled');
    }
  };

  const handleDisableNotifs = async () => {
    setNotifError('');
    setNotifStatus('working');
    try {
      await disablePushNotifications();
      setNotifStatus('disabled');
    } catch (e) {
      setNotifError(e.message || 'Could not disable notifications.');
      setNotifStatus('enabled');
    }
  };

  const submit = () => {
    if (!name.trim()) { setError('Enter a name.'); return; }
    if (!/^\d{4}$/.test(pinVal)) { setError('PIN must be exactly 4 digits.'); return; }
    if (employees.some(e => e.pin === pinVal && e.active !== false)) { setError('That PIN is already in use.'); return; }
    onAdd({ name: name.trim(), pin: pinVal, role });
    setName(''); setPinVal(''); setRole('Employee'); setError('');
  };

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="modal-sub" style={{ marginTop: 0 }}>Change my PIN</div>
      <label className="field-label" style={{ marginTop: 0 }}>Current PIN</label>
      <input className="field-input mono-input" value={currentPinInput} maxLength={4} inputMode="numeric" onChange={e => setCurrentPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" />
      <label className="field-label">New 4-digit PIN</label>
      <input className="field-input mono-input" value={newPinInput} maxLength={4} inputMode="numeric" onChange={e => setNewPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" />
      <label className="field-label">Confirm new PIN</label>
      <input className="field-input mono-input" value={confirmPinInput} maxLength={4} inputMode="numeric" onChange={e => setConfirmPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" />
      {pinFormError && <div className="error-line"><AlertCircle size={14} /> {pinFormError}</div>}
      <button className="btn btn-purple btn-block" style={{ marginTop: 10 }} onClick={handleChangePin} disabled={changingPin}>
        {pinSaved ? <Check size={16} /> : <Lock size={16} />} {pinSaved ? 'PIN updated' : (changingPin ? 'Saving…' : 'Change PIN')}
      </button>
      <div className="divider" />

      {canGetNotifications && (
        <>
          <div className="modal-sub" style={{ marginTop: 0 }}>Notifications on this device</div>
          {notifStatus === 'unsupported' && (
            <div className="empty-state">This browser doesn't support notifications.</div>
          )}
          {notifStatus === 'enabled' && (
            <button className="btn btn-outline btn-block" onClick={handleDisableNotifs}>
              <Check size={16} /> Notifications enabled — tap to turn off
            </button>
          )}
          {(notifStatus === 'disabled' || notifStatus === 'working') && (
            <button className="btn btn-purple btn-block" onClick={handleEnableNotifs} disabled={notifStatus === 'working'}>
              Enable notifications on this device
            </button>
          )}
          {notifError && <div className="error-line"><AlertCircle size={14} /> {notifError}</div>}
          <div className="divider" />

          <div className="modal-sub" style={{ marginTop: 0 }}>Monthly spending limits</div>
          <p className="hint-line">Leave blank for no limit. You'll be alerted when a category's Cash Out total reaches its limit for the month.</p>
          <div className="limits-list">
            {CATEGORIES.filter(c => !c.toLowerCase().includes('income')).map(c => (
              <div key={c} className="limit-row">
                <span className="limit-row-name">{c}</span>
                <input
                  className="field-input mono-input limit-input"
                  type="number" min="0" step="1" placeholder="No limit"
                  value={limitInputs[c]}
                  onChange={e => setLimitInputs({ ...limitInputs, [c]: e.target.value })}
                  onBlur={() => handleSaveLimit(c)}
                />
                {limitSaved === c && <Check size={14} className="limit-saved-check" />}
              </div>
            ))}
          </div>
          <div className="divider" />
        </>
      )}
      {canManage && (
        <>
          <div className="modal-sub" style={{ marginTop: 0 }}>Employees</div>
          <div className="emp-list">
            {employees.map(e => (
              <div key={e.id} className="emp-row">
                <div className="avatar-circle avatar-sm">{initials(e.name)}</div>
                <div className="emp-row-info">
                  <div className="emp-row-name">{e.name}</div>
                  <div className="emp-row-role">{e.role} · PIN {e.pin}</div>
                </div>
                <button className={`btn ${e.active === false ? 'btn-outline' : 'btn-danger-outline'} btn-sm`} onClick={() => onToggle(e.id)}>
                  {e.active === false ? 'Reactivate' : 'Deactivate'}
                </button>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="modal-sub"><UserPlus size={14} style={{ verticalAlign: -2 }} /> Add employee</div>
          <label className="field-label">Name</label>
          <input className="field-input" value={name} onChange={e => setName(e.target.value)} placeholder="Full name" />
          <label className="field-label">4-digit PIN</label>
          <input className="field-input mono-input" value={pinVal} maxLength={4} inputMode="numeric" onChange={e => setPinVal(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" />
          <label className="field-label">Role</label>
          <select className="field-input" value={role} onChange={e => setRole(e.target.value)}>
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}
          <button className="btn btn-highlight btn-block" style={{ marginTop: 12 }} onClick={submit}><Plus size={16} /> Add employee</button>
        </>
      )}
    </Modal>
  );
}

function CloseDayModal({ draft, expectedCash, expectedGCash, sums, onClose, onProceed }) {
  return (
    <Modal title="Close day" onClose={onClose}>
      <p className="modal-sub">Review today's totals before counting the drawer.</p>
      <div className="close-summary">
        <div className="close-row"><span>Opening cash</span><span className="mono-val">{peso(draft.openingCash)}</span></div>
        <div className="close-row"><span>Cash in</span><span className="mono-val amt-in">+{peso(sums.cashIn)}</span></div>
        <div className="close-row"><span>Cash out</span><span className="mono-val amt-out">−{peso(sums.cashOut)}</span></div>
        <div className="close-row close-row-total"><span>Expected cash</span><span className="mono-val">{peso(expectedCash)}</span></div>
      </div>
      <div className="close-summary" style={{ marginTop: 10 }}>
        <div className="close-row"><span>Opening GCash</span><span className="mono-val">{peso(draft.openingGCash)}</span></div>
        <div className="close-row"><span>GCash in</span><span className="mono-val amt-in">+{peso(sums.gcashIn)}</span></div>
        <div className="close-row"><span>GCash out</span><span className="mono-val amt-out">−{peso(sums.gcashOut)}</span></div>
        <div className="close-row close-row-total"><span>Expected GCash</span><span className="mono-val">{peso(expectedGCash)}</span></div>
      </div>
      <button className="btn btn-highlight btn-block" style={{ marginTop: 14 }} onClick={onProceed}>
        <Banknote size={16} /> Proceed to cash count
      </button>
    </Modal>
  );
}

function CashCountModal({ expectedCash, expectedGCash, externalError, onClose, onConfirm }) {
  const [counts, setCounts] = useState(() => Object.fromEntries(DENOMINATIONS.map(d => [d, ''])));
  const [gcash, setGcash] = useState(String(expectedGCash.toFixed(2)));
  const [notes, setNotes] = useState('');
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoProcessing, setPhotoProcessing] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (externalError) {
      setError(externalError);
      setSubmitting(false);
    }
  }, [externalError]);

  const total = DENOMINATIONS.reduce((sum, d) => sum + d * (Number(counts[d]) || 0), 0);
  const diff = total - expectedCash;
  const gcashDiff = (Number(gcash) || 0) - expectedGCash;
  const hasAnyDiscrepancy = diff !== 0 || gcashDiff !== 0;
  const hasLargeDiscrepancy = Math.abs(diff) >= DISCREPANCY_THRESHOLD || Math.abs(gcashDiff) >= DISCREPANCY_THRESHOLD;

  const handlePhotoChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setError('');
    setPhotoProcessing(true);
    try {
      const compressed = await compressImage(file);
      setPhotoFile(compressed);
      setPhotoPreview(URL.createObjectURL(compressed));
    } catch (err) {
      console.error('Photo compression failed', err);
      setError('Could not process that photo. Please try taking it again.');
      setPhotoFile(null);
      setPhotoPreview('');
    } finally {
      setPhotoProcessing(false);
      e.target.value = '';
    }
  };

  const handleConfirm = () => {
    setError('');
    if (photoProcessing) {
      setError('Please wait for the photo to finish processing.');
      return;
    }
    if (total === 0) {
      setError('You haven\u2019t entered any denominations yet — count the drawer before confirming.');
      return;
    }
    if (!photoFile) {
      setError('Attach a photo of the counted drawer before confirming.');
      return;
    }
    if (hasAnyDiscrepancy && !notes.trim()) {
      setError('There\u2019s a difference from the expected amount — add a short note explaining it.');
      return;
    }
    if (hasLargeDiscrepancy && !confirmChecked) {
      setError('Please check the box confirming you recounted before continuing.');
      return;
    }
    setSubmitting(true);
    onConfirm(counts, gcash, notes.trim(), photoFile);
  };

  return (
    <Modal title="Cash count" onClose={onClose}>
      <p className="modal-sub">Count each denomination in the drawer.</p>
      <div className="denom-grid">
        {DENOMINATIONS.map(d => (
          <div key={d} className="denom-row">
            <div className="denom-label">₱{d}</div>
            <input
              className="field-input mono-input denom-input"
              type="number" min="0" step="1" placeholder="0"
              value={counts[d]}
              onChange={e => setCounts({ ...counts, [d]: e.target.value })}
            />
            <div className="denom-subtotal">{peso(d * (Number(counts[d]) || 0))}</div>
          </div>
        ))}
      </div>
      <div className="lcd-display lcd-total">
        <div className="lcd-total-label">Counted cash</div>
        <div className="lcd-total-value">{peso(total)}</div>
      </div>
      <div className={`diff-line ${diff === 0 ? 'diff-even' : diff > 0 ? 'diff-over' : 'diff-short'}`}>
        {diff === 0 ? 'Matches expected cash' : diff > 0 ? `Over by ${peso(diff)}` : `Short by ${peso(Math.abs(diff))}`}
      </div>

      <label className="field-label" style={{ marginTop: 12 }}>Confirmed GCash balance</label>
      <input className="field-input mono-input" type="number" min="0" step="0.01" value={gcash} onChange={e => setGcash(e.target.value)} />

      <label className="field-label">Photo of the counted drawer</label>
      <input className="field-input" type="file" accept="image/*" capture="environment" onChange={handlePhotoChange} disabled={photoProcessing} />
      {photoProcessing && <div className="hint-line">Processing photo…</div>}
      {photoPreview && !photoProcessing && <img src={photoPreview} alt="Counted drawer" className="photo-preview" />}

      {hasAnyDiscrepancy && (
        <>
          <label className="field-label">Note explaining the difference</label>
          <textarea className="field-input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. gave change from own pocket, short till at shift start..." />
        </>
      )}

      {hasLargeDiscrepancy && (
        <label className="confirm-checkbox-row">
          <input type="checkbox" checked={confirmChecked} onChange={e => setConfirmChecked(e.target.checked)} />
          <span>I recounted the drawer and confirm this is accurate.</span>
        </label>
      )}

      {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}

      <button className="btn btn-highlight btn-block" style={{ marginTop: 14 }} onClick={handleConfirm} disabled={submitting || photoProcessing}>
        <Check size={16} /> {submitting ? 'Saving…' : (photoProcessing ? 'Processing photo…' : 'Confirm cash count')}
      </button>
    </Modal>
  );
}

function ResolveMissedDayModal({ date, expected, externalError, onClose, onResolve }) {
  const [mode, setMode] = useState('accept'); // 'accept' | 'manual'
  const [manualCash, setManualCash] = useState(String(expected.expectedCash.toFixed(2)));
  const [manualGCash, setManualGCash] = useState(String(expected.expectedGCash.toFixed(2)));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (externalError) {
      setError(externalError);
      setSubmitting(false);
    }
  }, [externalError]);

  const handleResolve = async () => {
    setError('');
    if (mode === 'manual' && !note.trim()) {
      setError('Add a note explaining where this number came from.');
      return;
    }
    setSubmitting(true);
    await onResolve(
      date,
      mode === 'accept',
      manualCash,
      manualGCash,
      mode === 'accept' ? '' : note.trim()
    );
  };

  return (
    <Modal title="Resolve missed closing" onClose={onClose}>
      <p className="modal-sub">
        <strong>{date}</strong> was never closed. A physical count can't be done retroactively,
        so choose how to record it — this will be clearly marked as resolved after the fact.
      </p>

      <div className="close-summary">
        <div className="close-row"><span>Opening cash</span><span className="mono-val">{peso(expected.openingCash)}</span></div>
        <div className="close-row close-row-total"><span>Expected cash (system total)</span><span className="mono-val">{peso(expected.expectedCash)}</span></div>
      </div>
      <div className="close-summary" style={{ marginTop: 10 }}>
        <div className="close-row"><span>Opening GCash</span><span className="mono-val">{peso(expected.openingGCash)}</span></div>
        <div className="close-row close-row-total"><span>Expected GCash (system total)</span><span className="mono-val">{peso(expected.expectedGCash)}</span></div>
      </div>

      <div className="toggle-row" style={{ marginTop: 14 }}>
        <button className={`toggle-btn ${mode === 'accept' ? 'toggle-on-blue' : ''}`} onClick={() => setMode('accept')}>Accept system total</button>
        <button className={`toggle-btn ${mode === 'manual' ? 'toggle-on-blue' : ''}`} onClick={() => setMode('manual')}>Enter a different number</button>
      </div>

      {mode === 'accept' ? (
        <p className="modal-sub">
          This records the day as closed with no discrepancy, and automatically notes that
          no physical count was performed.
        </p>
      ) : (
        <>
          <label className="field-label">Counted cash (from another record, e.g. a notebook)</label>
          <input className="field-input mono-input" type="number" step="0.01" value={manualCash} onChange={e => setManualCash(e.target.value)} />
          <label className="field-label">Counted GCash</label>
          <input className="field-input mono-input" type="number" step="0.01" value={manualGCash} onChange={e => setManualGCash(e.target.value)} />
          <label className="field-label">Note — where did this number come from?</label>
          <textarea className="field-input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. taken from the paper notebook backup" />
        </>
      )}

      {error && <div className="error-line"><AlertCircle size={14} /> {error}</div>}

      <button className="btn btn-highlight btn-block" style={{ marginTop: 14 }} onClick={handleResolve} disabled={submitting}>
        <Check size={16} /> {submitting ? 'Saving…' : 'Resolve this day'}
      </button>
    </Modal>
  );
}

function ClosedReceiptModal({ record, onClose }) {
  const diff = record.cashDifference;
  return (
    <Modal title="Day closed" onClose={onClose}>
      <div className="receipt-panel receipt-panel-flat">
        <div className="receipt-tear" />
        <div className="close-summary">
          <div className="close-row"><span>Date</span><span className="mono-val">{record.date}</span></div>
          <div className="close-row"><span>Closed by</span><span className="mono-val">{record.closedBy}</span></div>
          <div className="close-row"><span>Expected cash</span><span className="mono-val">{peso(record.expectedCash)}</span></div>
          <div className="close-row"><span>Counted cash</span><span className="mono-val">{peso(record.countedCash)}</span></div>
          <div className="close-row close-row-total">
            <span>Difference</span>
            <span className={`mono-val ${diff === 0 ? '' : diff > 0 ? 'amt-in' : 'amt-out'}`}>
              {diff === 0 ? '—' : (diff > 0 ? '+' : '−') + peso(Math.abs(diff))}
            </span>
          </div>
        </div>
        <div className="receipt-tear receipt-tear-bottom" />
      </div>
      {record.notes && (
        <div className="closing-note">
          <div className="closing-note-label">Note</div>
          <div>{record.notes}</div>
        </div>
      )}
      {record.photoUrl && (
        <img src={record.photoUrl} alt="Counted drawer" className="photo-preview" />
      )}
      <button className="btn btn-highlight btn-block" style={{ marginTop: 14 }} onClick={onClose}><Check size={16} /> Done</button>
    </Modal>
  );
}

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Lexend:wght@500;700&family=Inter:wght@400;500;600&family=Epilogue:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap');

html, body {
  margin: 0;
  background: #F2E3CE;
}

.pos-root {
  --paper: #FDF4EB;
  --paper-dark: #F2E3CE;
  --ink: #241C1F;
  --ink-soft: #7A6F65;
  --rule-blue: #57B7C7;
  --highlight: #E14C21;
  --highlight-ink: #FFFFFF;
  --brand-purple: #795578;
  --success: #27935A;
  --success-bg: #E2F2E8;
  --danger: #B4413A;
  --danger-bg: #FBEAE8;
  font-family: 'Inter', sans-serif;
  background: var(--paper);
  color: var(--ink);
  max-width: 480px;
  margin: 0 auto;
  padding: 16px;
  border-radius: 16px;
  box-sizing: border-box;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

@media (min-width: 700px) {
  .pos-root { max-width: 640px; margin: 16px auto; min-height: calc(100dvh - 32px); box-shadow: 0 4px 24px rgba(36,28,31,0.08); }
}
@media (min-width: 1024px) {
  .pos-root { max-width: 760px; }
  .summary-grid { grid-template-columns: 1fr 1fr; }
  .employee-grid { grid-template-columns: repeat(3, 1fr); }
}

.pos-root * { box-sizing: border-box; }
.pos-loading { display: flex; align-items: center; justify-content: center; min-height: 200px; }
.content-area { flex: 1 1 auto; display: flex; flex-direction: column; }

.brand-mark { display: flex; align-items: center; gap: 10px; }
.brand-badge {
  width: 38px; height: 38px; border-radius: 10px; object-fit: cover; flex-shrink: 0;
  box-shadow: 0 0 0 1px var(--paper-dark);
}
.login-logo-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; margin-bottom: 22px; }
.login-logo { width: 128px; height: 128px; object-fit: cover; border-radius: 20px; box-shadow: 0 0 0 1px var(--paper-dark); }
.brand-title { font-family: 'Lexend', sans-serif; font-weight: 700; font-size: 18px; letter-spacing: -0.2px; line-height: 1.15; }
.brand-sub { font-size: 12px; color: var(--ink-soft); }
.brand-title-sm { font-family: 'Lexend', sans-serif; font-weight: 700; font-size: 13px; line-height: 1.15; }
.brand-sub-sm { font-size: 11px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; }

.login-wrap { padding: 8px 4px 20px; }
.login-wrap .brand-mark { justify-content: center; margin-bottom: 24px; }
.login-prompt { text-align: center; font-size: 14px; color: var(--ink-soft); margin: 0 0 16px; }

.employee-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.employee-card {
  background: #fff; border: 1px solid var(--paper-dark); border-radius: 12px; padding: 14px 8px;
  display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer;
  font-family: inherit; transition: transform .1s, border-color .15s;
}
.employee-card:active { transform: scale(0.97); }
.employee-card:hover { border-color: var(--rule-blue); }
.employee-card-name { font-weight: 600; font-size: 13px; text-align: center; }
.employee-card-role { font-size: 11px; color: var(--ink-soft); }

.avatar-circle {
  width: 46px; height: 46px; border-radius: 50%; background: var(--rule-blue); color: var(--ink);
  display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 15px; font-family: 'Lexend', sans-serif;
  flex-shrink: 0;
}
.avatar-sm { width: 34px; height: 34px; font-size: 12px; }
.avatar-lg { width: 60px; height: 60px; font-size: 20px; margin: 0 auto; }

.pin-panel { text-align: center; }
.pin-panel-name { font-weight: 600; font-size: 15px; margin: 8px 0 14px; }
.back-link {
  background: none; border: none; color: var(--ink-soft); font-size: 12px; display: flex; align-items: center; gap: 2px;
  cursor: pointer; padding: 4px 0; margin-bottom: 4px; font-family: inherit;
}
.pin-shake { animation: shake .4s; }
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-8px)} 75%{transform:translateX(8px)} }

.lcd-display {
  background: var(--brand-purple); color: #6FE3A3; font-family: 'IBM Plex Mono', monospace; font-weight: 600;
  border-radius: 8px; padding: 16px; margin: 14px auto; letter-spacing: 2px; font-size: 13px;
  max-width: 220px; text-align: center;
}
.lcd-total { max-width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; }
.lcd-total-label { font-size: 11px; color: #6FE3A3; opacity: 0.85; letter-spacing: 1px; }
.lcd-total-value { font-size: 22px; font-family: 'Epilogue', sans-serif; font-weight: 500; }

.pin-dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #6FE3A3; }
.pin-dot-filled { background: #6FE3A3; }

.pin-dots-row { display: flex; gap: 12px; justify-content: center; }
.keypad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; max-width: 320px; margin: 0 auto; }
.keypad-btn {
  background: #fff; border: 1px solid var(--paper-dark); border-radius: 10px; padding: 14px 0;
  font-size: 17px; font-weight: 600; font-family: 'IBM Plex Mono', monospace; cursor: pointer;
  box-shadow: 0 2px 0 var(--paper-dark); display: flex; align-items: center; justify-content: center;
}
.keypad-btn:active { box-shadow: none; transform: translateY(2px); }

.error-line { color: var(--danger); font-size: 12px; display: flex; align-items: center; gap: 5px; margin: 8px 0; justify-content: center; }

.topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.topbar-right { display: flex; align-items: center; gap: 8px; }
.icon-btn { background: #fff; border: 1px solid var(--paper-dark); border-radius: 8px; padding: 7px; cursor: pointer; display: flex; }
.me-chip { display: flex; align-items: center; gap: 7px; background: #fff; border: 1px solid var(--paper-dark); border-radius: 20px; padding: 4px 10px 4px 4px; }
.me-name { font-size: 12px; font-weight: 600; line-height: 1.2; }
.me-role { font-size: 10px; color: var(--ink-soft); }

.status-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.status-pill { font-size: 12px; display: flex; align-items: center; gap: 6px; color: var(--ink-soft); }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot-on { background: var(--success); }
.dot-off { background: var(--ink-soft); }
.status-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.active-strip { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--ink-soft); margin-bottom: 14px; }
.active-strip-label { font-weight: 500; }
.active-chip { background: var(--paper-dark); border-radius: 10px; padding: 2px 8px; font-weight: 500; color: var(--ink); }

.btn {
  border-radius: 10px; padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-family: inherit; border: 1px solid transparent;
}
.btn-sm { padding: 6px 10px; font-size: 12px; }
.btn-block { width: 100%; }
.btn-primary { background: var(--rule-blue); color: var(--ink); }
.btn-highlight { background: var(--highlight); color: var(--highlight-ink); }
.btn-outline { background: #fff; border-color: var(--paper-dark); color: var(--ink); }
.btn-danger-outline { background: #fff; border-color: var(--danger); color: var(--danger); }
.btn-green { background: var(--success); color: #fff; }
.btn-purple { background: var(--brand-purple); color: #fff; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }

.action-row { display: flex; gap: 8px; margin-bottom: 6px; }
.action-row .btn-block { flex: 1; }
.hint-line { font-size: 11px; color: var(--ink-soft); margin-bottom: 10px; }
.missed-day-banner {
  width: 100%; display: flex; align-items: center; gap: 8px; background: var(--highlight); color: #fff;
  border: none; border-radius: 10px; padding: 10px 14px; font-size: 12.5px; font-weight: 600;
  margin-bottom: 12px; cursor: pointer; font-family: inherit; text-align: left;
}
.spending-limit-banner { background: var(--brand-purple); }

.closed-badge { display: flex; align-items: center; justify-content: center; gap: 6px; background: var(--success-bg); color: var(--success); border-radius: 10px; padding: 10px 14px; font-size: 13px; font-weight: 600; }
.closed-badge-btn { border: 1px solid var(--success); cursor: pointer; font-family: inherit; }

.summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
.summary-card-muted { background: var(--paper-dark); border-color: var(--paper-dark); }
.field-static { display: flex; align-items: center; color: var(--ink-soft); background: var(--paper-dark); }
.opening-page { padding: 24px 6px; max-width: 360px; margin: 0 auto; }
.opening-page-intro { font-size: 13px; color: var(--ink-soft); line-height: 1.5; margin-bottom: 18px; }
.summary-card { background: #fff; border: 1px solid var(--paper-dark); border-radius: 12px; padding: 12px 14px; }
.summary-label { font-size: 11px; color: var(--ink-soft); display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }
.summary-value { font-family: 'Epilogue', sans-serif; font-size: 18px; font-weight: 500; }
.summary-foot { font-size: 10px; color: var(--ink-soft); margin-top: 3px; }

.receipt-panel { background: var(--paper-dark); border-radius: 4px; margin-top: 16px; padding: 4px 14px 10px; position: relative; }
.receipt-panel-flat { margin-top: 0; }
.receipt-tear { height: 10px; background-image: linear-gradient(-45deg, var(--paper) 6px, transparent 0), linear-gradient(45deg, var(--paper) 6px, transparent 0); background-size: 12px 12px; background-position: left top; background-repeat: repeat-x; margin: 0 -14px; }
.receipt-tear-bottom { transform: rotate(180deg); margin-top: 8px; }

.receipt-panel-alert { background: var(--highlight); }

.search-filter-row { display: flex; gap: 8px; margin: 10px 0 4px; }
.search-input-wrap { flex: 1; position: relative; }
.search-input-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--ink-soft); pointer-events: none; }
.search-input { width: 100%; padding-left: 36px !important; box-sizing: border-box; }
.filter-btn { white-space: nowrap; padding: 9px 14px; position: relative; background: var(--highlight); color: #fff; border: none; }
.filter-btn-active::after { content: ''; position: absolute; top: 6px; right: 6px; width: 7px; height: 7px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 2px var(--highlight); }
.filter-modal-actions { display: flex; gap: 8px; margin-top: 16px; }

.day-summary-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.day-summary-block { background: #fff; border: 1px solid var(--paper-dark); border-radius: 10px; overflow: hidden; }
.day-summary-row { width: 100%; text-align: left; background: none; border: none; padding: 11px 14px; cursor: pointer; font-family: inherit; }
.day-summary-top { display: flex; align-items: center; justify-content: space-between; }
.day-summary-date { font-weight: 600; font-size: 12.5px; }
.day-chevron { color: var(--ink-soft); transition: transform 0.15s; }
.day-chevron-open { transform: rotate(90deg); }
.day-summary-bottom { display: flex; justify-content: space-between; font-size: 11px; color: var(--ink-soft); margin-top: 4px; }
.day-summary-meta { font-size: 10.5px; color: var(--ink-soft); margin-top: 2px; }
.day-summary-expanded { padding: 0 14px 10px; border-top: 1px dashed #C9C0AA; margin-top: 4px; }

.receipt-panel-alert .receipt-header { color: #fff; }
.receipt-panel-alert .receipt-count { color: rgba(255,255,255,0.85); }
.receipt-panel-alert .receipt-row { border-top-color: rgba(255,255,255,0.35); }
.receipt-panel-alert .receipt-cat { color: #fff; }
.receipt-panel-alert .receipt-amt { color: #fff; }
.receipt-panel-alert .receipt-row-bottom { color: rgba(255,255,255,0.9); }
.receipt-tear-alert { background-image: linear-gradient(-45deg, var(--highlight) 6px, transparent 0), linear-gradient(45deg, var(--highlight) 6px, transparent 0); }

.receipt-panel-limit { background: var(--brand-purple); }
.receipt-panel-limit .receipt-header { color: #fff; }
.receipt-panel-limit .receipt-count { color: rgba(255,255,255,0.85); }
.receipt-panel-limit .receipt-row { border-top-color: rgba(255,255,255,0.35); }
.receipt-panel-limit .receipt-cat { color: #fff; }
.receipt-panel-limit .receipt-amt { color: #fff; }
.receipt-panel-limit .receipt-row-bottom { color: rgba(255,255,255,0.9); }
.receipt-tear-limit { background-image: linear-gradient(-45deg, var(--brand-purple) 6px, transparent 0), linear-gradient(45deg, var(--brand-purple) 6px, transparent 0); }

.limits-list { display: flex; flex-direction: column; gap: 6px; max-height: 280px; overflow-y: auto; }
.limit-row { display: flex; align-items: center; gap: 8px; }
.limit-row-name { flex: 1; font-size: 12px; }
.limit-input { width: 100px; text-align: right; }
.limit-saved-check { color: var(--success); flex-shrink: 0; }

.toast-stack {
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 60;
  display: flex; flex-direction: column; gap: 6px; align-items: center; width: 92%; max-width: 440px;
}
.toast-item {
  background: var(--brand-purple); color: #fff; font-size: 12.5px; font-weight: 600;
  padding: 10px 16px; border-radius: 10px; box-shadow: 0 4px 14px rgba(36,28,31,0.25);
  text-align: center; animation: toast-in 0.2s ease-out;
}
@keyframes toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }

.receipt-header { display: flex; align-items: center; gap: 6px; font-family: 'Lexend', sans-serif; font-weight: 700; font-size: 13px; padding: 10px 0 8px; }
.receipt-count { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-weight: 500; color: var(--ink-soft); font-size: 12px; }
.receipt-list { display: flex; flex-direction: column; }
.receipt-row { padding: 9px 0; border-top: 1px dashed #C9C0AA; }
.receipt-row-editable { cursor: pointer; }
.receipt-row-editable:active { background: var(--paper-dark); }
.receipt-row-voided { opacity: 0.55; }
.receipt-row-voided .receipt-cat, .receipt-row-voided .receipt-amt { text-decoration: line-through; }
.row-badge { display: inline-block; font-size: 8.5px; font-weight: 700; letter-spacing: 0.3px; padding: 2px 5px; border-radius: 4px; margin-left: 6px; text-decoration: none; vertical-align: middle; }
.row-badge-voided { background: var(--danger-bg); color: var(--danger); }
.row-badge-backfill { background: #E3F4F5; color: var(--rule-blue); }
.row-badge-edited { background: var(--paper-dark); color: var(--ink-soft); }
.backfill-note { background: #E3F4F5; color: var(--rule-blue); font-size: 11px; font-weight: 600; padding: 8px 12px; border-radius: 8px; margin-bottom: 10px; }
.field-static-row { font-size: 11px; color: var(--ink-soft); margin: 10px 0; }

.receipt-row:first-child { border-top: none; }
.receipt-row-top { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; }
.receipt-amt { font-family: 'Epilogue', sans-serif; font-weight: 500; }
.amt-in { color: var(--success); }
.amt-out { color: var(--danger); }
.receipt-row-bottom { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--ink-soft); margin-top: 2px; }
.empty-state { text-align: center; font-size: 12px; color: var(--ink-soft); padding: 20px 0; }

.modal-overlay { position: fixed; inset: 0; background: rgba(33,29,22,0.55); display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
.modal-card { background: var(--paper); width: 100%; max-width: 480px; max-height: 88vh; overflow-y: auto; border-radius: 18px 18px 0 0; padding: 18px; }
.modal-wide { max-width: 480px; }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.modal-title { font-family: 'Lexend', sans-serif; font-weight: 700; font-size: 16px; }
.modal-sub { font-size: 12px; color: var(--ink-soft); margin: 4px 0 12px; }
.modal-body { padding-bottom: 4px; }

.toggle-row { display: flex; gap: 8px; margin-bottom: 10px; }
.toggle-btn { flex: 1; padding: 9px; border-radius: 9px; border: 1px solid var(--paper-dark); background: #fff; font-weight: 600; font-size: 12px; cursor: pointer; font-family: inherit; }
.toggle-on-green { background: var(--success-bg); border-color: var(--success); color: var(--success); }
.toggle-on-red { background: var(--danger-bg); border-color: var(--danger); color: var(--danger); }
.toggle-on-blue { background: #E3F4F5; border-color: var(--rule-blue); color: var(--rule-blue); }

.field-label { display: block; font-size: 11px; font-weight: 600; color: var(--ink-soft); margin: 10px 0 4px; }
.field-input { width: 100%; border: 1px solid var(--paper-dark); background: #fff; border-radius: 9px; padding: 9px 11px; font-size: 13px; font-family: inherit; color: var(--ink); }
.mono-input { font-family: 'Epilogue', sans-serif; }

.emp-list { display: flex; flex-direction: column; gap: 8px; }
.emp-row { display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid var(--paper-dark); border-radius: 10px; padding: 8px 10px; }
.emp-row-info { flex: 1; }
.emp-row-name { font-size: 13px; font-weight: 600; }
.emp-row-role { font-size: 11px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; }

.hours-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 4px; border-top: 1px dashed #C9C0AA; }
.hours-row:first-child { border-top: none; }
.hours-row-name { font-size: 13px; font-weight: 600; }
.hours-row-value { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: var(--ink-soft); }

.digest-range { font-size: 11px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace; margin-top: 2px; }
.digest-top-categories { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #C9C0AA; }
.digest-top-label { font-size: 10.5px; font-weight: 700; color: var(--ink-soft); margin-bottom: 4px; }
.digest-top-row { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }

.cat-list { display: flex; flex-direction: column; gap: 12px; padding: 6px 2px 2px; }
.cat-row-top { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.cat-bar-track { height: 7px; border-radius: 4px; background: var(--paper-dark); overflow: hidden; }
.cat-bar-fill { height: 100%; border-radius: 4px; }

.export-btn-list { display: flex; flex-direction: column; gap: 8px; padding-top: 6px; }

.divider { height: 1px; background: var(--paper-dark); margin: 16px 0; }

.close-summary { background: #fff; border: 1px solid var(--paper-dark); border-radius: 10px; padding: 10px 14px; }
.close-row { display: flex; justify-content: space-between; font-size: 12.5px; padding: 5px 0; }
.close-row-total { border-top: 1px dashed #C9C0AA; margin-top: 4px; padding-top: 8px; font-weight: 700; }
.mono-val { font-family: 'Epilogue', sans-serif; }

.denom-grid { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.denom-row { display: grid; grid-template-columns: 44px 1fr 80px; align-items: center; gap: 8px; }
.denom-label { font-family: 'Epilogue', sans-serif; font-weight: 500; font-size: 13px; }
.denom-input { text-align: center; }
.denom-subtotal { font-family: 'Epilogue', sans-serif; font-size: 11px; color: var(--ink-soft); text-align: right; }

.diff-line { text-align: center; font-size: 12px; font-weight: 600; padding: 6px; border-radius: 8px; margin-top: 6px; }
.diff-even { background: var(--success-bg); color: var(--success); }
.diff-over { background: #E3F4F5; color: var(--rule-blue); }
.diff-short { background: var(--danger-bg); color: var(--danger); }

.photo-preview { width: 100%; max-height: 220px; object-fit: cover; border-radius: 10px; margin-top: 8px; border: 1px solid var(--paper-dark); }
.confirm-checkbox-row { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; font-size: 12.5px; color: var(--ink); cursor: pointer; }
.confirm-checkbox-row input { margin-top: 2px; width: 16px; height: 16px; flex-shrink: 0; }

.closing-note { background: var(--paper-dark); border-radius: 10px; padding: 10px 14px; margin-top: 12px; font-size: 12.5px; }
.closing-note-label { font-weight: 700; font-size: 11px; color: var(--ink-soft); margin-bottom: 3px; }
.closing-note-inline { font-size: 11px; color: var(--ink-soft); margin-top: 3px; font-style: italic; }
.photo-link { display: inline-block; font-size: 11px; color: var(--rule-blue); font-weight: 600; margin-top: 4px; }



.bottom-nav {
  display: flex; gap: 4px; margin: 16px -16px -16px; padding: 8px 8px calc(8px + env(safe-area-inset-bottom, 0px));
  background: #fff; border-top: 1px solid var(--paper-dark); border-radius: 0 0 16px 16px;
  position: sticky; bottom: 0;
}
.nav-btn {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 4px;
  background: none; border: none; border-radius: 10px; color: var(--ink-soft); font-family: inherit; font-size: 10.5px; font-weight: 600; cursor: pointer;
}
.nav-btn-active { color: var(--rule-blue); background: #E3F4F5; }

.view-panel { padding-bottom: 4px; }
.view-panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.view-panel-title { font-family: 'Lexend', sans-serif; font-weight: 700; font-size: 18px; }
.clear-filter-link { background: none; border: none; color: var(--rule-blue); font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }

.view-more-link {
  width: 100%; background: none; border: none; color: var(--rule-blue); font-size: 12px; font-weight: 600;
  cursor: pointer; font-family: inherit; display: flex; align-items: center; justify-content: center; gap: 3px; padding: 8px 0 2px;
}

.date-group { margin-top: 16px; }
.date-group:first-child { margin-top: 8px; }
.date-group-heading { font-size: 12px; font-weight: 700; color: var(--ink-soft); margin-bottom: 6px; padding-left: 2px; }

.report-row { background: #fff; border: 1px solid var(--paper-dark); border-radius: 10px; padding: 9px 12px; }
.report-row-top { display: flex; justify-content: space-between; font-size: 12.5px; font-weight: 600; }
.report-row-date { font-family: 'IBM Plex Mono', monospace; font-weight: 500; color: var(--ink-soft); font-size: 11px; }
.report-row-bottom { display: flex; justify-content: space-between; font-size: 11px; color: var(--ink-soft); margin-top: 3px; }
`;

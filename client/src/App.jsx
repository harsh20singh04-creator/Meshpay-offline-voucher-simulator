import { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, BadgeCheck, Banknote,
  Check, CheckCircle2, ChevronDown, CircleAlert, Clock3, Copy, Download, Fingerprint,
  Gauge, Globe, KeyRound, LayoutDashboard, LockKeyhole, LogOut, Menu, RadioTower,
  RefreshCw, Send, Shield, ShieldCheck, Smartphone, Sparkles, Wallet, Wifi, WifiOff, X,
} from 'lucide-react';
import { ApiError, api, formatDate, formatINR, postJson, rupeesToPaise } from './lib/api.js';
import {
  createSignedVoucher, getOfflineDeviceStatus, importVoucherPacket, initializeOfflineDevice,
  getRecipientContact, listLocalVouchers, saveRecipientContact, syncIncomingVouchers, updateOfflineDeviceEpoch,
} from './lib/offlineVault.js';

const NAV = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'send', label: 'Send money', icon: Send },
  { id: 'offline', label: 'Offline vault', icon: RadioTower },
  { id: 'activity', label: 'Activity & ledger', icon: Activity },
  { id: 'security', label: 'Security center', icon: ShieldCheck },
];
const CACHE_KEY = 'meshpay.safe-profile.v1';

function safeCachedUser() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}
function cacheUser(user) {
  if (user) localStorage.setItem(CACHE_KEY, JSON.stringify(user));
  else localStorage.removeItem(CACHE_KEY);
}
function moneyFromInput(value) {
  const parsed = rupeesToPaise(value);
  if (parsed === null) throw new Error('Enter a valid amount with up to two decimal places.');
  return parsed;
}

function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}>
    <div className="brand-mark"><RadioTower size={20} strokeWidth={2.3} /></div>
    {!compact && <div><div className="brand-name">mesh<span>pay</span></div><div className="brand-tag">OFFLINE PAYMENT LAB</div></div>}
  </div>;
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault(); setError(''); setPending(true);
    try {
      const body = mode === 'register' ? { displayName, handle: handle.toLowerCase().trim(), password } : { handle: handle.toLowerCase().trim(), password };
      const result = await postJson(`/api/auth/${mode}`, body);
      cacheUser(result.user); onAuthenticated(result.user);
    } catch (err) { setError(err.message || 'Unable to sign in.'); }
    finally { setPending(false); }
  }

  return <div className="auth-shell">
    <div className="auth-ambient ambient-one" /><div className="auth-ambient ambient-two" />
    <header className="auth-top"><Brand /><div className="auth-top-note"><ShieldCheck size={16} /> Security-first demo environment</div></header>
    <main className="auth-main">
      <section className="auth-copy">
        <div className="eyebrow"><span className="eyebrow-dot" /> BUILT FOR RESILIENT PAYMENTS</div>
        <h1>Payments that keep moving.<br /><span>Even when networks don't.</span></h1>
        <p>A full-stack offline voucher and settlement lab exploring cryptographic device identity, replay resistance, idempotency, and consistent ledgers.</p>
        <div className="auth-feature-list">
          <div><span className="feature-icon"><LockKeyhole size={17} /></span><span><strong>Cryptographically signed</strong><small>Ed25519 signatures + RSA-OAEP/AES-GCM encryption</small></span></div>
          <div><span className="feature-icon"><ShieldCheck size={17} /></span><span><strong>Replay-aware settlement</strong><small>Unique voucher IDs and device sequences</small></span></div>
          <div><span className="feature-icon"><ArrowLeftRight size={17} /></span><span><strong>Transactional ledger</strong><small>Atomic balance updates in MongoDB</small></span></div>
        </div>
        <div className="auth-disclaimer"><CircleAlert size={16} /> Portfolio simulator only. No bank connection or real UPI transactions.</div>
      </section>
      <section className="auth-card">
        <div className="auth-card-heading"><div className="auth-card-icon"><Fingerprint size={21} /></div><div><h2>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h2><p>{mode === 'login' ? 'Sign in to your MeshPay wallet.' : 'Get a sandbox wallet with demo funds.'}</p></div></div>
        <form onSubmit={submit} className="stack-form">
          {mode === 'register' && <label className="field"><span>Display name</span><input autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Alex Morgan" minLength={2} maxLength={60} required /></label>}
          <label className="field"><span>Payment handle</span><div className="input-prefix"><span>@</span><input autoComplete="username" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="alex.morgan" minLength={3} maxLength={24} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]" required /></div><small>3–24 letters, numbers, dots, dashes or underscores.</small></label>
          <label className="field"><span>Password</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'login' ? 'Enter your password' : 'At least 10 characters'} minLength={mode === 'login' ? 1 : 10} maxLength={72} required /></label>
          {error && <div className="inline-error"><CircleAlert size={16} /> {error}</div>}
          <button className="btn btn-primary btn-full" disabled={pending}>{pending ? 'Please wait…' : mode === 'login' ? 'Sign in securely' : 'Create sandbox account'} <ArrowRight size={17} /></button>
        </form>
        <div className="auth-switch">{mode === 'login' ? 'New to MeshPay?' : 'Already registered?'} <button className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></div>
        <div className="demo-credit"><Sparkles size={15} /> New accounts receive simulated demo funds.</div>
      </section>
    </main>
    <footer className="auth-footer"><span>MESHPAY · SECURITY ENGINEERING DEMO</span><span>Designed for learning, not for real money.</span></footer>
  </div>;
}

function StatCard({ title, value, subtitle, icon: Icon, tone = 'blue' }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}><Icon size={19} /></div><div className="stat-title">{title}</div><div className="stat-value">{value}</div><div className="stat-subtitle">{subtitle}</div></div>;
}

function StatusPill({ children, tone = 'green' }) { return <span className={`status-pill ${tone}`}><span className="status-dot" />{children}</span>; }

function TransactionRow({ transaction, currentHandle }) {
  const isIncoming = transaction.direction === 'received';
  const isReserve = transaction.kind === 'reserve' || transaction.kind === 'release';
  const isRelease = transaction.kind === 'release';
  const icon = isReserve ? Wallet : isIncoming ? ArrowDownLeft : ArrowUpRight;
  const Icon = icon;
  const otherParty = isReserve ? (isRelease ? 'Returned to available balance' : 'Offline reserve') : isIncoming ? `From @${transaction.sender.handle}` : `To @${transaction.receiver.handle}`;
  return <div className="transaction-row">
    <div className={`transaction-icon ${isIncoming || isReserve ? 'incoming' : 'outgoing'}`}><Icon size={18} /></div>
    <div className="transaction-main"><strong>{isRelease ? 'Unused offline reserve released' : transaction.kind === 'reserve' ? 'Funds reserved for offline use' : isIncoming ? transaction.sender.displayName : transaction.receiver.displayName}</strong><span>{otherParty} · {transaction.kind === 'offline' ? 'Offline voucher' : isReserve ? 'Vault movement' : 'Instant transfer'}</span></div>
    <div className="transaction-amount"><strong className={isIncoming || isRelease ? 'positive' : transaction.kind === 'reserve' ? '' : 'negative'}>{isIncoming || isRelease ? '+' : transaction.kind === 'reserve' ? '↗ ' : '−'}{formatINR(transaction.amountPaise)}</strong><small>{formatDate(transaction.createdAt)}</small></div>
  </div>;
}

function EmptyState({ icon: Icon = Activity, title, detail }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={22} /></div><strong>{title}</strong><p>{detail}</p></div>;
}

export default function App() {
  const [user, setUser] = useState(() => safeCachedUser());
  const [active, setActive] = useState('overview');
  const [wallet, setWallet] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [offlineStatus, setOfflineStatus] = useState(null);
  const [localVouchers, setLocalVouchers] = useState([]);
  const [deviceStatus, setDeviceStatus] = useState({ ready: false, deviceId: null, sequence: 0 });
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [notice, setNotice] = useState(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [transferForm, setTransferForm] = useState({ receiverHandle: '', amount: '', note: '' });
  const [reserveAmount, setReserveAmount] = useState('');
  const [voucherForm, setVoucherForm] = useState({ receiverHandle: '', amount: '', memo: '' });
  const [importText, setImportText] = useState('');
  const [latestPacket, setLatestPacket] = useState('');
  const [working, setWorking] = useState('');
  const [transferIdempotencyKey, setTransferIdempotencyKey] = useState(() => crypto.randomUUID());
  const [reserveIdempotencyKey, setReserveIdempotencyKey] = useState(() => crypto.randomUUID());
  const [releaseIdempotencyKey, setReleaseIdempotencyKey] = useState(() => crypto.randomUUID());
  const [scanCamera, setScanCamera] = useState(false);
  const [reconciliation, setReconciliation] = useState(null);

  const setAuthenticated = useCallback((nextUser) => { cacheUser(nextUser); setUser(nextUser); setNotice({ type: 'success', message: `Welcome, ${nextUser.displayName}.` }); }, []);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!user?.id) return;
    if (!quiet) setLoading(true);
    try {
      const [walletResult, transactionResult, statusResult] = await Promise.all([
        api('/api/wallet'), api('/api/transactions?limit=50'), api('/api/offline/status'),
      ]);
      setWallet(walletResult); setTransactions(transactionResult.transactions); setOfflineStatus(statusResult); setOnline(true);
      await updateOfflineDeviceEpoch(user.id, statusResult.offlineEpoch);
      if (walletResult.user) { setUser(walletResult.user); cacheUser(walletResult.user); }
    } catch (error) {
      if (error.status === 401) { cacheUser(null); setUser(null); }
      if (!quiet) setNotice({ type: 'warning', message: error.message || 'Could not refresh data.' });
      if (error.code === 'NETWORK_UNAVAILABLE') setOnline(false);
    } finally { setLoading(false); }
  }, [user?.id]);

  const refreshLocal = useCallback(async () => {
    if (!user?.id) return;
    try { setLocalVouchers(await listLocalVouchers(user.id)); setDeviceStatus(await getOfflineDeviceStatus(user.id)); }
    catch { /* IndexedDB may be unavailable in private browsing; the online wallet still works. */ }
  }, [user?.id]);

  useEffect(() => {
    const goOnline = () => { setOnline(true); if (user?.id) refresh({ quiet: true }); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline); window.addEventListener('offline', goOffline);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, [refresh, user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    refresh({ quiet: true });
    refreshLocal();
    initializeOfflineDevice(user, postJson, api).then(async (status) => {
      if (!cancelled) setDeviceStatus(status);
      await refreshLocal();
    }).catch((error) => {
      if (error.code === 'NETWORK_UNAVAILABLE') setOnline(false);
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  useEffect(() => {
    if (!scanCamera) return undefined;
    let scanner;
    try {
      scanner = new Html5QrcodeScanner('meshpay-qr-reader', { fps: 8, qrbox: { width: 280, height: 280 }, aspectRatio: 1 }, false);
      scanner.render((decodedText) => {
        setImportText(decodedText);
        setScanCamera(false);
        setNotice({ type: 'success', message: 'QR scanned. Review the imported voucher JSON, then import it to your vault.' });
      }, () => {});
    } catch {
      setScanCamera(false);
      setNotice({ type: 'error', message: 'Camera scanner could not start. Check browser camera permission or paste the voucher JSON instead.' });
    }
    return () => { if (scanner) scanner.clear().catch(() => {}); };
  }, [scanCamera]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const recentTransactions = useMemo(() => transactions.slice(0, 5), [transactions]);
  const totalVolumePaise = useMemo(() => transactions.filter((item) => item.direction === 'sent' || item.kind === 'offline').reduce((sum, item) => sum + item.amountPaise, 0), [transactions]);

  async function handleLogout() {
    try { await postJson('/api/auth/logout', {}); } catch { /* Local profile still clears when offline. */ }
    cacheUser(null); setUser(null); setWallet(null); setTransactions([]); setOfflineStatus(null); setActive('overview');
  }

  async function sendPayment(event) {
    event.preventDefault(); setNotice(null); setWorking('send');
    try {
      const amountPaise = moneyFromInput(transferForm.amount);
      const result = await postJson('/api/transfers', { receiverHandle: transferForm.receiverHandle.toLowerCase().trim(), amountPaise, note: transferForm.note }, { 'Idempotency-Key': transferIdempotencyKey });
      setNotice({ type: 'success', message: `${formatINR(result.transfer.amountPaise)} sent. Transfer ID: ${result.transfer.transferId.slice(0, 8)}…` });
      setTransferForm({ receiverHandle: '', amount: '', note: '' }); setTransferIdempotencyKey(crypto.randomUUID()); await refresh({ quiet: true }); setActive('overview');
    } catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setWorking(''); }
  }

  async function reserveFunds(event) {
    event.preventDefault(); setWorking('reserve'); setNotice(null);
    try {
      const amountPaise = moneyFromInput(reserveAmount);
      await postJson('/api/offline/reserve', { amountPaise }, { 'Idempotency-Key': reserveIdempotencyKey });
      setReserveAmount(''); setReserveIdempotencyKey(crypto.randomUUID()); setNotice({ type: 'success', message: `${formatINR(amountPaise)} moved to your offline reserve. It is no longer available for online spending.` });
      await refresh({ quiet: true });
    } catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setWorking(''); }
  }

  async function releaseFunds() {
    const ok = window.confirm('Return all unused offline reserve to your available balance? This revokes every unsubmitted voucher created under the current offline epoch. Recipients with those vouchers will not be able to settle them.');
    if (!ok) return;
    setWorking('release'); setNotice(null);
    try {
      const result = await postJson('/api/offline/release', {}, { 'Idempotency-Key': releaseIdempotencyKey });
      setReleaseIdempotencyKey(crypto.randomUUID());
      await updateOfflineDeviceEpoch(user.id, result.release.offlineEpoch);
      await refresh({ quiet: true }); await refreshLocal();
      setNotice({ type: 'success', message: `${formatINR(result.release.amountPaise)} returned to available balance. Previously created, unsubmitted vouchers were revoked.` });
    } catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setWorking(''); }
  }

  async function cacheRecipientKey() {
    setWorking('cache-contact'); setNotice(null);
    try {
      if (!online) throw new Error('Connect to the internet to cache the recipient device key first.');
      const handle = voucherForm.receiverHandle.trim().toLowerCase();
      if (handle.length < 3) throw new Error('Enter the recipient handle first.');
      const result = await api(`/api/offline/contacts?handle=${encodeURIComponent(handle)}`);
      await saveRecipientContact(user.id, result.contact);
      setNotice({ type: 'success', message: `Cached an encryption key for @${result.contact.handle}. You can now create an encrypted voucher for this device.` });
    } catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setWorking(''); }
  }

  async function generateVoucher(event) {
    event.preventDefault(); setWorking('voucher'); setNotice(null);
    try {
      const amountPaise = moneyFromInput(voucherForm.amount);
      const receiverHandle = voucherForm.receiverHandle.trim().toLowerCase();
      const maxTransferPaise = wallet?.limits?.maxTransferPaise || 2000000;
      if (amountPaise > maxTransferPaise) throw new Error(`Voucher amount exceeds the configured limit of ${formatINR(maxTransferPaise)}.`);
      if (amountPaise > reservedBalance) throw new Error('This voucher exceeds the currently known offline reserve. Reserve more funds while online first.');
      let contact;
      if (online) {
        try {
          const result = await api(`/api/offline/contacts?handle=${encodeURIComponent(receiverHandle)}`);
          contact = await saveRecipientContact(user.id, result.contact);
        } catch (error) {
          if (error.code !== 'NETWORK_UNAVAILABLE') throw error;
          contact = await getRecipientContact(user.id, receiverHandle);
        }
      } else contact = await getRecipientContact(user.id, receiverHandle);
      if (!contact?.devices?.length) throw new Error('Recipient device key is not cached. While online, enter the recipient handle and press “Cache key”; the recipient must also open MeshPay online once.');
      const recipientDevice = contact.devices[0];
      const packet = await createSignedVoucher({ user, receiverHandle, recipientDeviceId: recipientDevice.deviceId, recipientEncryptionPublicKeySpki: recipientDevice.encryptionPublicKeySpki, amountPaise, memo: voucherForm.memo, ttlHours: wallet?.limits?.offlineVoucherTtlHours || 72 });
      const text = JSON.stringify(packet, null, 2); setLatestPacket(text); setVoucherForm({ receiverHandle: '', amount: '', memo: '' }); await refreshLocal();
      setNotice({ type: 'success', message: `Encrypted voucher created for @${receiverHandle}. The recipient can decrypt it only on the registered target device; settlement remains provisional until sync.` });
    } catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setWorking(''); }
  }

  async function importVoucher(event) {
    event.preventDefault(); setWorking('import'); setNotice(null);
    try {
      const result = await importVoucherPacket(importText, user); setImportText(''); await refreshLocal();
      setNotice({ type: 'success', message: result.duplicate ? 'This voucher is already in your local vault.' : 'Voucher imported. It is provisional until server verification and settlement.' });
    } catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setWorking(''); }
  }

  async function syncVouchers() {
    setWorking('sync'); setNotice(null);
    try {
      const results = await syncIncomingVouchers(user, (packet) => postJson('/api/offline/sync', packet));
      await refresh({ quiet: true }); await refreshLocal();
      const settled = results.filter((x) => x.status === 'settled').length;
      const rejected = results.filter((x) => x.status === 'rejected').length;
      setNotice({ type: rejected ? 'warning' : 'success', message: results.length ? `Sync complete: ${settled} settled, ${rejected} rejected, ${results.filter((x) => x.status === 'pending-sync').length} still pending.` : 'No incoming vouchers are waiting to sync.' });
    } catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setWorking(''); }
  }

  async function runLedgerReconciliation() {
    setWorking('reconcile'); setNotice(null);
    try {
      const result = await api('/api/ledger/reconcile');
      setReconciliation(result.report);
      setNotice({ type: result.report.consistent ? 'success' : 'error', message: result.report.consistent ? 'Ledger totals match the current wallet balances.' : 'Ledger mismatch detected. Review the reconciliation details.' });
    } catch (error) { setNotice({ type: 'error', message: error.message }); }
    finally { setWorking(''); }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); setNotice({ type: 'success', message: 'Copied to clipboard.' }); }
    catch { setNotice({ type: 'warning', message: 'Clipboard permission was blocked. Select the voucher text and copy it manually.' }); }
  }

  if (!user) return <AuthScreen onAuthenticated={setAuthenticated} />;

  const currentBalance = wallet?.user?.balancePaise ?? user.balancePaise ?? 0;
  const reservedBalance = wallet?.user?.offlineReservedPaise ?? user.offlineReservedPaise ?? 0;
  const activeLabel = NAV.find((item) => item.id === active)?.label || 'Overview';

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand"><Brand /></div>
      <div className="workspace-chip"><div className="workspace-avatar">{user.displayName.slice(0, 1).toUpperCase()}</div><div><strong>{user.displayName}</strong><small>@{user.handle}</small></div><ChevronDown size={15} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        {NAV.map(({ id, label, icon: Icon }) => <button className={`nav-item ${active === id ? 'active' : ''}`} key={id} onClick={() => { setActive(id); setMobileNav(false); }}><Icon size={18} /><span>{label}</span>{id === 'offline' && <span className="nav-badge">LAB</span>}</button>)}
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-security"><div className="security-small-icon"><ShieldCheck size={18} /></div><strong>Security by design</strong><p>Signed vouchers, replay controls and atomic settlement.</p><button onClick={() => setActive('security')}>View controls <ArrowRight size={14} /></button></div>
      <div className="sidebar-bottom"><span className="avatar-mini">{user.displayName.slice(0, 1).toUpperCase()}</span><div className="sidebar-account"><strong>{user.displayName}</strong><small>Sandbox account</small></div><button title="Sign out" className="icon-button" onClick={handleLogout}><LogOut size={17} /></button></div>
    </aside>
    {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="mobile-menu icon-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><div><div className="breadcrumb">Workspace <span>/</span> <strong>{activeLabel}</strong></div><div className="page-heading-small">{activeLabel}</div></div></div><div className="topbar-actions"><span className={`connection-status ${online ? 'is-online' : 'is-offline'}`}>{online ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{online ? 'Connected' : 'Offline mode'}</span></span><button className="icon-button refresh-button" title="Refresh data" onClick={() => refresh()} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button><div className="topbar-avatar">{user.displayName.slice(0, 1).toUpperCase()}</div></div></header>
      <div className="page-container">
        {!online && <div className="offline-banner"><WifiOff size={18} /><div><strong>You are offline</strong><span>Existing signed vouchers and the local vault are available. Online transfers and settlement need a connection.</span></div></div>}
        {notice && <div className={`toast toast-${notice.type}`} role="status"><span className="toast-symbol">{notice.type === 'success' ? <CheckCircle2 size={18} /> : notice.type === 'warning' ? <CircleAlert size={18} /> : <X size={18} />}</span><span>{notice.message}</span><button onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={16} /></button></div>}
        {active === 'overview' && <>
          <section className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-dot" /> WALLET OVERVIEW</div><h1>Good to see you, {user.displayName.split(' ')[0]}.</h1><p>Here is the current state of your payment workspace.</p></div><button className="btn btn-primary" onClick={() => setActive('send')}><Send size={16} /> New transfer</button></section>
          <section className="stats-grid">
            <StatCard title="Available balance" value={formatINR(currentBalance)} subtitle="Ready for online transfers" icon={Wallet} tone="blue" />
            <StatCard title="Offline reserve" value={formatINR(reservedBalance)} subtitle="Pre-authorized offline allowance" icon={RadioTower} tone="purple" />
            <StatCard title="Transactions shown" value={transactions.length.toString().padStart(2, '0')} subtitle="Most recent ledger activity" icon={ArrowLeftRight} tone="green" />
            <StatCard title="Offline device" value={deviceStatus.ready ? 'Registered' : 'Setup needed'} subtitle={deviceStatus.deviceId ? `${deviceStatus.deviceId.slice(0, 8)}…` : 'Open Offline Vault to initialize'} icon={Smartphone} tone="amber" />
          </section>
          <section className="overview-grid">
            <div className="panel activity-panel"><div className="panel-header"><div><h2>Recent activity</h2><p>Your latest wallet movements.</p></div><button className="link-button" onClick={() => setActive('activity')}>View all <ArrowRight size={15} /></button></div>
              {recentTransactions.length ? <div className="transaction-list">{recentTransactions.map((transaction) => <TransactionRow key={transaction.transferId} transaction={transaction} currentHandle={user.handle} />)}</div> : <EmptyState title="No activity yet" detail="Your transfers and reserve movements will appear here." />}
            </div>
            <div className="panel quick-panel"><div className="panel-header"><div><h2>Quick actions</h2><p>Jump back into your workflow.</p></div></div>
              <button className="quick-action" onClick={() => setActive('send')}><span className="quick-action-icon quick-blue"><Send size={18} /></span><span><strong>Send money</strong><small>Atomic, idempotent transfer</small></span><ArrowRight size={16} /></button>
              <button className="quick-action" onClick={() => setActive('offline')}><span className="quick-action-icon quick-purple"><RadioTower size={18} /></span><span><strong>Offline voucher</strong><small>Create or sync a signed voucher</small></span><ArrowRight size={16} /></button>
              <button className="quick-action" onClick={() => setActive('security')}><span className="quick-action-icon quick-green"><ShieldCheck size={18} /></span><span><strong>Security controls</strong><small>Review replay and ledger safety</small></span><ArrowRight size={16} /></button>
              <div className="quick-footnote"><LockKeyhole size={14} /> Transactions use MongoDB multi-document transactions.</div>
            </div>
          </section>
          <section className="bottom-note"><div className="note-icon"><CircleAlert size={17} /></div><div><strong>Offline receipts are provisional</strong><p>Disconnected devices cannot know whether another recipient received a copy of the same spend. Only the online settlement service can finalize the voucher against the shared reserve.</p></div><button className="link-button" onClick={() => setActive('security')}>Why this matters <ArrowRight size={15} /></button></section>
        </>}

        {active === 'send' && <>
          <section className="page-intro"><div className="eyebrow"><span className="eyebrow-dot" /> ONLINE SETTLEMENT</div><h1>Send money</h1><p>Balances update inside one database transaction. Reuse an idempotency key when retrying the same logical request.</p></section>
          <div className="form-layout"><section className="panel form-panel"><div className="form-panel-title"><div className="form-feature-icon blue"><Send size={19} /></div><div><h2>New transfer</h2><p>Sandbox wallet transfer</p></div></div>
            <form className="stack-form" onSubmit={sendPayment}>
              <label className="field"><span>Recipient handle</span><div className="input-prefix"><span>@</span><input value={transferForm.receiverHandle} onChange={(e) => { setTransferForm({ ...transferForm, receiverHandle: e.target.value }); setTransferIdempotencyKey(crypto.randomUUID()); }} placeholder="friend.handle" minLength={3} maxLength={24} autoCapitalize="none" required /></div><small>Use the handle of another registered MeshPay account.</small></label>
              <label className="field"><span>Amount (INR)</span><div className="rupee-input"><span>₹</span><input type="number" min="0.01" max={(wallet?.limits?.maxTransferPaise || 2000000) / 100} step="0.01" value={transferForm.amount} onChange={(e) => { setTransferForm({ ...transferForm, amount: e.target.value }); setTransferIdempotencyKey(crypto.randomUUID()); }} placeholder="0.00" required /></div><small>Maximum per transfer: {formatINR(wallet?.limits?.maxTransferPaise || 2000000)}.</small></label>
              <label className="field"><span>Note <small>(optional)</small></span><input value={transferForm.note} onChange={(e) => { setTransferForm({ ...transferForm, note: e.target.value }); setTransferIdempotencyKey(crypto.randomUUID()); }} placeholder="What's this for?" maxLength={120} /></label>
              <div className="form-review"><div><span>Payment route</span><strong><Globe size={15} /> Online · Atomic settlement</strong></div><div><span>Available balance</span><strong>{formatINR(currentBalance)}</strong></div></div>
              <button className="btn btn-primary btn-full btn-tall" disabled={working === 'send' || !online}>{working === 'send' ? 'Processing securely…' : 'Review & send'} <ArrowRight size={17} /></button>
              {!online && <p className="form-warning"><WifiOff size={15} /> Online transfers are disabled while offline. Use an already provisioned Offline Vault voucher.</p>}
            </form>
          </section>
          <aside className="side-explainer"><div className="explainer-graphic"><div className="explainer-node node-a"><Wallet size={20} /></div><div className="explainer-line" /><div className="explainer-shield"><ShieldCheck size={24} /></div><div className="explainer-line" /><div className="explainer-node node-b"><Banknote size={20} /></div></div><h3>Every payment has a safety net.</h3><p>The transfer service debits the sender only if the balance is sufficient, credits the recipient, and writes both ledger entries in the same MongoDB transaction.</p><div className="explainer-check"><Check size={15} /> Atomic balance updates</div><div className="explainer-check"><Check size={15} /> Idempotency key on every request</div><div className="explainer-check"><Check size={15} /> Unique database constraints</div></aside></div>
        </>}

        {active === 'offline' && <>
          <section className="page-intro"><div className="eyebrow"><span className="eyebrow-dot purple-dot" /> OFFLINE VOUCHER LAB</div><h1>Offline Vault</h1><p>Provision funds while online, sign a voucher locally, hand it to the recipient, then sync for settlement.</p></section>
          <div className="offline-explainer"><div className="offline-explainer-icon"><RadioTower size={22} /></div><div><strong>How offline handoff works in this demo</strong><p>Both users must initialize their device keys while online. Cache the recipient key before going off-grid. The QR contains an AES-256-GCM encrypted voucher for that specific device; direct QR/file handoff is the transport, not Bluetooth or a production mesh. Settlement is final only after sync.</p></div><StatusPill tone={online ? 'green' : 'amber'}>{online ? 'Network available' : 'Local-only mode'}</StatusPill></div>
          <div className="offline-grid">
            <section className="panel vault-panel"><div className="panel-section-heading"><div className="panel-icon purple"><Wallet size={18} /></div><div><h2>1. Reserve an offline allowance</h2><p>Moves funds out of your spendable balance.</p></div></div>
              <div className="reserve-balance"><span>Currently reserved</span><strong>{formatINR(reservedBalance)}</strong></div>
              <form className="stack-form" onSubmit={reserveFunds}><label className="field"><span>Reserve amount (INR)</span><div className="rupee-input"><span>₹</span><input type="number" min="0.01" max={(wallet?.limits?.maxTransferPaise || 2000000) / 100} step="0.01" value={reserveAmount} onChange={(e) => { setReserveAmount(e.target.value); setReserveIdempotencyKey(crypto.randomUUID()); }} placeholder="0.00" required /></div></label><button className="btn btn-secondary btn-full" disabled={working === 'reserve' || !online}>{working === 'reserve' ? 'Reserving…' : 'Reserve funds'} <ArrowRight size={16} /></button></form>
              <button className="btn btn-link-danger btn-full" onClick={releaseFunds} disabled={working === 'release' || !online || reservedBalance <= 0}>{working === 'release' ? 'Releasing…' : 'Return unused reserve & revoke vouchers'} <RefreshCw size={15} /></button>
              <div className="small-info"><LockKeyhole size={14} /> Reserved funds cannot also be spent via online transfers.</div>
            </section>
            <section className="panel vault-panel"><div className="panel-section-heading"><div className="panel-icon blue"><Fingerprint size={18} /></div><div><h2>2. Create a signed voucher</h2><p>Signed by this browser's device key.</p></div></div>
              <form className="stack-form" onSubmit={generateVoucher}><label className="field"><span>Recipient handle</span><div className="input-prefix"><span>@</span><input autoCapitalize="none" value={voucherForm.receiverHandle} onChange={(e) => setVoucherForm({ ...voucherForm, receiverHandle: e.target.value })} placeholder="recipient.handle" minLength={3} maxLength={24} required /></div></label><button type="button" className="btn btn-secondary btn-full cache-key-button" onClick={cacheRecipientKey} disabled={!online || working === 'cache-contact'}>{working === 'cache-contact' ? 'Caching key…' : 'Cache recipient key while online'} <KeyRound size={15} /></button><small>The recipient must open MeshPay online once to register an encryption key. The cached key targets one specific browser/device.</small><div className="two-fields"><label className="field"><span>Amount (INR)</span><div className="rupee-input"><span>₹</span><input type="number" min="0.01" max={(wallet?.limits?.maxTransferPaise || 2000000) / 100} step="0.01" value={voucherForm.amount} onChange={(e) => setVoucherForm({ ...voucherForm, amount: e.target.value })} placeholder="0.00" required /></div></label><label className="field"><span>Memo</span><input value={voucherForm.memo} onChange={(e) => setVoucherForm({ ...voucherForm, memo: e.target.value })} placeholder="Optional" maxLength={100} /></label></div>
                <button className="btn btn-primary btn-full" disabled={working === 'voucher' || !deviceStatus.ready}>{working === 'voucher' ? 'Signing locally…' : 'Create signed voucher'} <Fingerprint size={17} /></button>
                {!deviceStatus.ready && <p className="form-warning"><CircleAlert size={15} /> Open this vault while online at least once to register the device key.</p>}
              </form>
              {latestPacket && <div className="packet-preview"><div className="packet-preview-top"><span><CheckCircle2 size={15} /> Voucher created</span><button className="icon-button" onClick={() => copyText(latestPacket)} title="Copy voucher JSON"><Copy size={15} /></button></div><div className="voucher-share-row"><div className="voucher-qr-box"><QRCodeSVG value={latestPacket} size={260} level="L" includeMargin /></div><div className="voucher-share-copy"><strong>Show this QR to the recipient</strong><p>The QR is encrypted to the recipient’s registered device. Only that browser can decrypt it; the receipt remains provisional until server sync.</p><button className="btn btn-secondary" onClick={() => copyText(latestPacket)}><Copy size={14} /> Copy JSON instead</button></div></div><details className="packet-raw"><summary>View encrypted voucher envelope</summary><pre>{latestPacket}</pre></details></div>}
            </section>
            <section className="panel vault-panel"><div className="panel-section-heading"><div className="panel-icon green"><Download size={18} /></div><div><h2>3. Import recipient voucher</h2><p>Paste the packet handed to this account.</p></div></div>
              <form className="stack-form" onSubmit={importVoucher}><label className="field"><span>Voucher packet (JSON)</span><textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'Paste signed voucher JSON here…'} rows={6} required /></label><button className="btn btn-secondary btn-full" disabled={working === 'import'}>{working === 'import' ? 'Validating packet…' : 'Import to local vault'} <Download size={16} /></button></form>
              <button type="button" className="btn btn-camera btn-full" onClick={() => setScanCamera(!scanCamera)}>{scanCamera ? <X size={15} /> : <Smartphone size={15} />}{scanCamera ? 'Close camera scanner' : 'Scan voucher QR with camera'}</button>
              {scanCamera && <div id="meshpay-qr-reader" className="qr-reader" />}
              <div className="small-info"><ShieldCheck size={14} /> Server validates the sender signature and receiver identity during sync.</div>
            </section>
            <section className="panel vault-panel sync-panel"><div className="panel-section-heading"><div className="panel-icon amber"><RefreshCw size={18} /></div><div><h2>4. Sync for settlement</h2><p>Duplicate vouchers never credit the receiver twice.</p></div></div>
              <div className="sync-status-grid"><div><span>Pending locally</span><strong>{localVouchers.filter((x) => x.direction === 'incoming' && x.status === 'pending-sync').length}</strong></div><div><span>Settled/rejected</span><strong>{localVouchers.filter((x) => x.direction === 'incoming' && x.status !== 'pending-sync').length}</strong></div></div>
              <button className="btn btn-primary btn-full" onClick={syncVouchers} disabled={working === 'sync' || !online}>{working === 'sync' ? 'Synchronizing…' : 'Sync incoming vouchers'} <RefreshCw size={16} /></button>
              {!online && <p className="form-warning"><WifiOff size={15} /> Settlement requires a connection to the shared ledger.</p>}
            </section>
          </div>
          <section className="panel local-vouchers-panel"><div className="panel-header"><div><h2>Local voucher history</h2><p>Stored in this browser's IndexedDB. Outgoing vouchers are not guaranteed to settle.</p></div><button className="link-button" onClick={refreshLocal}><RefreshCw size={14} /> Refresh local</button></div>
            {localVouchers.length ? <div className="local-voucher-list">{localVouchers.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => <div className="local-voucher-row" key={item.voucherId}><div className="voucher-kind-icon"><Fingerprint size={17} /></div><div className="local-voucher-main"><strong>{item.direction === 'outgoing' ? `To @${item.voucherPayload?.receiverHandle || 'unknown'}` : `From account ${item.voucherPayload?.senderId?.slice(0, 8) || 'unknown'}…`}</strong><small>{item.voucherId.slice(0, 16)}… · {formatDate(item.createdAt)}</small></div><strong className="local-voucher-amount">{formatINR(item.voucherPayload?.amountPaise || 0)}</strong><StatusPill tone={item.status === 'settled' ? 'green' : item.status === 'rejected' ? 'red' : 'amber'}>{item.status}</StatusPill>{item.direction === 'outgoing' && <button className="icon-button" onClick={() => copyText(JSON.stringify(item.packet, null, 2))} title="Copy outgoing voucher"><Copy size={15} /></button>}</div>)}</div> : <EmptyState icon={RadioTower} title="Your vault is clear" detail="Signed vouchers you create or import will appear here." />}
          </section>
        </>}

        {active === 'activity' && <>
          <section className="page-intro intro-with-action"><div><div className="eyebrow"><span className="eyebrow-dot" /> AUDIT TRAIL</div><h1>Activity & ledger</h1><p>Immutable transaction identifiers and ledger entries for each committed wallet movement.</p></div><button className="btn btn-secondary" onClick={() => refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh</button></section>
          <section className="panel activity-full-panel"><div className="panel-header"><div><h2>Transactions</h2><p>{transactions.length} recent wallet movements</p></div><StatusPill>{online ? 'Live data' : 'Last known data'}</StatusPill></div>
            {transactions.length ? <div className="transaction-list transaction-list-full">{transactions.map((transaction) => <TransactionRow key={transaction.transferId} transaction={transaction} currentHandle={user.handle} />)}</div> : <EmptyState title="No transactions yet" detail="Send money or reserve funds to create ledger activity." />}
          </section>
          <div className="ledger-footnote"><ShieldCheck size={17} /><span><strong>Accounting invariant:</strong> each settled payment writes both debit and credit entries in the same database transaction as the balance updates. A failed transaction leaves none of those changes committed.</span></div>
        </>}

        {active === 'security' && <>
          <section className="page-intro"><div className="eyebrow"><span className="eyebrow-dot green-dot" /> TRUST & SAFETY</div><h1>Security center</h1><p>Security controls implemented in the project—and the threat boundaries that remain.</p></section>
          <section className="security-score-panel"><div className="score-icon"><ShieldCheck size={27} /></div><div className="score-copy"><span>SECURITY POSTURE</span><h2>Defence in depth</h2><p>Multiple independent safeguards reduce the chance that a single application bug creates an inconsistent payment.</p></div><div className="score-pill"><CheckCircle2 size={16} /> Controls enabled</div></section>
          <section className="panel reconciliation-panel"><div className="reconciliation-copy"><div className="reconciliation-icon"><Activity size={19} /></div><div><h2>Ledger reconciliation</h2><p>Compare account balances with net ledger credit/debit totals, read in one MongoDB snapshot.</p></div></div><button className="btn btn-secondary" onClick={runLedgerReconciliation} disabled={working === 'reconcile' || !online}>{working === 'reconcile' ? 'Checking…' : 'Run reconciliation'} <RefreshCw size={15} className={working === 'reconcile' ? 'spin' : ''} /></button>{reconciliation && <div className="reconciliation-result"><StatusPill tone={reconciliation.consistent ? 'green' : 'red'}>{reconciliation.consistent ? 'Balances match' : 'Mismatch detected'}</StatusPill><span>Available delta: {formatINR(reconciliation.available.deltaPaise)}</span><span>Offline reserve delta: {formatINR(reconciliation.offlineReserve.deltaPaise)}</span><small>Checked {formatDate(reconciliation.checkedAt)}</small></div>}</section>
          <div className="security-grid">
            <div className="panel security-item"><div className="security-item-top"><span className="security-item-icon green"><LockKeyhole size={19} /></span><StatusPill>Enabled</StatusPill></div><h3>HttpOnly session cookie</h3><p>JWT is kept in an HttpOnly cookie rather than exposed to JavaScript. Cookies use SameSite=Lax and Secure in production.</p><small>Controls: session token theft via casual script access; some cross-site request risks.</small></div>
            <div className="panel security-item"><div className="security-item-top"><span className="security-item-icon blue"><ArrowLeftRight size={19} /></span><StatusPill>Enabled</StatusPill></div><h3>Atomic transfers</h3><p>MongoDB multi-document transactions update sender, receiver, transfer record, and both ledger entries together.</p><small>Controls: partial debit/credit, concurrent overspend on shared balance.</small></div>
            <div className="panel security-item"><div className="security-item-top"><span className="security-item-icon purple"><Fingerprint size={19} /></span><StatusPill>Enabled</StatusPill></div><h3>Signed, recipient-encrypted vouchers</h3><p>Ed25519 signs the voucher; AES-256-GCM encrypts it; RSA-OAEP wraps the per-voucher AES key for the recipient device. Private CryptoKeys are non-extractable in IndexedDB.</p><small>Controls: payload tampering, casual QR disclosure, and sender impersonation without the device signing key.</small></div>
            <div className="panel security-item"><div className="security-item-top"><span className="security-item-icon amber"><RefreshCw size={19} /></span><StatusPill>Enabled</StatusPill></div><h3>Replay & duplicate resistance</h3><p>Unique voucher IDs, unique device sequence numbers, unique idempotency keys, payload hashes, and transactional reserve debit stop duplicate settlement.</p><small>Controls: resubmission of a voucher or retry of the same API operation.</small></div>
            <div className="panel security-item"><div className="security-item-top"><span className="security-item-icon green"><Gauge size={19} /></span><StatusPill>Enabled</StatusPill></div><h3>Input and abuse controls</h3><p>Zod request validation, JSON body size limit, authentication rate limiting, global API limiting, Helmet headers, origin checking, and generic errors.</p><small>Controls: malformed input, brute-force pressure, common web attack surface.</small></div>
            <div className="panel security-item"><div className="security-item-top"><span className="security-item-icon blue"><Banknote size={19} /></span><StatusPill>Enabled</StatusPill></div><h3>Reserve-backed settlement</h3><p>Offline vouchers consume an online-reserved balance. If the shared reserve was already spent, later voucher is rejected rather than overdrawing it.</p><small>Controls: shared-ledger overspend; losing offline recipients may still hold provisional receipts.</small></div>
          </div>
          <section className="panel limitation-panel"><div className="limitation-icon"><CircleAlert size={21} /></div><div><h2>Important distributed-systems limitation</h2><p>When two devices are fully disconnected, neither can know whether the same offline spending authority was copied to another recipient. Software alone cannot guarantee global one-time acceptance across isolated devices. This project prevents a voucher from crediting the shared ledger twice and uses a pre-reserved balance so total settled offline spending cannot exceed the reserve. Offline receipts remain provisional until synchronized; a conflicting receipt can be rejected.</p><p>Production-grade offline payments need additional assumptions such as secure hardware with anti-rollback counters, tightly bounded value/risk, and a regulated settlement model.</p></div></section>
          <section className="project-metadata-grid"><div className="panel metadata-card"><KeyRound size={18} /><div><strong>Current device</strong><small>{deviceStatus.deviceId || 'Not initialized yet'}</small></div><button className="icon-button" title="Refresh device info" onClick={refreshLocal}><RefreshCw size={15} /></button></div><div className="panel metadata-card"><Globe size={18} /><div><strong>Service mode</strong><small>{online ? 'API connected' : 'Local shell available, settlement unavailable'}</small></div></div><div className="panel metadata-card"><Clock3 size={18} /><div><strong>Voucher validity</strong><small>{wallet?.limits?.offlineVoucherTtlHours || 72} hours maximum</small></div></div></section>
        </>}
        <footer className="app-footer"><span>MESHPAY · UPI WITHOUT INTERNET</span><span>Sandbox only · No real payments · {new Date().getFullYear()}</span></footer>
      </div>
    </main>
  </div>;
}

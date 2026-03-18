import {
  registerUser, loginUser, logoutUser, onAuthChange,
  getUser, updateUserProfile, updateLocation,
  searchUserByEmail, addFriend, removeFriend,
  listenToUser, listenToFriend, pingUser, listenToPings
} from './firebase.js';
import { GOOGLE_MAPS_API_KEY } from './config.js';

// ── STATE ──
let currentUser = null;
let myData = null;
let friendsData = {};       // uid → data
let friendListeners = {};   // uid → unsubscribe
let map = null;
let markers = {};           // uid → google.maps.Marker
let myMarker = null;
let locationWatcher = null;
let selectedFriendUid = null;
let pingListenerUnsub = null;
let myDataListener = null;

// ── AVATAR COLORS ──
const COLORS = [
  { bg: '#0F6E56', fg: '#5DCAA5' },
  { bg: '#185FA5', fg: '#85B7EB' },
  { bg: '#854F0B', fg: '#EF9F27' },
  { bg: '#993556', fg: '#ED93B1' },
  { bg: '#534AB7', fg: '#AFA9EC' },
  { bg: '#3B6D11', fg: '#97C459' },
  { bg: '#A32D2D', fg: '#F09595' },
  { bg: '#5F5E5A', fg: '#D3D1C7' },
];

function initials(name = '') {
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() || '??';
}

function colorForUid(uid = '') {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) & 0xffffffff;
  return COLORS[Math.abs(h) % COLORS.length];
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts.toMillis();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

// ── BOOT ──
window.addEventListener('load', () => {
  showLoading(true);
  loadGoogleMaps().then(() => {
    onAuthChange(user => {
      if (user) {
        currentUser = user;
        initApp();
      } else {
        currentUser = null;
        showLoading(false);
        showAuth();
        teardown();
      }
    });
  });
});

async function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    if (window.google) { resolve(); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}`;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function initApp() {
  showLoading(true);
  try {
    myData = await getUser(currentUser.uid);
    if (!myData) {
      await updateUserProfile(currentUser.uid, {
        displayName: currentUser.displayName || 'New User',
        email: currentUser.email,
        brands: [], availability: 'empty', stock: 0, location: null, friends: []
      });
      myData = await getUser(currentUser.uid);
    }
    renderApp();
    startMyListener();
    await loadFriends();
    startPingListener();
    startLocationSharing();
  } catch(e) {
    console.error(e);
    showError('Failed to load app: ' + e.message);
  }
  showLoading(false);
}

function teardown() {
  if (myDataListener) { myDataListener(); myDataListener = null; }
  if (pingListenerUnsub) { pingListenerUnsub(); pingListenerUnsub = null; }
  Object.values(friendListeners).forEach(fn => fn());
  friendListeners = {};
  friendsData = {};
  if (locationWatcher) { navigator.geolocation.clearWatch(locationWatcher); locationWatcher = null; }
}

// ── LISTENERS ──
function startMyListener() {
  if (myDataListener) myDataListener();
  myDataListener = listenToUser(currentUser.uid, data => {
    myData = data;
    updateMyMarker();
    updateMeAvatar();
    if (document.getElementById('profileView').classList.contains('active')) {
      fillProfileForm();
    }
  });
}

function startPingListener() {
  if (pingListenerUnsub) pingListenerUnsub();
  pingListenerUnsub = listenToPings(currentUser.uid, ping => {
    showPingToast(ping.fromName);
  });
}

async function loadFriends() {
  if (!myData?.friends?.length) { renderFriendList(); renderFriendsGrid(); return; }
  for (const uid of myData.friends) {
    startFriendListener(uid);
  }
}

function startFriendListener(uid) {
  if (friendListeners[uid]) return;
  friendListeners[uid] = listenToFriend(uid, data => {
    friendsData[uid] = data;
    renderFriendList();
    renderFriendsGrid();
    updateFriendMarker(uid, data);
    if (selectedFriendUid === uid) showDetailPanel(uid);
  });
}

function stopFriendListener(uid) {
  if (friendListeners[uid]) {
    friendListeners[uid]();
    delete friendListeners[uid];
    delete friendsData[uid];
    if (markers[uid]) { markers[uid].setMap(null); delete markers[uid]; }
  }
}

// ── LOCATION ──
function startLocationSharing() {
  if (!navigator.geolocation) return;
  locationWatcher = navigator.geolocation.watchPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      updateLocation(currentUser.uid, lat, lng);
      if (myData) myData.location = { lat, lng };
      updateMyMarker();
      updateGpsBtn(true);
    },
    err => {
      console.warn('GPS error:', err.message);
      updateGpsBtn(false);
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

// ── MAP ──
function initMap() {
  const el = document.getElementById('googleMap');
  if (!el || map) return;
  map = new google.maps.Map(el, {
    center: { lat: 69.6492, lng: 18.9553 }, // Tromsø
    zoom: 13,
    styles: darkMapStyle(),
    disableDefaultUI: true,
    zoomControl: true,
  });
}

function updateMyMarker() {
  if (!map || !myData?.location) return;
  const pos = { lat: myData.location.lat, lng: myData.location.lng };
  const c = colorForUid(currentUser.uid);
  if (!myMarker) {
    myMarker = new google.maps.Marker({
      position: pos, map,
      icon: makeMarkerIcon(c.bg, c.fg, initials(myData.displayName), true),
      zIndex: 100,
    });
    myMarker.addListener('click', () => map.panTo(pos));
  } else {
    myMarker.setPosition(pos);
  }
}

function updateFriendMarker(uid, data) {
  if (!map) return;
  const c = colorForUid(uid);
  const avail = data.availability || 'offline';
  const dotColor = { available: '#5DCAA5', maybe: '#EF9F27', empty: '#E24B4A', offline: '#5a5856' }[avail] || '#5a5856';

  if (!data.location) {
    if (markers[uid]) { markers[uid].setMap(null); delete markers[uid]; }
    return;
  }
  const pos = { lat: data.location.lat, lng: data.location.lng };
  if (!markers[uid]) {
    markers[uid] = new google.maps.Marker({
      position: pos, map,
      icon: makeMarkerIcon(c.bg, c.fg, initials(data.displayName), false),
    });
    markers[uid].addListener('click', () => {
      selectedFriendUid = uid;
      showDetailPanel(uid);
      map.panTo(pos);
    });
  } else {
    markers[uid].setPosition(pos);
    markers[uid].setIcon(makeMarkerIcon(c.bg, c.fg, initials(data.displayName), selectedFriendUid === uid));
  }
}

function makeMarkerIcon(bg, fg, label, selected) {
  const size = selected ? 44 : 36;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 1}" fill="${bg}" stroke="${fg}" stroke-width="${selected?2:0}"/>
      <text x="${size/2}" y="${size/2 + 4}" text-anchor="middle" font-family="DM Mono,monospace" font-size="${selected?12:10}" font-weight="500" fill="${fg}">${label}</text>
    </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(size/2, size/2),
  };
}

function darkMapStyle() {
  return [
    { elementType: 'geometry', stylers: [{ color: '#1a1d22' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1d22' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#555963' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2d35' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1a1d22' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1a2b' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2a2d35' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#38404e' }] },
    { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#666c7a' }] },
  ];
}

// ── RENDER APP SHELL ──
function renderApp() {
  document.getElementById('app').innerHTML = `
    <div class="app-shell">
      <div class="topbar">
        <div class="logo">Snus<span>Radar</span></div>
        <div class="nav-tabs">
          <button class="nav-tab active" onclick="setView('map')">Map</button>
          <button class="nav-tab" onclick="setView('friends')">Friends</button>
          <button class="nav-tab" onclick="setView('profile')">Profile</button>
        </div>
        <div class="topbar-right">
          <div class="ping-notif" id="pingNotif" title="Someone pinged you!">!</div>
          <button class="gps-btn" id="gpsBtn" onclick="recenterMap()" title="My location">
            <div class="gps-dot"></div> GPS
          </button>
          <div class="me-avatar" id="meAvatar" onclick="setView('profile')"></div>
        </div>
      </div>

      <!-- MAP VIEW -->
      <div class="view active" id="mapView">
        <div class="sidebar">
          <div class="sidebar-header">
            <div class="sidebar-label">Friends Online</div>
            <input class="search-input" id="friendSearch" placeholder="Search friends…" oninput="renderFriendList()">
          </div>
          <div class="friend-list" id="friendListEl"></div>
          <button class="add-friend-btn" onclick="openAddModal()">+ Add friend</button>
        </div>
        <div class="map-container">
          <div id="googleMap"></div>
          <div class="detail-panel" id="detailPanel">
            <button class="dp-close" onclick="closeDetailPanel()">✕</button>
            <div class="dp-top">
              <div class="dp-avatar" id="dpAvatar"></div>
              <div>
                <div class="dp-name" id="dpName"></div>
                <div class="dp-loc" id="dpLoc"></div>
              </div>
            </div>
            <div class="dp-status" id="dpStatus"><div class="dp-dot"></div><span id="dpStatusText"></span></div>
            <div>
              <div class="dp-section-label">Has snus</div>
              <div class="brand-tags" id="dpBrands"></div>
            </div>
            <div>
              <div class="dp-section-label">Stock</div>
              <div class="stock-bar"><div class="stock-fill" id="dpFill"></div></div>
              <div class="stock-meta"><span id="dpStockLabel"></span><span id="dpStockPct"></span></div>
            </div>
            <button class="ping-btn" id="dpPingBtn" onclick="doPing()">
              <div class="ping-dot-el"></div> Ping for snus
            </button>
          </div>
        </div>
      </div>

      <!-- FRIENDS VIEW -->
      <div class="view" id="friendsView">
        <div class="page-header">
          <div class="page-title">Friends</div>
          <button class="icon-btn" onclick="openAddModal()">+ Add friend</button>
        </div>
        <div class="friends-grid" id="friendsGrid"></div>
      </div>

      <!-- PROFILE VIEW -->
      <div class="view" id="profileView">
        <div class="page-title" style="margin-bottom:20px;">My Profile</div>
        <div class="profile-form" id="profileForm"></div>
      </div>
    </div>

    <!-- ADD FRIEND MODAL -->
    <div class="modal-overlay" id="addModal">
      <div class="modal">
        <div class="modal-title">Add friend</div>
        <div class="modal-sub">Search by email address</div>
        <div class="form-group">
          <div class="form-label">Email</div>
          <input class="form-input" id="searchEmail" type="email" placeholder="friend@email.com" oninput="clearFoundUser()">
        </div>
        <div class="modal-error" id="addError"></div>
        <div class="found-user" id="foundUser">
          <div class="found-avatar" id="foundAvatar"></div>
          <div>
            <div class="found-name" id="foundName"></div>
            <div class="found-email" id="foundEmail"></div>
          </div>
        </div>
        <div class="modal-sub" style="font-size:12px;color:var(--text3)">Or share your invite link</div>
        <div class="share-box">
          <span class="share-url" id="shareUrl"></span>
          <button class="copy-btn" id="copyBtn" onclick="copyInviteLink()">Copy</button>
        </div>
        <div class="modal-actions">
          <button class="btn-cancel" onclick="closeAddModal()">Cancel</button>
          <button class="btn-primary" id="searchBtn" onclick="doSearchUser()">Search</button>
        </div>
      </div>
    </div>

    <!-- PING TOAST -->
    <div class="ping-toast" id="pingToast">
      <div class="ping-toast-icon">📡</div>
      <div class="ping-toast-text"><span class="ping-toast-name" id="pingToastName"></span> wants snus!</div>
    </div>
  `;

  updateMeAvatar();
  renderFriendList();
  renderFriendsGrid();
  fillProfileForm();

  // Init map after DOM is ready
  setTimeout(() => {
    initMap();
    updateMyMarker();
    Object.entries(friendsData).forEach(([uid, data]) => updateFriendMarker(uid, data));
  }, 100);
}

// ── VIEWS ──
window.setView = function(v) {
  document.querySelectorAll('.nav-tab').forEach((t, i) => {
    t.classList.toggle('active', ['map','friends','profile'][i] === v);
  });
  ['mapView','friendsView','profileView'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', ['map','friends','profile'][i] === v);
  });
  if (v === 'friends') renderFriendsGrid();
  if (v === 'profile') fillProfileForm();
  if (v === 'map') setTimeout(() => { if (map) google.maps.event.trigger(map, 'resize'); }, 100);
};

// ── GPS ──
window.recenterMap = function() {
  if (map && myData?.location) {
    map.panTo({ lat: myData.location.lat, lng: myData.location.lng });
    map.setZoom(15);
  }
};

function updateGpsBtn(active) {
  const btn = document.getElementById('gpsBtn');
  if (btn) btn.classList.toggle('active', active);
}

// ── ME AVATAR ──
function updateMeAvatar() {
  const el = document.getElementById('meAvatar');
  if (!el || !myData) return;
  const c = colorForUid(currentUser.uid);
  el.textContent = initials(myData.displayName);
  el.style.background = c.bg;
  el.style.color = c.fg;
}

// ── FRIEND LIST (sidebar) ──
window.renderFriendList = function() {
  const el = document.getElementById('friendListEl');
  if (!el) return;
  const q = (document.getElementById('friendSearch')?.value || '').toLowerCase();
  const uids = myData?.friends || [];
  const filtered = uids.filter(uid => {
    const d = friendsData[uid];
    if (!d) return false;
    return !q || d.displayName?.toLowerCase().includes(q) || d.email?.toLowerCase().includes(q);
  });
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state" style="padding:40px 16px;font-size:12px;">No friends yet.\nAdd someone!</div>`;
    return;
  }
  el.innerHTML = filtered.map(uid => {
    const d = friendsData[uid];
    if (!d) return '';
    const c = colorForUid(uid);
    const avail = d.availability || 'offline';
    const badgeText = { available:'Has snus', maybe:'Low', empty:'None', offline:'Offline' }[avail];
    const brands = d.brands?.slice(0,2).join(', ') || 'No brands set';
    const isSelected = selectedFriendUid === uid;
    return `<div class="friend-item${isSelected?' selected':''}" onclick="selectFriend('${uid}')">
      <div class="f-avatar" style="background:${c.bg};color:${c.fg}">
        ${initials(d.displayName)}
        <div class="f-dot ${avail}"></div>
      </div>
      <div class="f-info">
        <div class="f-name">${d.displayName || 'Unknown'}</div>
        <div class="f-sub">${brands}</div>
      </div>
      <div class="f-badge ${avail}">${badgeText}</div>
    </div>`;
  }).join('');
};

// ── DETAIL PANEL ──
window.selectFriend = function(uid) {
  selectedFriendUid = uid;
  showDetailPanel(uid);
  renderFriendList();
  const d = friendsData[uid];
  if (d?.location && map) map.panTo({ lat: d.location.lat, lng: d.location.lng });
  // Refresh marker highlight
  Object.entries(friendsData).forEach(([fuid, fdata]) => updateFriendMarker(fuid, fdata));
};

function showDetailPanel(uid) {
  const d = friendsData[uid];
  if (!d) return;
  const panel = document.getElementById('detailPanel');
  if (!panel) return;
  const c = colorForUid(uid);
  const avail = d.availability || 'offline';
  const dp = document.getElementById('dpAvatar');
  dp.textContent = initials(d.displayName);
  dp.style.background = c.bg;
  dp.style.color = c.fg;
  document.getElementById('dpName').textContent = d.displayName;
  document.getElementById('dpLoc').textContent = d.location ? 'Live location' : 'No location shared';
  const statusEl = document.getElementById('dpStatus');
  statusEl.className = 'dp-status ' + avail;
  const statusTexts = { available:'Has snus — can share!', maybe:'Running low', empty:'Out of snus', offline:'Offline' };
  document.getElementById('dpStatusText').textContent = statusTexts[avail];
  document.getElementById('dpBrands').innerHTML = (d.brands||[]).map(b => `<div class="brand-tag">${b}</div>`).join('') || '<div style="color:var(--text3);font-size:12px;">None set</div>';
  const stock = d.stock || 0;
  const fill = document.getElementById('dpFill');
  fill.style.width = stock + '%';
  fill.className = 'stock-fill ' + avail;
  document.getElementById('dpStockLabel').textContent = stock > 60 ? 'Well stocked' : stock > 20 ? 'Some left' : 'Very low';
  document.getElementById('dpStockPct').textContent = stock + '%';
  const pb = document.getElementById('dpPingBtn');
  pb.classList.remove('sent');
  pb.innerHTML = '<div class="ping-dot-el"></div> Ping for snus';
  panel.classList.add('open');
}

window.closeDetailPanel = function() {
  selectedFriendUid = null;
  document.getElementById('detailPanel')?.classList.remove('open');
  renderFriendList();
  Object.entries(friendsData).forEach(([uid, data]) => updateFriendMarker(uid, data));
};

// ── PING ──
window.doPing = async function() {
  if (!selectedFriendUid) return;
  try {
    await pingUser(currentUser.uid, myData.displayName, selectedFriendUid);
    const pb = document.getElementById('dpPingBtn');
    pb.innerHTML = '<div class="ping-dot-el"></div> Pinged! ✓';
    pb.classList.add('sent');
    setTimeout(() => {
      if (pb) { pb.innerHTML = '<div class="ping-dot-el"></div> Ping for snus'; pb.classList.remove('sent'); }
    }, 4000);
  } catch(e) { console.error(e); }
};

function showPingToast(name) {
  const toast = document.getElementById('pingToast');
  const notif = document.getElementById('pingNotif');
  if (!toast) return;
  document.getElementById('pingToastName').textContent = name;
  toast.classList.add('show');
  if (notif) { notif.classList.add('visible'); setTimeout(() => notif.classList.remove('visible'), 8000); }
  setTimeout(() => toast.classList.remove('show'), 4000);
}

// ── FRIENDS GRID ──
window.renderFriendsGrid = function() {
  const grid = document.getElementById('friendsGrid');
  if (!grid) return;
  const uids = myData?.friends || [];
  if (!uids.length) {
    grid.innerHTML = `<div class="empty-state">No friends added yet.<br>Add someone with the button above!</div>`;
    return;
  }
  grid.innerHTML = uids.map(uid => {
    const d = friendsData[uid];
    if (!d) return '';
    const c = colorForUid(uid);
    const avail = d.availability || 'offline';
    const badgeText = { available:'Has snus to share', maybe:'Running low', empty:'No snus available', offline:'Offline' }[avail];
    return `<div class="friend-card">
      <div class="fc-top">
        <div class="fc-avatar" style="background:${c.bg};color:${c.fg}">
          ${initials(d.displayName)}
          <div class="f-dot ${avail}" style="border-color:var(--bg2)"></div>
        </div>
        <div>
          <div class="fc-name">${d.displayName}</div>
          <div class="fc-email">${d.email}</div>
        </div>
      </div>
      <div class="fc-divider"></div>
      <div class="fc-brands">
        ${(d.brands||[]).map(b=>`<div class="fc-brand">${b}</div>`).join('') || '<div style="color:var(--text3);font-size:12px;">No brands set</div>'}
      </div>
      <div class="f-badge ${avail}" style="width:100%;text-align:center;padding:6px;border-radius:var(--radius-sm);font-size:12px;margin-bottom:10px;">${badgeText}</div>
      <button class="remove-btn" onclick="doRemoveFriend('${uid}')">Remove friend</button>
    </div>`;
  }).join('');
};

window.doRemoveFriend = async function(uid) {
  if (!confirm('Remove this friend?')) return;
  await removeFriend(currentUser.uid, uid);
  stopFriendListener(uid);
  myData.friends = myData.friends.filter(f => f !== uid);
  if (selectedFriendUid === uid) closeDetailPanel();
  renderFriendList();
  renderFriendsGrid();
};

// ── ADD FRIEND MODAL ──
let foundUserData = null;

window.openAddModal = function() {
  foundUserData = null;
  document.getElementById('searchEmail').value = '';
  document.getElementById('addError').style.display = 'none';
  document.getElementById('foundUser').classList.remove('show');
  const btn = document.getElementById('searchBtn');
  btn.textContent = 'Search';
  btn.onclick = doSearchUser;
  const shareUrl = document.getElementById('shareUrl');
  if (shareUrl) shareUrl.textContent = `${location.origin}?invite=${currentUser.uid}`;
  document.getElementById('addModal').classList.add('open');
  setTimeout(() => document.getElementById('searchEmail').focus(), 150);
};

window.closeAddModal = function() {
  document.getElementById('addModal').classList.remove('open');
};

window.clearFoundUser = function() {
  document.getElementById('foundUser').classList.remove('show');
  document.getElementById('addError').style.display = 'none';
  foundUserData = null;
  const btn = document.getElementById('searchBtn');
  btn.textContent = 'Search';
  btn.onclick = doSearchUser;
};

window.doSearchUser = async function() {
  const email = document.getElementById('searchEmail').value.trim();
  if (!email) return;
  const errEl = document.getElementById('addError');
  errEl.style.display = 'none';
  const btn = document.getElementById('searchBtn');
  btn.disabled = true; btn.textContent = 'Searching…';
  try {
    const user = await searchUserByEmail(email);
    if (!user) { errEl.textContent = 'No user found with that email.'; errEl.style.display = 'block'; btn.disabled=false; btn.textContent='Search'; return; }
    if (user.uid === currentUser.uid) { errEl.textContent = "That's you!"; errEl.style.display = 'block'; btn.disabled=false; btn.textContent='Search'; return; }
    if (myData?.friends?.includes(user.uid)) { errEl.textContent = 'Already a friend!'; errEl.style.display = 'block'; btn.disabled=false; btn.textContent='Search'; return; }
    foundUserData = user;
    const c = colorForUid(user.uid);
    document.getElementById('foundAvatar').textContent = initials(user.displayName);
    document.getElementById('foundAvatar').style.background = c.bg;
    document.getElementById('foundAvatar').style.color = c.fg;
    document.getElementById('foundName').textContent = user.displayName;
    document.getElementById('foundEmail').textContent = user.email;
    document.getElementById('foundUser').classList.add('show');
    btn.textContent = 'Add friend';
    btn.onclick = doAddFoundUser;
  } catch(e) {
    errEl.textContent = 'Error: ' + e.message; errEl.style.display = 'block';
  }
  btn.disabled = false;
};

async function doAddFoundUser() {
  if (!foundUserData) return;
  const btn = document.getElementById('searchBtn');
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    await addFriend(currentUser.uid, foundUserData.uid);
    if (!myData.friends) myData.friends = [];
    myData.friends.push(foundUserData.uid);
    startFriendListener(foundUserData.uid);
    closeAddModal();
    renderFriendList();
    renderFriendsGrid();
  } catch(e) {
    document.getElementById('addError').textContent = e.message;
    document.getElementById('addError').style.display = 'block';
  }
  btn.disabled = false;
}

window.copyInviteLink = function() {
  const url = `${location.origin}?invite=${currentUser.uid}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = 'Copied!'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
};

// ── PROFILE FORM ──
let profileBrands = [];
let profileAvail = 'empty';
let profileColorIdx = 0;

function fillProfileForm() {
  if (!myData) return;
  profileBrands = [...(myData.brands || [])];
  profileAvail = myData.availability || 'empty';
  const c = colorForUid(currentUser.uid);
  const form = document.getElementById('profileForm');
  if (!form) return;
  form.innerHTML = `
    <div class="form-group">
      <div class="form-label">Display name</div>
      <input class="form-input" id="pName" value="${myData.displayName || ''}" placeholder="Your name">
    </div>
    <div class="form-group">
      <div class="form-label">My snus brands</div>
      <div class="brands-field" id="brandsField" onclick="document.getElementById('brandInput').focus()">
        <input class="chip-input" id="brandInput" placeholder="Type brand + Enter" onkeydown="handleBrandKey(event)">
      </div>
    </div>
    <div class="form-group">
      <div class="form-label">Availability</div>
      <div class="avail-row">
        <button class="avail-btn${profileAvail==='available'?' sel-available':''}" onclick="setProfileAvail(this,'available')">Got plenty</button>
        <button class="avail-btn${profileAvail==='maybe'?' sel-maybe':''}" onclick="setProfileAvail(this,'maybe')">Running low</button>
        <button class="avail-btn${profileAvail==='empty'?' sel-empty':''}" onclick="setProfileAvail(this,'empty')">Empty</button>
      </div>
    </div>
    <div class="form-group">
      <div class="form-label">Stock level</div>
      <div class="stock-slider-wrap">
        <input type="range" class="stock-slider" id="stockSlider" min="0" max="100" step="1" value="${myData.stock||0}" oninput="document.getElementById('stockVal').textContent=this.value+'%'">
        <div class="slider-label"><span>0%</span><span id="stockVal">${myData.stock||0}%</span><span>100%</span></div>
      </div>
    </div>
    <div class="save-row">
      <button class="save-btn" onclick="saveProfile()">Save</button>
      <span class="saved-msg" id="savedMsg">Saved!</span>
    </div>
    <button class="logout-btn" onclick="doLogout()">Sign out</button>
  `;
  renderBrandChips();
}

function renderBrandChips() {
  const field = document.getElementById('brandsField');
  if (!field) return;
  const input = document.getElementById('brandInput');
  field.innerHTML = '';
  profileBrands.forEach((b, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `${b}<button class="chip-x" onclick="removeBrandChip(${i})">×</button>`;
    field.appendChild(chip);
  });
  field.appendChild(input || (() => {
    const inp = document.createElement('input');
    inp.className = 'chip-input'; inp.id = 'brandInput';
    inp.placeholder = 'Type brand + Enter';
    inp.setAttribute('onkeydown', 'handleBrandKey(event)');
    return inp;
  })());
}

window.handleBrandKey = function(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().replace(/,$/, '');
    if (val && !profileBrands.includes(val)) { profileBrands.push(val); e.target.value = ''; renderBrandChips(); }
  }
};

window.removeBrandChip = function(i) {
  profileBrands.splice(i, 1);
  renderBrandChips();
};

window.setProfileAvail = function(btn, a) {
  profileAvail = a;
  document.querySelectorAll('.avail-row .avail-btn').forEach(b => b.className = 'avail-btn');
  btn.className = `avail-btn sel-${a}`;
};

window.saveProfile = async function() {
  const name = document.getElementById('pName')?.value.trim();
  const stock = parseInt(document.getElementById('stockSlider')?.value || 0);
  if (!name) return;
  try {
    await updateUserProfile(currentUser.uid, {
      displayName: name, brands: profileBrands,
      availability: profileAvail, stock
    });
    const msg = document.getElementById('savedMsg');
    if (msg) { msg.classList.add('show'); setTimeout(() => msg.classList.remove('show'), 2000); }
  } catch(e) { alert('Save failed: ' + e.message); }
};

window.doLogout = async function() {
  teardown();
  await logoutUser();
};

// ── AUTH SCREEN ──
function showAuth() {
  document.getElementById('app').innerHTML = `
    <div class="auth-screen">
      <div class="auth-box">
        <div class="auth-logo">Snus<span>Radar</span></div>
        <div class="auth-tagline">find snus, find friends</div>
        <div class="auth-tabs">
          <button class="auth-tab active" onclick="switchAuthTab('login')">Sign in</button>
          <button class="auth-tab" onclick="switchAuthTab('register')">Create account</button>
        </div>
        <div id="authFormEl"></div>
      </div>
    </div>
  `;
  renderLoginForm();
}

window.switchAuthTab = function(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) => t.classList.toggle('active', ['login','register'][i] === tab));
  if (tab === 'login') renderLoginForm(); else renderRegisterForm();
};

function renderLoginForm() {
  document.getElementById('authFormEl').innerHTML = `
    <div class="form-group">
      <div class="form-label">Email</div>
      <input class="form-input" id="authEmail" type="email" placeholder="you@example.com">
    </div>
    <div class="form-group">
      <div class="form-label">Password</div>
      <input class="form-input" id="authPw" type="password" placeholder="Password">
    </div>
    <div class="auth-error" id="authErr"></div>
    <button class="auth-btn" onclick="doLogin()">Sign in</button>
  `;
  document.getElementById('authPw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

function renderRegisterForm() {
  document.getElementById('authFormEl').innerHTML = `
    <div class="form-group">
      <div class="form-label">Name</div>
      <input class="form-input" id="authName" type="text" placeholder="Your name">
    </div>
    <div class="form-group">
      <div class="form-label">Email</div>
      <input class="form-input" id="authEmail" type="email" placeholder="you@example.com">
    </div>
    <div class="form-group">
      <div class="form-label">Password</div>
      <input class="form-input" id="authPw" type="password" placeholder="Min 6 characters">
    </div>
    <div class="auth-error" id="authErr"></div>
    <button class="auth-btn" onclick="doRegister()">Create account</button>
  `;
}

window.doLogin = async function() {
  const email = document.getElementById('authEmail').value.trim();
  const pw = document.getElementById('authPw').value;
  const errEl = document.getElementById('authErr');
  const btn = document.querySelector('.auth-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  errEl.style.display = 'none';
  try {
    await loginUser(email, pw);
  } catch(e) {
    errEl.textContent = friendlyAuthError(e.code);
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Sign in';
  }
};

window.doRegister = async function() {
  const name = document.getElementById('authName').value.trim();
  const email = document.getElementById('authEmail').value.trim();
  const pw = document.getElementById('authPw').value;
  const errEl = document.getElementById('authErr');
  const btn = document.querySelector('.auth-btn');
  if (!name) { errEl.textContent = 'Please enter your name.'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'Creating account…';
  errEl.style.display = 'none';
  try {
    await registerUser(email, pw, name);
  } catch(e) {
    errEl.textContent = friendlyAuthError(e.code);
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Create account';
  }
};

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-email': 'Invalid email address.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment.',
    'auth/invalid-credential': 'Incorrect email or password.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// ── LOADING ──
function showLoading(show) {
  let el = document.getElementById('loadingScreen');
  if (show) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'loadingScreen';
      el.className = 'loading-screen';
      el.innerHTML = `<div class="loading-logo">Snus<span>Radar</span></div><div class="loading-spinner"></div>`;
      document.body.appendChild(el);
    }
  } else {
    if (el) el.remove();
  }
}

function showError(msg) {
  alert(msg);
}

// Handle invite links
const params = new URLSearchParams(location.search);
const inviteUid = params.get('invite');
if (inviteUid) {
  sessionStorage.setItem('pendingInvite', inviteUid);
}

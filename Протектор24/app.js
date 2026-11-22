'use strict';
/* ============================================================
   ПРОТЕКТОР 24 — v3.0 (полностью переработанная версия)
   Оптимизации: ноль внешних CDN, дебаунс записи в память,
   лёгкие перерисовки, единая точка сохранения, чистые данные.
   ============================================================ */

/* ============ КОНСТАНТЫ ============ */
const ACCESS_CODE = '031212';
const PIN_MIN = 4, PIN_MAX = 6;

const ALL_RADII = ['R13-14','R15','R16','R17','R18','R19','R20','R21','R22'];
const COMMERCIAL_RADII = ['R13-14','R15','R16','R17'];

const RADIUS_MULTIPLIERS = {'R13-14':1.0,'R15':1.1,'R16':1.2,'R17':1.35,'R18':1.5,'R19':1.7,'R20':1.9,'R21':2.1,'R22':2.3};

const COMPLEX_PRICES = {
  passenger:  {'R13-14':1800,'R15':2000,'R16':2200,'R17':2400,'R18':2600,'R19':2800,'R20':3200,'R21':3600,'R22':4000},
  suv:        {'R13-14':2200,'R15':2400,'R16':2700,'R17':2900,'R18':3100,'R19':3300,'R20':3700,'R21':4200,'R22':4800},
  commercial: {'R13-14':2300,'R15':2500,'R16':2800,'R17':3100}
};

const STORAGE_PRICES = {'R13-14':1500,'R15':1500,'R16':1500,'R17':2000,'R18':2000,'R19':2000,'R20':2500,'R21':2500,'R22':2500};

const CAR_MULTIPLIERS = {
  passenger:  {label:'Легковые', mult:1.0},
  suv:        {label:'Джипы/Кроссоверы/Минивэны', mult:1.2},
  commercial: {label:'Коммерческий/Грузовой', mult:1.3}
};

const DEFAULT_SERVICES = [
  {id:'s_complex', name:'Комплекс: 4 колеса (С/У, демонтаж, монтаж, баланс)', basePrice:2000, scale:true,  priceType:'complex', includeInSalary:true},
  {id:'s_storage', name:'Хранение шин (комплект на сезон)',                   basePrice:1500, scale:true,  priceType:'storage', includeInSalary:false},
  {id:'s2',  name:'Снятие и установка колеса (1 шт.)',                        basePrice:120,  scale:true,  includeInSalary:true},
  {id:'s3',  name:'Демонтаж / монтаж шины (1 шт.)',                           basePrice:150,  scale:true,  includeInSalary:true},
  {id:'s4',  name:'Балансировка колеса с грузиками (1 шт.)',                  basePrice:160,  scale:true,  includeInSalary:true},
  {id:'s5',  name:'Ремонт прокола жгутом',                                    basePrice:350,  scale:false, includeInSalary:true},
  {id:'s6',  name:'Ремонт прокола латкой (холодная вулканизация)',            basePrice:600,  scale:false, includeInSalary:true},
  {id:'s7',  name:'Ремонт бокового пореза (горячая вулканизация)',            basePrice:1500, scale:false, includeInSalary:true},
  {id:'s8',  name:'Герметизация борта диска',                                 basePrice:250,  scale:false, includeInSalary:true},
  {id:'s9',  name:'Замена вентиля (соска) резинового',                        basePrice:100,  scale:false, includeInSalary:false},
  {id:'s10', name:'Правка / прокатка литого диска',                           basePrice:1200, scale:true,  includeInSalary:true},
  {id:'s11', name:'Подкачка и проверка давления (4 колеса)',                  basePrice:100,  scale:false, includeInSalary:true},
  {id:'s12', name:'Пакеты для шин (комплект 4 шт.)',                          basePrice:200,  scale:false, includeInSalary:false}
];

const PAYMENT_LABELS = {cash:'💵 Наличные', card:'💳 Карта / СБП'};
const CLOUD_API = 'https://jsonblob.com/api/jsonBlob';

/* Сетевой запрос с жёстким таймаутом: не даём синхронизации подвешивать интерфейс */
function fetchTimeout(url, opts){
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, 5000);
  const conf = Object.assign({}, opts || {});
  if(ctrl) conf.signal = ctrl.signal;
  return fetch(url, conf).then(function(r){ clearTimeout(timer); return r; },
                               function(e){ clearTimeout(timer); throw e; });
}

/* ============ УТИЛИТЫ ============ */
const qs = function(id){ return document.getElementById(id); };

function escapeHtml(str){
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/"/g,'&quot;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}
function fmt(n){ return Math.round(Number(n)||0).toLocaleString('ru-RU'); }
function fmtDate(iso){
  return new Date(iso).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function dayKey(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
async function hashPin(pin){
  const str = String(pin).trim();
  if(window.crypto && window.crypto.subtle && window.isSecureContext){
    const buf = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }
  let h = 2166136261;
  for(let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h,16777619); }
  return 'local_' + (h>>>0).toString(16);
}
function safeParse(raw){
  try{ return JSON.parse(raw); }catch(e){ return null; }
}
function load(key){ return safeParse(localStorage.getItem(key)); }

/* ============ СОСТОЯНИЕ ============ */
const state = {
  users: load('p24_users'),
  services: load('p24_services') || DEFAULT_SERVICES.slice(),
  orders: load('p24_orders') || [],
  settings: load('p24_settings') || {shopName:'Протектор 24 — Шиномонтаж', shiftStart:new Date().toISOString()},
  currentUser: null,
  selectedCarType:'passenger',
  selectedRadius:'R16',
  cart:[],
  reportPeriod:'shift',
  historyFilter:'all',
  historySearch:'',
  cloudStamp:0
};
state.currentUser = safeParse(sessionStorage.getItem('p24_current_user'));

let saveTimer = null, cloudPushTimer = null, cloudPullTimer = null, cloudBusy = false, listenersBound = false;

function persist(){
  try{
    localStorage.setItem('p24_users', JSON.stringify(state.users));
    localStorage.setItem('p24_services', JSON.stringify(state.services));
    localStorage.setItem('p24_orders', JSON.stringify(state.orders));
    localStorage.setItem('p24_settings', JSON.stringify(state.settings));
  }catch(e){
    showToast('Память браузера заполнена! Скачайте бэкап и удалите старые заказы.', true);
  }
}
/* Единая точка сохранения: дебаунс, чтобы не молотить память на каждый чих */
function saveState(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){ persist(); pushCloud(); }, 300);
}

/* ============ ЭКРАНЫ ВХОДА ============ */
function showAccess(){
  qs('access-screen').style.display = 'flex';
  qs('login-screen').style.display = 'none';
  qs('app-wrapper').style.display = 'none';
}
function showLogin(){
  qs('access-screen').style.display = 'none';
  qs('login-screen').style.display = 'flex';
  qs('app-wrapper').style.display = 'none';
  renderLoginSelect();
}
function unlockApp(){
  const v = qs('access-code').value.trim();
  const err = qs('access-error');
  if(!/^\d{6}$/.test(v)){ err.textContent = 'Код состоит из 6 цифр'; return; }
  if(v !== ACCESS_CODE){ err.textContent = 'Неверный код доступа'; return; }
  err.textContent = '';
  qs('access-code').value = '';
  sessionStorage.setItem('p24_access_ok','1');
  showLogin();
}

async function boot(){
  if(sessionStorage.getItem('p24_access_ok') !== '1'){ showAccess(); return; }

  /* Первый запуск: создаём ТОЛЬКО администратора */
  if(!state.users || !state.users.length){
    state.users = [{ id:'u_admin', name:'Администратор', role:'admin', pinHash: await hashPin('0000'), pct:0 }];
    persist();
  }
  /* Миграция старых PIN на хэши */
  let migrated = false;
  for(let i=0;i<state.users.length;i++){
    if(state.users[i].pin && !state.users[i].pinHash){
      state.users[i].pinHash = await hashPin(state.users[i].pin);
      delete state.users[i].pin;
      migrated = true;
    }
  }
  if(migrated) persist();

  renderLoginSelect();
  if(state.currentUser){
    const fresh = state.users.find(function(u){ return u.id === state.currentUser.id; });
    if(fresh){ state.currentUser = fresh; enterApp(); return; }
    sessionStorage.removeItem('p24_current_user');
    state.currentUser = null;
  }
  showLogin();
}

function renderLoginSelect(){
  const sel = qs('login-user-select');
  sel.innerHTML = state.users.map(function(u){
    const icon = u.role === 'admin' ? '👑 ' : '🔧 ';
    return '<option value="'+u.id+'">'+icon+escapeHtml(u.name)+'</option>';
  }).join('');
}

async function handleLogin(){
  const id = qs('login-user-select').value;
  const pin = qs('login-pin-input').value.trim();
  const err = qs('login-error');
  const user = state.users.find(function(u){ return u.id === id; });
  const h = await hashPin(pin);
  if(!user || user.pinHash !== h){
    err.textContent = 'Неверный PIN-код';
    qs('login-pin-input').value = '';
    return;
  }
  err.textContent = '';
  state.currentUser = user;
  sessionStorage.setItem('p24_current_user', JSON.stringify(user));
  qs('login-pin-input').value = '';
  enterApp();
  showToast('Добро пожаловать, ' + user.name + '!');
}

function logoutUser(){
  state.currentUser = null;
  state.cart = [];
  sessionStorage.removeItem('p24_current_user');
  showLogin();
}

/* ============ ПРИЛОЖЕНИЕ ============ */
function enterApp(){
  qs('login-screen').style.display = 'none';
  qs('app-wrapper').style.display = 'block';
  applyRolePermissions();
  updateHeader();
  renderMasterSelect();
  renderRadiusPills();
  renderCatalog();
  renderCart();
  renderHistory();
  renderReports();
  renderSettings();
  startSyncLoop();
  bindListeners();
}

function applyRolePermissions(){
  const isAdmin = state.currentUser.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(function(el){ el.style.display = isAdmin ? '' : 'none'; });
  qs('current-user-badge').textContent = (isAdmin ? '👑 ' : '🔧 ') + state.currentUser.name;
}

function updateHeader(){
  qs('header-shop-title').textContent = state.settings.shopName;
  qs('header-date').textContent = new Date().toLocaleDateString('ru-RU',{weekday:'short', day:'numeric', month:'long'});
  const shift = new Date(state.settings.shiftStart);
  qs('header-shift-info').textContent = 'Смена с ' + shift.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}) + ' (' + shift.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'}) + ')';
}

function switchTab(tabId, btn){
  document.querySelectorAll('.tab-content').forEach(function(el){ el.classList.remove('active'); });
  document.querySelectorAll('.nav-btn').forEach(function(el){ el.classList.remove('active'); });
  qs('tab-'+tabId).classList.add('active');
  if(btn) btn.classList.add('active');
  if(tabId==='history') renderHistory();
  if(tabId==='reports') renderReports();
  if(tabId==='settings') renderSettings();
}

function showToast(msg, isError){
  const t = qs('toast');
  t.textContent = msg;
  t.style.background = isError ? 'var(--danger)' : 'var(--success)';
  t.style.color = isError ? '#fff' : '#070b14';
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(function(){ t.classList.remove('show'); }, 2800);
}

function renderMasterSelect(){
  const sel = qs('master-select');
  const masters = state.users.filter(function(u){ return u.role==='master'; });
  const list = masters.length > 0 ? masters : state.users;
  sel.innerHTML = list.map(function(u){
    return '<option value="'+u.id+'">'+escapeHtml(u.name)+'</option>';
  }).join('');
  if(state.currentUser && state.currentUser.role === 'master'){
    sel.value = state.currentUser.id;
    sel.disabled = true;
  } else {
    sel.disabled = false;
  }
}
function getMasterNameById(masterId, fallback){
  const u = state.users.find(function(x){ return x.id === masterId; });
  return u ? u.name : (fallback || 'Неизвестный');
}

/* ============ ЗАКАЗ: ПАРАМЕТРЫ ============ */
function selectCarType(type, btn){
  state.selectedCarType = type;
  document.querySelectorAll('#car-type-pills .pill-btn').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  renderRadiusPills();
  renderCatalog();
  recalculateCartPrices();
}
function renderRadiusPills(){
  const allowed = state.selectedCarType === 'commercial' ? COMMERCIAL_RADII : ALL_RADII;
  if(allowed.indexOf(state.selectedRadius) === -1) state.selectedRadius = 'R17';
  qs('radius-pills').innerHTML = allowed.map(function(r){
    const active = state.selectedRadius === r ? ' active' : '';
    return '<button class="pill-btn'+active+'" data-radius="'+r+'">'+r+'</button>';
  }).join('');
}
function selectRadius(r){
  state.selectedRadius = r;
  renderRadiusPills();
  renderCatalog();
  recalculateCartPrices();
}
function calcServicePrice(srv){
  if(srv.priceType === 'complex'){
    const table = COMPLEX_PRICES[state.selectedCarType] || COMPLEX_PRICES.passenger;
    return table[state.selectedRadius] || srv.basePrice;
  }
  if(srv.priceType === 'storage'){
    return STORAGE_PRICES[state.selectedRadius] || srv.basePrice;
  }
  if(!srv.scale) return srv.basePrice;
  const rMult = RADIUS_MULTIPLIERS[state.selectedRadius] || 1;
  const cMult = (CAR_MULTIPLIERS[state.selectedCarType]||{}).mult || 1;
  return Math.round((srv.basePrice * rMult * cMult)/10)*10;
}
function renderCatalog(){
  qs('services-catalog').innerHTML = state.services.map(function(srv){
    const price = calcServicePrice(srv);
    return '<div class="service-item" data-id="'+srv.id+'">'+
      '<div class="service-name">'+escapeHtml(srv.name)+'</div>'+
      '<div class="service-meta">'+
        '<span class="service-price">'+fmt(price)+' ₽</span>'+
        '<span class="service-add">+ В чек</span>'+
      '</div></div>';
  }).join('');
}
function recalculateCartPrices(){
  state.cart.forEach(function(item){
    const srv = state.services.find(function(s){ return s.id === item.srvId; });
    if(srv && (srv.scale || srv.priceType)){
      const newPrice = calcServicePrice(srv);
      item.name = srv.name + ' (' + state.selectedRadius + ')';
      if(!item.isManualPrice){ item.price = newPrice; item.baseCalculatedPrice = newPrice; }
    }
  });
  renderCart();
}

/* ============ КОРЗИНА ============ */
function addToCart(srvId){
  const srv = state.services.find(function(s){ return s.id === srvId; });
  if(!srv) return;
  const currentPrice = calcServicePrice(srv);
  const label = (srv.scale || srv.priceType) ? srv.name + ' (' + state.selectedRadius + ')' : srv.name;
  const incSalary = srv.includeInSalary !== false;
  const existing = state.cart.find(function(item){
    return item.name === label && item.price === currentPrice && !item.isManualPrice;
  });
  if(existing) existing.qty += 1;
  else state.cart.push({
    id: Date.now() + Math.random(),
    srvId: srv.id,
    name: label,
    price: currentPrice,
    baseCalculatedPrice: currentPrice,
    isManualPrice: false,
    includeInSalary: incSalary,
    qty: 1
  });
  renderCart();
}
function updateCartQty(idx, delta){
  state.cart[idx].qty += delta;
  if(state.cart[idx].qty <= 0) state.cart.splice(idx,1);
  renderCart();
}
function updateCartItemPrice(idx, newPrice){
  const val = Math.max(0, Number(newPrice)||0);
  state.cart[idx].price = val;
  state.cart[idx].isManualPrice = (val !== state.cart[idx].baseCalculatedPrice);
  renderCart();
}
function clearCart(){
  state.cart = [];
  qs('discount-input').value = 0;
  renderCart();
}
function renderCart(){
  const list = qs('cart-list');
  if(state.cart.length === 0){
    list.innerHTML = '<div class="cart-empty">Добавьте услуги из списка</div>';
  } else {
    list.innerHTML = state.cart.map(function(item, idx){
      const warn = item.isManualPrice ? ' <span class="badge-warn" title="Цена изменена вручную">✎</span>' : '';
      return '<div class="cart-item">'+
        '<div class="cart-item-info">'+
          '<div class="cart-item-title">'+escapeHtml(item.name)+warn+'</div>'+
          '<div class="cart-item-sub">'+
            '<input type="number" value="'+item.price+'" min="0" data-idx="'+idx+'" class="cart-price-input"> ₽ × '+item.qty+
            ' = <strong>'+fmt(item.price*item.qty)+' ₽</strong>'+
          '</div>'+
        '</div>'+
        '<div class="qty-controls">'+
          '<button class="qty-btn" data-act="dec" data-idx="'+idx+'">−</button>'+
          '<span class="qty-val">'+item.qty+'</span>'+
          '<button class="qty-btn" data-act="inc" data-idx="'+idx+'">+</button>'+
        '</div></div>';
    }).join('');
  }
  renderTotals();
}
function renderTotals(){
  const subtotal = state.cart.reduce(function(s,i){ return s + i.price*i.qty; }, 0);
  const discPct = Math.min(100, Math.max(0, Number(qs('discount-input').value)||0));
  const discSum = Math.round(subtotal*(discPct/100));
  qs('subtotal-val').textContent = fmt(subtotal)+' ₽';
  qs('discount-val').textContent = '−'+fmt(discSum)+' ₽';
  qs('total-val').textContent = fmt(subtotal-discSum)+' ₽';
}

function saveOrder(){
  if(state.cart.length === 0){ showToast('Добавьте хотя бы одну услугу в заказ!', true); return; }
  const subtotal = state.cart.reduce(function(s,i){ return s + i.price*i.qty; }, 0);
  const discPct = Math.min(100, Math.max(0, Number(qs('discount-input').value)||0));
  const total = subtotal - Math.round(subtotal*(discPct/100));
  const salarySubtotal = state.cart.reduce(function(s,i){
    return (i.includeInSalary !== false) ? s + i.price*i.qty : s;
  }, 0);
  const salaryBase = salarySubtotal - Math.round(salarySubtotal*(discPct/100));
  let nextId = state.orders.length > 0 ? Math.max.apply(null, state.orders.map(function(o){ return Number(o.id)||0; })) + 1 : 1001;
  while(state.orders.some(function(o){ return Number(o.id) === nextId; })) nextId++;
  const masterId = qs('master-select').value || state.currentUser.id;
  const order = {
    id: nextId,
    date: new Date().toISOString(),
    car: qs('car-info').value.trim() || 'Без госномера',
    client: qs('client-info').value.trim() || 'Частный клиент',
    masterId: masterId,
    master: getMasterNameById(masterId, state.currentUser.name),
    carType: state.selectedCarType,
    radius: state.selectedRadius,
    items: state.cart.map(function(i){
      return {srvId:i.srvId, name:i.name, price:i.price, qty:i.qty, includeInSalary:i.includeInSalary};
    }),
    discountPct: discPct,
    subtotal: subtotal,
    total: total,
    salaryBase: salaryBase,
    payment: qs('payment-select').value,
    comment: qs('order-comment').value.trim()
  };
  state.orders.push(order);
  saveState();
  clearCart();
  qs('car-info').value = '';
  qs('client-info').value = '';
  qs('order-comment').value = '';
  qs('payment-select').value = 'cash';
  renderHistory();
  showToast('Заказ №' + nextId + ' сохранён! Сумма: ' + fmt(total) + ' ₽');
}

/* ============ ЖУРНАЛ ============ */
function periodStart(period){
  const now = new Date();
  if(period === 'shift') return new Date(state.settings.shiftStart);
  if(period === 'week'){ const d = new Date(now); d.setDate(d.getDate()-7); return d; }
  if(period === 'month'){ const d = new Date(now); d.setDate(d.getDate()-30); return d; }
  return new Date(0);
}
function visibleOrders(){
  const from = periodStart(state.historyFilter);
  const q = state.historySearch.trim().toLowerCase();
  return state.orders.filter(function(o){
    if(new Date(o.date) < from) return false;
    if(!q) return true;
    const hay = (String(o.id)+' '+o.car+' '+o.client+' '+o.master).toLowerCase();
    return hay.indexOf(q) !== -1;
  }).sort(function(a,b){ return b.id - a.id; });
}
function renderHistory(){
  const list = visibleOrders();
  qs('history-count').textContent = list.length;
  const tbody = qs('history-body');
  if(list.length === 0){
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">Заказов за период нет</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(function(o){
    const itemsCount = o.items.reduce(function(s,i){ return s+i.qty; },0);
    const adminActs = state.currentUser.role === 'admin'
      ? '<button class="mini-btn danger" data-act="del-order" data-id="'+o.id+'" title="Удалить заказ">🗑</button>' : '';
    return '<tr class="order-row" data-id="'+o.id+'">'+
      '<td class="nowrap"><b>№'+o.id+'</b><br><span class="muted">'+fmtDate(o.date)+'</span></td>'+
      '<td>'+escapeHtml(o.car)+'<br><span class="muted">'+escapeHtml(o.client)+'</span></td>'+
      '<td class="nowrap">'+(CAR_MULTIPLIERS[o.carType]?CAR_MULTIPLIERS[o.carType].label.split('/')[0]:'—')+'<br><span class="muted">'+(o.radius||'')+'</span></td>'+
      '<td>'+itemsCount+' шт.</td>'+
      '<td>'+escapeHtml(o.master)+'</td>'+
      '<td class="nowrap">'+(PAYMENT_LABELS[o.payment]||o.payment||'—')+'</td>'+
      '<td class="nowrap"><b>'+fmt(o.total)+' ₽</b></td>'+
      '<td class="nowrap"><button class="mini-btn" data-act="view-order" data-id="'+o.id+'" title="Подробнее">👁</button> '+adminActs+'</td>'+
    '</tr>';
  }).join('');
}
function viewOrder(id){
  const o = state.orders.find(function(x){ return Number(x.id) === Number(id); });
  if(!o) return;
  const rows = (o.items||[]).map(function(i){
    return '<tr><td>'+escapeHtml(i.name)+'</td><td class="nowrap">'+fmt(i.price)+' ₽ × '+i.qty+'</td><td class="nowrap"><b>'+fmt(i.price*i.qty)+' ₽</b></td></tr>';
  }).join('');
  const photo = o.photo ? '<img src="'+o.photo+'" class="modal-photo" alt="Фото авто">' : '';
  qs('modal-body').innerHTML =
    '<h3>Заказ №'+o.id+' от '+fmtDate(o.date)+'</h3>'+photo+
    '<p><b>Авто:</b> '+escapeHtml(o.car)+'<br><b>Клиент:</b> '+escapeHtml(o.client)+'<br>'+
    '<b>Мастер:</b> '+escapeHtml(o.master)+'<br><b>Оплата:</b> '+(PAYMENT_LABELS[o.payment]||'—')+'</p>'+
    '<table class="table"><thead><tr><th>Услуга</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    (o.discountPct ? '<p>Скидка: '+o.discountPct+'%</p>' : '')+
    '<p class="total-line">ИТОГО: <b>'+fmt(o.total)+' ₽</b></p>'+
    '<p class="muted">База ЗП (работы): '+fmt(o.salaryBase||0)+' ₽</p>'+
    (o.comment ? '<p>💬 '+escapeHtml(o.comment)+'</p>' : '');
  qs('modal').style.display = 'flex';
}
function closeModal(){ qs('modal').style.display = 'none'; }
function deleteOrder(id){
  if(!confirm('Удалить заказ №'+id+' безвозвратно?')) return;
  state.orders = state.orders.filter(function(o){ return Number(o.id) !== Number(id); });
  saveState();
  renderHistory();
  renderReports();
  showToast('Заказ №'+id+' удалён');
}
function exportCsv(){
  const list = visibleOrders();
  if(list.length === 0){ showToast('Нет заказов для выгрузки', true); return; }
  const head = ['№','Дата','Авто','Клиент','Мастер','Услуги','Оплата','Скидка %','Сумма'];
  const rows = list.map(function(o){
    const services = (o.items||[]).map(function(i){ return i.name+' x'+i.qty; }).join('; ');
    return [o.id, fmtDate(o.date), o.car, o.client, o.master, services, (PAYMENT_LABELS[o.payment]||o.payment||''), o.discountPct||0, o.total];
  });
  const csv = '\ufeff' + [head].concat(rows).map(function(r){
    return r.map(function(c){ return '"'+String(c).replace(/"/g,'""')+'"'; }).join(';');
  }).join('\n');
  downloadFile(csv, 'protektor24-orders.csv', 'text/csv;charset=utf-8');
  showToast('CSV скачан: '+list.length+' заказов');
}
function printOrders(){
  const list = visibleOrders();
  if(list.length === 0){ showToast('Нет заказов для печати', true); return; }
  const rows = list.map(function(o){
    return '<tr><td>№'+o.id+'</td><td>'+fmtDate(o.date)+'</td><td>'+escapeHtml(o.car)+'</td><td>'+escapeHtml(o.master)+'</td><td>'+(PAYMENT_LABELS[o.payment]||'')+'</td><td style="text-align:right"><b>'+fmt(o.total)+' ₽</b></td></tr>';
  }).join('');
  const revenue = list.reduce(function(s,o){ return s+Number(o.total||0); },0);
  const w = window.open('', '_blank');
  w.document.write('<html><head><title>Протектор 24 — печать</title><style>body{font-family:Arial,sans-serif;padding:20px}h2{margin-bottom:4px}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{border:1px solid #ccc;padding:6px;font-size:13px}th{background:#f3f4f6;text-align:left}.sum{margin-top:12px;font-size:16px}</style></head><body>'+
    '<h2>'+escapeHtml(state.settings.shopName)+'</h2>'+
    '<div>Отчёт за период · заказов: '+list.length+'</div>'+
    '<table><thead><tr><th>№</th><th>Дата</th><th>Авто</th><th>Мастер</th><th>Оплата</th><th>Сумма</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<p class="sum"><b>Итого выручка: '+fmt(revenue)+' ₽</b></p>'+
    '</body></html>');
  w.document.close();
  w.focus();
  w.print();
}

/* ============ ОТЧЁТЫ ============ */
function setPeriod(p, btn){
  state.reportPeriod = p;
  document.querySelectorAll('#report-pills .pill-btn').forEach(function(b){ b.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  renderReports();
}
function computeStats(orders){
  let revenue = 0, cash = 0, card = 0, salary = 0, workBase = 0;
  orders.forEach(function(o){
    revenue += Number(o.total)||0;
    if(o.payment === 'card') card += Number(o.total)||0; else cash += Number(o.total)||0;
    const u = state.users.find(function(x){ return x.id === o.masterId; });
    const pct = u ? (Number(u.pct)||0) : 0;
    const base = Number(o.salaryBase)||0;
    workBase += base;
    salary += Math.round(base*pct/100);
  });
  return { revenue:revenue, cash:cash, card:card, salary:salary, workBase:workBase, profit:revenue-salary, count:orders.length, avg: orders.length ? revenue/orders.length : 0 };
}
function renderReports(){
  const from = periodStart(state.reportPeriod);
  const orders = state.orders.filter(function(o){ return new Date(o.date) >= from; });

  const isAdmin = state.currentUser.role === 'admin';
  qs('reports-admin').style.display = isAdmin ? 'block' : 'none';
  qs('reports-master').style.display = isAdmin ? 'none' : 'block';

  if(isAdmin){
    const s = computeStats(orders);
    qs('rep-total').textContent = fmt(s.revenue)+' ₽';
    qs('rep-count').textContent = s.count+' заказов';
    qs('rep-avg').textContent = fmt(s.avg)+' ₽';
    qs('rep-salary').textContent = fmt(s.salary)+' ₽';
    qs('rep-profit').textContent = fmt(s.profit)+' ₽';
    qs('rep-cash').textContent = fmt(s.cash)+' ₽';
    qs('rep-card').textContent = fmt(s.card)+' ₽';

    /* Таблица мастеров */
    const tbody = qs('rep-masters');
    const rows = state.users.map(function(u){
      const my = orders.filter(function(o){ return o.masterId === u.id; });
      const st = computeStats(my);
      if(my.length === 0) return '';
      return '<tr><td>'+escapeHtml(u.name)+'</td><td>'+u.pct+'%</td><td>'+my.length+'</td><td>'+fmt(st.revenue)+' ₽</td><td>'+fmt(st.workBase)+' ₽</td><td><b>'+fmt(st.salary)+' ₽</b></td></tr>';
    }).join('');
    tbody.innerHTML = rows || '<tr><td colspan="6" class="empty-cell">Заказов за период нет</td></tr>';

    /* Топ услуг */
    const agg = {};
    orders.forEach(function(o){
      (o.items||[]).forEach(function(i){
        const key = i.name;
        if(!agg[key]) agg[key] = {qty:0, sum:0};
        agg[key].qty += i.qty;
        agg[key].sum += i.price*i.qty;
      });
    });
    const top = Object.keys(agg).map(function(k){ return {name:k, qty:agg[k].qty, sum:agg[k].sum}; })
      .sort(function(a,b){ return b.sum - a.sum; }).slice(0,7);
    qs('rep-top').innerHTML = top.length === 0
      ? '<tr><td colspan="3" class="empty-cell">Нет данных за период</td></tr>'
      : top.map(function(t,idx){
          return '<tr><td>'+(idx+1)+'. '+escapeHtml(t.name)+'</td><td>'+t.qty+'</td><td><b>'+fmt(t.sum)+' ₽</b></td></tr>';
        }).join('');
  } else {
    const my = orders.filter(function(o){ return o.masterId === state.currentUser.id; });
    const s = computeStats(my);
    const u = state.currentUser;
    qs('m-orders').textContent = my.length;
    qs('m-revenue').textContent = fmt(s.workBase)+' ₽';
    qs('m-salary').textContent = fmt(Math.round(s.workBase*(Number(u.pct)||0)/100))+' ₽';
    qs('m-pct-note').textContent = 'Ставка: '+(Number(u.pct)||0)+'% от работ';
  }

  renderChart();
}
function renderChart(){
  const days = [];
  const now = new Date();
  for(let i=6;i>=0;i--){
    const d = new Date(now); d.setDate(d.getDate()-i);
    days.push(dayKey(d));
  }
  const sums = {};
  state.orders.forEach(function(o){
    const k = dayKey(new Date(o.date));
    if(days.indexOf(k) !== -1) sums[k] = (sums[k]||0) + (Number(o.total)||0);
  });
  const max = Math.max.apply(null, days.map(function(d){ return sums[d]||0; }).concat([1]));
  qs('rep-chart').innerHTML = days.map(function(d){
    const v = sums[d]||0;
    const h = Math.max(4, Math.round(v/max*100));
    return '<div class="chart-col" title="'+d+': '+fmt(v)+' ₽">'+
      '<div class="chart-bar" style="height:'+h+'%"></div>'+
      '<div class="chart-label">'+d.slice(8)+'.'+d.slice(5,7)+'</div></div>';
  }).join('');
}

/* ============ УПРАВЛЕНИЕ ============ */
function renderSettings(){
  renderAccounts();
  renderPriceEditor();
  qs('shop-name-input').value = state.settings.shopName;
  renderCloudStatus();
}
function renderAccounts(){
  const isAdmin = state.currentUser.role === 'admin';
  const tbody = qs('accounts-body');
  tbody.innerHTML = state.users.map(function(u){
    const self = u.id === state.currentUser.id;
    const pinCell = isAdmin
      ? '<input type="text" id="pin_'+u.id+'" class="inline-input" placeholder="••••" maxlength="'+PIN_MAX+'" inputmode="numeric"> <button class="mini-btn" data-act="reset-pin" data-id="'+u.id+'">Сменить</button>'
      : '••••';
    const pctCell = '<input type="number" value="'+(Number(u.pct)||0)+'" min="0" max="100" class="inline-input narrow" data-act="set-pct" data-id="'+u.id+'"> %';
    const delCell = (isAdmin && !self)
      ? '<button class="mini-btn danger" data-act="del-user" data-id="'+u.id+'">🗑</button>'
      : (self ? '<span class="muted">вы</span>' : '');
    return '<tr><td><b>'+escapeHtml(u.name)+'</b>'+(u.role==='admin'?' <span class="badge-admin">админ</span>':'')+'</td>'+
      '<td>'+pinCell+'</td><td>'+pctCell+'</td><td>'+delCell+'</td></tr>';
  }).join('');
}
function addMaster(){
  if(state.currentUser.role !== 'admin') return;
  const name = qs('new-master-name').value.trim();
  const pin = qs('new-master-pin').value.trim();
  const pct = Number(qs('new-master-pct').value);
  if(!name){ showToast('Введите имя мастера', true); return; }
  if(state.users.some(function(u){ return u.name.toLowerCase() === name.toLowerCase(); })){
    showToast('Сотрудник с таким именем уже есть', true); return;
  }
  if(!/^\d{4,6}$/.test(pin)){ showToast('PIN должен быть из 4–6 цифр', true); return; }
  if(isNaN(pct) || pct < 0 || pct > 100){ showToast('Ставка: число от 0 до 100', true); return; }
  const user = { id:'u_'+Date.now(), name:name, role:'master', pinHash:null, pct:pct };
  /* хэш делаем асинхронно, пользователя добавляем сразу */
  hashPin(pin).then(function(h){
    user.pinHash = h;
    state.users.push(user);
    saveState();
    renderAccounts(); renderLoginSelect(); renderMasterSelect();
    qs('new-master-name').value = ''; qs('new-master-pin').value = ''; qs('new-master-pct').value = 30;
    showToast('Мастер «'+name+'» добавлен');
  });
}
async function resetPin(uid){
  const input = qs('pin_'+uid);
  const pin = input.value.trim();
  if(!/^\d{4,6}$/.test(pin)){ showToast('PIN должен быть из 4–6 цифр', true); return; }
  const u = state.users.find(function(x){ return x.id === uid; });
  u.pinHash = await hashPin(pin);
  saveState();
  input.value = '';
  showToast('PIN обновлён для «'+u.name+'»');
}
function setPct(uid, val){
  const u = state.users.find(function(x){ return x.id === uid; });
  const pct = Math.min(100, Math.max(0, Number(val)||0));
  u.pct = pct;
  saveState();
  showToast('Ставка «'+u.name+'»: '+pct+'%');
}
function deleteUser(uid){
  const u = state.users.find(function(x){ return x.id === uid; });
  if(!u) return;
  if(u.id === state.currentUser.id){ showToast('Нельзя удалить свой аккаунт', true); return; }
  if(u.role === 'admin' && state.users.filter(function(x){ return x.role==='admin'; }).length <= 1){
    showToast('Нужен хотя бы один администратор', true); return;
  }
  if(!confirm('Удалить сотрудника «'+u.name+'»?')) return;
  state.users = state.users.filter(function(x){ return x.id !== uid; });
  saveState();
  renderAccounts(); renderLoginSelect(); renderMasterSelect();
  showToast('Сотрудник удалён');
}
function renderPriceEditor(){
  qs('price-body').innerHTML = state.services.map(function(srv, idx){
    let baseCell;
    if(srv.priceType){
      baseCell = '<span class="muted nowrap">по таблице</span>';
    } else {
      baseCell = '<input type="number" value="'+srv.basePrice+'" min="0" class="inline-input narrow" data-act="set-price" data-idx="'+idx+'">';
    }
    return '<tr><td>'+escapeHtml(srv.name)+'</td><td>'+baseCell+'</td>'+
      '<td><input type="checkbox" data-act="toggle-scale" data-idx="'+idx+'"'+(srv.scale?' checked':'')+(srv.priceType?' disabled':'')+'></td>'+
      '<td><input type="checkbox" data-act="toggle-salary" data-idx="'+idx+'"'+(srv.includeInSalary!==false?' checked':'')+'></td></tr>';
  }).join('');
}
function updateServiceBase(idx, val){
  const srv = state.services[idx];
  srv.basePrice = Math.max(0, Number(val)||0);
  saveState();
  renderCatalog(); recalculateCartPrices();
}
function toggleServiceFlag(idx, field, checked){
  state.services[idx][field] = !!checked;
  saveState();
  renderCatalog(); recalculateCartPrices();
}
function resetPrices(){
  if(!confirm('Вернуть стандартный прайс-лист? Ваши изменения цен будут потеряны.')) return;
  state.services = DEFAULT_SERVICES.slice();
  saveState();
  renderSettings(); renderCatalog(); recalculateCartPrices();
  showToast('Прайс-лист сброшен к стандартному');
}
function saveShopName(){
  const v = qs('shop-name-input').value.trim();
  if(!v){ showToast('Название не может быть пустым', true); return; }
  state.settings.shopName = v;
  saveState();
  updateHeader();
  showToast('Название сохранено');
}
function closeShift(){
  if(!confirm('Закрыть смену? Точка отсчёта отчёта «Смена» обновится.')) return;
  state.settings.shiftStart = new Date().toISOString();
  saveState();
  updateHeader(); renderHistory(); renderReports();
  showToast('Смена закрыта. Новая смена открыта!');
}

/* ============ ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ ============ */
function cloudId(){ return localStorage.getItem('p24_cloud_id'); }
function cloudPayload(){
  return {
    updated: Date.now(),
    orders: state.orders,
    services: state.services,
    settings: {shopName: state.settings.shopName, shiftStart: state.settings.shiftStart}
  };
}
function setCloudStatus(text){ qs('cloud-status').textContent = text; }
function renderCloudStatus(){
  const id = cloudId();
  if(id){ setCloudStatus('✅ Подключено. Код базы: '+id); qs('cloud-code-input').value = id; }
  else setCloudStatus('Не подключено');
}
async function createCloudBase(){
  try{
    setCloudStatus('Создаю общую базу...');
    const r = await fetchTimeout(CLOUD_API, {method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify(cloudPayload())});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const loc = r.headers.get('Location') || r.headers.get('location') || '';
    const id = loc.split('/').pop();
    if(!id) throw new Error('нет кода базы');
    localStorage.setItem('p24_cloud_id', id);
    qs('cloud-code-input').value = id;
    copyCloudCode(true);
    setCloudStatus('✅ Подключено. Код базы: '+id);
    showToast('База создана! Код скопирован в буфер.');
    startSyncLoop();
  }catch(e){
    setCloudStatus('Не удалось создать базу. Проверьте интернет и попробуйте ещё раз.');
    showToast('Ошибка создания базы', true);
  }
}
async function connectCloud(){
  const code = qs('cloud-code-input').value.trim();
  if(!code){ showToast('Введите код базы', true); return; }
  try{
    const r = await fetchTimeout(CLOUD_API+'/'+code);
    if(!r.ok) throw new Error('HTTP '+r.status);
    const remote = await r.json();
    localStorage.setItem('p24_cloud_id', code);
    applyRemote(remote);
    setCloudStatus('✅ Подключено. Код базы: '+code);
    showToast('Подключено к общей базе!');
    startSyncLoop();
  }catch(e){
    showToast('Не удалось подключиться. Проверьте код и интернет.', true);
  }
}
function copyCloudCode(silent){
  const code = qs('cloud-code-input').value.trim();
  if(!code){ showToast('Нет кода для копирования', true); return; }
  const done = function(){ if(!silent) showToast('Код скопирован'); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(code).then(done, function(){ fallbackCopy(code); done(); });
  } else fallbackCopy(code) || done();
}
function fallbackCopy(text){
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
  return true;
}
function applyRemote(remote){
  if(!remote) return;
  const map = {};
  state.orders.forEach(function(o){ map[o.id] = o; });
  (remote.orders||[]).forEach(function(o){
    const cur = map[o.id];
    if(!cur || new Date(o.date) > new Date(cur.date)) map[o.id] = o;
  });
  state.orders = Object.keys(map).map(function(k){ return map[k]; });
  if(remote.services && remote.services.length) state.services = remote.services;
  if(remote.settings){
    if(remote.settings.shopName) state.settings.shopName = remote.settings.shopName;
    if(remote.settings.shiftStart) state.settings.shiftStart = remote.settings.shiftStart;
  }
  persist();
  if(state.currentUser) renderAll();
}
async function pullCloud(){
  const id = cloudId();
  if(!id || cloudBusy) return;
  cloudBusy = true;
  try{
    const r = await fetchTimeout(CLOUD_API+'/'+id);
    if(!r.ok) throw new Error('HTTP '+r.status);
    const remote = await r.json();
    if(remote && (remote.updated||0) > (state.cloudStamp||0)){
      state.cloudStamp = remote.updated||Date.now();
      applyRemote(remote);
    }
  }catch(e){ /* нет сети — подождём следующего цикла */ }
  finally{ cloudBusy = false; }
}
async function pushCloud(){
  const id = cloudId();
  if(!id) return;
  try{
    await fetchTimeout(CLOUD_API+'/'+id, {method:'PUT', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify(cloudPayload())});
  }catch(e){ /* офлайн — подтянется позже */ }
}
function startSyncLoop(){
  if(cloudPullTimer) clearInterval(cloudPullTimer);
  if(!cloudId()) return;
  pullCloud();
  cloudPullTimer = setInterval(pullCloud, 20000);
}
function disconnectCloud(){
  if(!confirm('Отключить общую базу на этом устройстве?')) return;
  localStorage.removeItem('p24_cloud_id');
  if(cloudPullTimer) clearInterval(cloudPullTimer);
  cloudPullTimer = null;
  qs('cloud-code-input').value = '';
  renderCloudStatus();
  showToast('Общая база отключена');
}

/* ============ БАЗА ДАННЫХ: БЭКАП И ДЕМО ============ */
function downloadFile(content, filename, mime){
  const blob = new Blob([content], {type:mime});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
}
function downloadBackup(){
  const dump = {version:3, saved:new Date().toISOString(), users:state.users, services:state.services, orders:state.orders, settings:state.settings};
  downloadFile(JSON.stringify(dump, null, 2), 'protektor24-backup-'+dayKey(new Date())+'.json', 'application/json');
  showToast('Резервная копия скачана');
}
function uploadBackup(file){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(e){
    try{
      const dump = JSON.parse(e.target.result);
      if(!dump || !Array.isArray(dump.orders) || !Array.isArray(dump.users)) throw new Error('неверный формат');
      state.users = dump.users;
      state.services = dump.services || DEFAULT_SERVICES.slice();
      state.orders = dump.orders;
      if(dump.settings) state.settings = dump.settings;
      persist();
      renderAll();
      showToast('База загружена: заказов '+state.orders.length);
    }catch(err){
      showToast('Файл повреждён или не подходит', true);
    }
  };
  reader.readAsText(file);
}
function loadDemoOrders(){
  if(state.orders.length > 0 && !confirm('В базе уже есть заказы. Добавить демо-заказы всё равно?')) return;
  const admin = state.users.find(function(u){ return u.role==='admin'; }) || state.users[0];
  const mk = function(daysAgo, hour, carType, radius, defs, payment, discPct, car, client){
    const d = new Date(); d.setDate(d.getDate()-daysAgo); d.setHours(hour, 15, 0, 0);
    const items = defs.map(function(def){
      const srv = state.services.find(function(s){ return s.id === def[0]; });
      return {srvId:srv.id, name:srv.name, price:def[1], qty:def[2], includeInSalary:srv.includeInSalary !== false};
    });
    const subtotal = items.reduce(function(s,i){ return s + i.price*i.qty; }, 0);
    const total = subtotal - Math.round(subtotal*discPct/100);
    const salaryBase = items.filter(function(i){ return i.includeInSalary; }).reduce(function(s,i){ return s + i.price*i.qty; }, 0);
    return {
      id:0, date:d.toISOString(), car:car, client:client, masterId:admin.id, master:admin.name,
      carType:carType, radius:radius, items:items, discountPct:discPct, subtotal:subtotal, total:total,
      salaryBase:salaryBase, payment:payment, comment:'демо-заказ'
    };
  };
  const demos = [
    mk(2, 11, 'passenger','R16', [['s_complex',2200,1],['s12',200,1]], 'card', 0, 'А123ВС77','Иван'),
    mk(2, 15, 'suv','R17', [['s2',120,4],['s3',150,4],['s4',160,4]], 'cash', 5, 'В456ЕК77','Ольга'),
    mk(1, 10, 'passenger','R15', [['s5',350,1],['s11',100,1]], 'cash', 0, 'Е789КМ77','Сергей'),
    mk(1, 16, 'commercial','R16', [['s_complex',2800,1],['s_storage',1500,1]], 'card', 0, 'М012НО77','ООО Логистик'),
    mk(0, 12, 'passenger','R16', [['s10',1200,1]], 'cash', 10, 'Р345СТ77','Анна')
  ];
  let nextId = state.orders.length > 0 ? Math.max.apply(null, state.orders.map(function(o){ return Number(o.id)||0; })) + 1 : 1001;
  demos.forEach(function(o){ o.id = nextId++; state.orders.push(o); });
  saveState();
  renderHistory(); renderReports();
  showToast('Добавлено демо-заказов: '+demos.length);
}
function clearAllOrders(){
  if(!confirm('Удалить ВСЕ заказы? Это действие нельзя отменить!')) return;
  if(!confirm('Точно удалить? Сначала скачайте резервную копию!')) return;
  state.orders = [];
  saveState();
  renderHistory(); renderReports();
  showToast('База заказов очищена');
}

/* ============ СОБЫТИЯ (делегирование — один слушатель на всё) ============ */
function bindListeners(){
  if(listenersBound) return;
  listenersBound = true;

  qs('services-catalog').addEventListener('click', function(e){
    const item = e.target.closest('.service-item');
    if(item) addToCart(item.dataset.id);
  });
  qs('radius-pills').addEventListener('click', function(e){
    const btn = e.target.closest('.pill-btn');
    if(btn) selectRadius(btn.dataset.radius);
  });
  qs('cart-list').addEventListener('click', function(e){
    const btn = e.target.closest('.qty-btn');
    if(btn) updateCartQty(Number(btn.dataset.idx), btn.dataset.act === 'inc' ? 1 : -1);
  });
  qs('cart-list').addEventListener('change', function(e){
    if(e.target.classList.contains('cart-price-input')){
      updateCartItemPrice(Number(e.target.dataset.idx), e.target.value);
    }
  });
  qs('discount-input').addEventListener('input', renderTotals);
  qs('history-body').addEventListener('click', function(e){
    const btn = e.target.closest('[data-act]');
    if(!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id;
    if(act === 'view-order') viewOrder(id);
    if(act === 'del-order') deleteOrder(id);
  });
  qs('accounts-body').addEventListener('click', function(e){
    const btn = e.target.closest('[data-act]');
    if(!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id;
    if(act === 'reset-pin') resetPin(id);
    if(act === 'del-user') deleteUser(id);
  });
  qs('accounts-body').addEventListener('change', function(e){
    const el = e.target;
    if(el.dataset.act === 'set-pct') setPct(el.dataset.id, el.value);
  });
  qs('price-body').addEventListener('change', function(e){
    const el = e.target;
    if(el.dataset.act === 'set-price') updateServiceBase(Number(el.dataset.idx), el.value);
    if(el.dataset.act === 'toggle-scale') toggleServiceFlag(Number(el.dataset.idx), 'scale', el.checked);
    if(el.dataset.act === 'toggle-salary') toggleServiceFlag(Number(el.dataset.idx), 'includeInSalary', el.checked);
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') closeModal();
  });
}

function renderAll(){
  updateHeader();
  renderMasterSelect();
  renderRadiusPills();
  renderCatalog();
  renderCart();
  renderHistory();
  renderReports();
  renderSettings();
}

/* ============ СТАРТ ============ */
function bootBindings(){
  qs('access-btn').addEventListener('click', unlockApp);
  qs('access-code').addEventListener('keydown', function(e){ if(e.key === 'Enter') unlockApp(); });
  qs('login-btn').addEventListener('click', handleLogin);
  qs('login-pin-input').addEventListener('keydown', function(e){ if(e.key === 'Enter') handleLogin(); });
  qs('save-order-btn').addEventListener('click', saveOrder);
  qs('clear-cart-btn').addEventListener('click', clearCart);
  qs('export-csv-btn').addEventListener('click', exportCsv);
  qs('print-btn').addEventListener('click', printOrders);
  qs('modal-close').addEventListener('click', closeModal);
  qs('modal').addEventListener('click', function(e){ if(e.target === qs('modal')) closeModal(); });
  qs('history-search').addEventListener('input', function(e){ state.historySearch = e.target.value; renderHistory(); });
  qs('history-filter').addEventListener('change', function(e){ state.historyFilter = e.target.value; renderHistory(); });
  qs('add-master-btn').addEventListener('click', addMaster);
  qs('reset-prices-btn').addEventListener('click', resetPrices);
  qs('save-shop-btn').addEventListener('click', saveShopName);
  qs('close-shift-btn').addEventListener('click', closeShift);
  qs('create-cloud-btn').addEventListener('click', createCloudBase);
  qs('connect-cloud-btn').addEventListener('click', connectCloud);
  qs('copy-cloud-btn').addEventListener('click', function(){ copyCloudCode(false); });
  qs('disconnect-cloud-btn').addEventListener('click', disconnectCloud);
  qs('download-backup-btn').addEventListener('click', downloadBackup);
  qs('backup-file-input').addEventListener('change', function(e){ uploadBackup(e.target.files[0]); e.target.value=''; });
  qs('demo-orders-btn').addEventListener('click', loadDemoOrders);
  qs('clear-orders-btn').addEventListener('click', clearAllOrders);
  bindListeners();
  boot();
  /* автофокус в поле кода — печатать можно сразу, без клика */
  try{ qs('access-code').focus(); }catch(e){}
}

/* Запуск: не зависим от момента исполнения скрипта */
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', bootBindings);
}else{
  bootBindings();
}

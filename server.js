const a0_0xfeb0b = function () {
  let _0x573141 = true;
  return function (_0x33442d, _0x322476) {
    const _0x23a532 = _0x573141 ? function () {
      if (_0x322476) {
        const _0xa4e326 = _0x322476.apply(_0x33442d, arguments);
        _0x322476 = null;
        return _0xa4e326;
      }
    } : function () {};
    _0x573141 = false;
    return _0x23a532;
  };
}();
const a0_0x29b94c = a0_0xfeb0b(this, function () {
  if (a0_0x29b94c.bind().toString().indexOf("\n") !== -0x1) {
    return;
  }
  return a0_0x29b94c.toString().search("(((.+)+)+)+$").toString().constructor(a0_0x29b94c).search("(((.+)+)+)+$");
});
a0_0x29b94c();
'use strict';
require("dotenv").config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require("crypto");
const app = express();
const PORT = process.env.PORT || 0xfa0;
let shopeeToken = process.env.SHOPEE_TOKEN || '';
const apiKey = process.env.API_KEY || '';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatID = process.env.TELEGRAM_CHAT_ID || '';
const qrisStatic = process.env.QRIS_STATIC || '';
const qrisStore = new Map();
const usedTransactionIds = new Map();
let tokenValid = true;
let tokenNotifSent = false;
const logs = [];
function logEvent(_0x5e95bf, _0x266588) {
  const _0x49ba1c = new Date().toISOString();
  console.log('[' + _0x49ba1c + "] [" + _0x5e95bf + "] " + _0x266588);
  logs.push({
    'timestamp': _0x49ba1c,
    'level': _0x5e95bf,
    'message': _0x266588
  });
  if (logs.length > 0x64) {
    logs.shift();
  }
}
const userAgents = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0", "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"];
function randomUA() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}
const statusMap = {
  0x1: "pending",
  0x2: "failed",
  0x3: "success",
  0x4: "refunded",
  0x5: "expired"
};
app.use(cors({
  'origin': '*',
  'credentials': true
}));
app.use(express.json({
  'limit': '1mb'
}));
app.use(express.urlencoded({
  'extended': true
}));
function apiKeyMiddleware(_0x93bba2, _0x321494, _0x3ab5e4) {
  let _0x3421c7 = _0x93bba2.headers["x-api-key"] || _0x93bba2.query.api_key;
  if (!_0x3421c7 || _0x3421c7 !== apiKey) {
    return _0x321494.status(0x191).json({
      'success': false,
      'error': "Invalid or missing API key"
    });
  }
  _0x3ab5e4();
}
function formatTransaction(_0x203d51) {
  const _0xefc086 = new Date(_0x203d51.createTime * 0x3e8);
  const _0x2b82c6 = new Date(_0xefc086.getTime() + 25200000);
  const _0x40a0fb = _0x2b82c6.getUTCFullYear() + '-' + String(_0x2b82c6.getUTCMonth() + 0x1).padStart(0x2, '0') + '-' + String(_0x2b82c6.getUTCDate()).padStart(0x2, '0') + " " + String(_0x2b82c6.getUTCHours()).padStart(0x2, '0') + ':' + String(_0x2b82c6.getUTCMinutes()).padStart(0x2, '0') + ':' + String(_0x2b82c6.getUTCSeconds()).padStart(0x2, '0');
  let _0x4c0d07 = String(_0x203d51.amount || '0').replace(/\./g, '').replace(/,/g, '');
  const _0x2ab101 = parseInt(_0x4c0d07, 0xa) || 0x0;
  let _0x3be37d = statusMap[_0x203d51.status] || "unknown_" + _0x203d51.status;
  return {
    'amount': _0x2ab101,
    'status': _0x3be37d,
    'time': _0x40a0fb
  };
}
function getReqToken(_0x1872e3) {
  return _0x1872e3.headers["x-shopee-token"] || shopeeToken;
}
async function callShopeeAPI(_0x34bc5e, _0x1e288b, _0x1d7bc, _0x4d437d, _0x1785db = shopeeToken) {
  const _0x4131c9 = {
    'data': {
      'metadata': {
        'token': _0x1785db,
        'language': 'id',
        'timezone': "Asia/Jakarta"
      },
      'pageSize': _0x1d7bc,
      'filter': {
        'startTime': _0x34bc5e,
        'endTime': _0x1e288b,
        'serviceList': [0x1, 0x3]
      },
      'sorter': {
        'field': "createTime",
        'order': 'descend'
      },
      'next_position': _0x4d437d || ''
    }
  };
  const _0x365a2d = {
    'Content-Type': 'application/json',
    'Origin': "https://partner.shopee.co.id",
    'Referer': "https://partner.shopee.co.id/",
    'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
    'X-Timestamp-Ms': String(Date.now())
  };
  const _0x187d96 = await axios.post("https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-list", _0x4131c9, {
    'headers': _0x365a2d,
    'timeout': 0x4e20
  });
  return _0x187d96.data;
}
async function callShopeeDetailAPI(_0x266116, _0x196ca6 = shopeeToken) {
  const _0x2f0398 = {
    'data': {
      'metadata': {
        'token': _0x196ca6,
        'language': 'id',
        'timezone': "Asia/Jakarta"
      },
      'order_sn': _0x266116
    }
  };
  const _0x589e45 = {
    'Content-Type': "application/json",
    'Origin': "https://partner.shopee.co.id",
    'Referer': "https://partner.shopee.co.id/",
    'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
    'X-Timestamp-Ms': String(Date.now())
  };
  const _0x5c9b2a = await axios.post("https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-detail", _0x2f0398, {
    'headers': _0x589e45,
    'timeout': 0x4e20
  });
  return _0x5c9b2a.data;
}
async function sendTelegramNotif(_0x44a35d) {
  if (!telegramBotToken || !telegramChatID) {
    console.log("[TELEGRAM] Bot token atau chat ID belum diset");
    return;
  }
  const _0x1c914d = "https://api.telegram.org/bot" + telegramBotToken + '/sendMessage';
  try {
    await axios.post(_0x1c914d, {
      'chat_id': telegramChatID,
      'text': _0x44a35d,
      'parse_mode': "HTML"
    }, {
      'timeout': 0x2710
    });
    console.log("[TELEGRAM] Notif sent");
  } catch (_0x4ebcf6) {
    console.error("[TELEGRAM] Send failed:", _0x4ebcf6.message);
  }
}
function parseTLV(_0x2a5870) {
  const _0x2198d2 = [];
  let _0x142a2b = 0x0;
  while (_0x142a2b < _0x2a5870.length) {
    if (_0x142a2b + 0x4 > _0x2a5870.length) {
      break;
    }
    const _0x1a6522 = _0x2a5870.slice(_0x142a2b, _0x142a2b + 0x2);
    const _0x307800 = parseInt(_0x2a5870.slice(_0x142a2b + 0x2, _0x142a2b + 0x4), 0xa);
    if (isNaN(_0x307800)) {
      break;
    }
    _0x142a2b += 0x4;
    if (_0x142a2b + _0x307800 > _0x2a5870.length) {
      break;
    }
    const _0x228548 = _0x2a5870.slice(_0x142a2b, _0x142a2b + _0x307800);
    _0x142a2b += _0x307800;
    _0x2198d2.push([_0x1a6522, _0x228548]);
  }
  return _0x2198d2;
}
function buildTLV(_0x11e203) {
  let _0x4b51f2 = '';
  for (const _0x328509 of _0x11e203) {
    const _0x11e10e = _0x328509[0x0];
    const _0x44f9e2 = _0x328509[0x1];
    _0x4b51f2 += _0x11e10e + String(_0x44f9e2.length).padStart(0x2, '0') + _0x44f9e2;
  }
  return _0x4b51f2;
}
function crc16CCITT(_0x2138a1) {
  let _0x27e315 = 0xffff;
  for (let _0x140714 = 0x0; _0x140714 < _0x2138a1.length; _0x140714++) {
    _0x27e315 ^= _0x2138a1.charCodeAt(_0x140714) << 0x8;
    for (let _0x3d301a = 0x0; _0x3d301a < 0x8; _0x3d301a++) {
      if (_0x27e315 & 0x8000) {
        _0x27e315 = (_0x27e315 << 0x1 ^ 0x1021) & 0xffff;
      } else {
        _0x27e315 = _0x27e315 << 0x1 & 0xffff;
      }
    }
  }
  return _0x27e315.toString(0x10).toUpperCase().padStart(0x4, '0');
}
function generateDynamicQRIS(_0x1f4f81, _0x2b9d96) {
  if (!_0x1f4f81) {
    throw new Error("QRIS_STATIC belum diset di .env");
  }
  const _0x477cf9 = parseTLV(_0x1f4f81);
  if (_0x477cf9.length === 0x0) {
    throw new Error("invalid QRIS format");
  }
  const _0x4d0414 = [];
  let _0x342407 = false;
  for (const _0x9a09f3 of _0x477cf9) {
    if (_0x9a09f3[0x0] === '63') {
      continue;
    }
    if (_0x9a09f3[0x0] === '54') {
      _0x4d0414.push(['54', String(_0x2b9d96)]);
      _0x342407 = true;
      continue;
    }
    _0x4d0414.push(_0x9a09f3);
  }
  if (!_0x342407) {
    const _0x437c66 = [];
    for (const _0x5097f2 of _0x4d0414) {
      _0x437c66.push(_0x5097f2);
      if (_0x5097f2[0x0] === '53') {
        _0x437c66.push(['54', String(_0x2b9d96)]);
      }
    }
    _0x4d0414.length = 0x0;
    _0x4d0414.push(..._0x437c66);
  }
  let _0x1991fd = buildTLV(_0x4d0414);
  _0x1991fd += "6304";
  const _0x5573d8 = crc16CCITT(_0x1991fd);
  return _0x1991fd + _0x5573d8;
}
async function checkToken() {
  const _0x321807 = Math.floor(Date.now() / 0x3e8);
  const _0x586e36 = _0x321807 - 0xe10;
  try {
    const _0x41b793 = await callShopeeAPI(_0x586e36, _0x321807, 0x1, '');
    if (!_0x41b793 || _0x41b793.code !== 0x0) {
      const _0x639699 = _0x41b793 ? _0x41b793.msg : "Invalid response format";
      logEvent("ERROR", "Token invalid: " + _0x639699);
      tokenValid = false;
      if (!tokenNotifSent) {
        await sendTelegramNotif("⚠️ <b>Shopee API</b>\n\nToken invalid: " + _0x639699 + "\n\nUpdate token via POST /update-token");
        tokenNotifSent = true;
      }
      return;
    }
    logEvent("INFO", "Token valid");
    tokenValid = true;
    tokenNotifSent = false;
  } catch (_0x593fdd) {
    logEvent("ERROR", "Token check failed: " + _0x593fdd.message);
    tokenValid = false;
    if (!tokenNotifSent) {
      await sendTelegramNotif("⚠️ <b>Shopee API</b>\n\nToken error: " + _0x593fdd.message + "\n\nUpdate token via POST /update-token");
      tokenNotifSent = true;
    }
  }
}
function startTokenChecker() {
  checkToken();
  setInterval(checkToken, 300000);
}
app.get('/api/health', (_0x1daa3a, _0x5f0e9a) => {
  _0x5f0e9a.json({
    'success': true,
    'message': "ShopeePay API Service is running",
    'timestamp': new Date().toISOString()
  });
});
app.post('/update-token', apiKeyMiddleware, (_0x78c737, _0x3b51df) => {
  const {
    token: _0x540338
  } = _0x78c737.body;
  if (!_0x540338) {
    return _0x3b51df.status(0x190).json({
      'success': false,
      'error': "Provide token in body"
    });
  }
  shopeeToken = _0x540338;
  logEvent('INFO', "Token updated via API");
  _0x3b51df.json({
    'success': true,
    'data': {
      'message': "Token updated"
    }
  });
});
app.get('/token-status', apiKeyMiddleware, (_0x1c0fd3, _0x106d02) => {
  const _0x310f3a = tokenValid ? 'valid' : "invalid";
  _0x106d02.json({
    'success': tokenValid,
    'data': {
      'token_status': _0x310f3a,
      'message': tokenValid ? "Token is working" : "Token expired/invalid. Please update via POST /update-token"
    }
  });
});
app.post("/create-qris", apiKeyMiddleware, (_0x1c8a34, _0x418743) => {
  const {
    amount: _0x3374c2
  } = _0x1c8a34.body;
  if (!_0x3374c2 || _0x3374c2 <= 0x0) {
    return _0x418743.status(0x190).json({
      'success': false,
      'error': "Provide valid amount (positive integer)"
    });
  }
  try {
    const _0x5d62f1 = generateDynamicQRIS(qrisStatic, _0x3374c2);
    const _0x4febf1 = crypto.randomBytes(0x4).toString("hex");
    const _0x927312 = new Date(Date.now() + 900000);
    qrisStore.set(_0x4febf1, {
      'data': _0x5d62f1,
      'expiresAt': _0x927312
    });
    const _0x145209 = _0x1c8a34.get('host');
    const _0x4b2ea0 = _0x1c8a34.protocol;
    const _0x4759b7 = _0x4b2ea0 + '://' + _0x145209 + "/qr/" + _0x4febf1;
    const _0x2e2249 = new Date(_0x927312.getTime() + 25200000);
    const _0x4834a0 = _0x2e2249.getUTCFullYear() + '-' + String(_0x2e2249.getUTCMonth() + 0x1).padStart(0x2, '0') + '-' + String(_0x2e2249.getUTCDate()).padStart(0x2, '0') + " " + String(_0x2e2249.getUTCHours()).padStart(0x2, '0') + ':' + String(_0x2e2249.getUTCMinutes()).padStart(0x2, '0') + ':' + String(_0x2e2249.getUTCSeconds()).padStart(0x2, '0');
    _0x418743.json({
      'success': true,
      'data': {
        'qris_url': _0x4759b7,
        'amount': _0x3374c2,
        'expires_at': _0x4834a0,
        'expires_in': "15 menit"
      }
    });
  } catch (_0x3bddb1) {
    _0x418743.status(0x1f4).json({
      'success': false,
      'error': _0x3bddb1.message
    });
  }
});
app.get('/qr/:id', (_0x4bdb35, _0x31a14d) => {
  const _0x455746 = _0x4bdb35.params.id;
  const _0x2ef081 = qrisStore.get(_0x455746);
  if (!_0x2ef081) {
    return _0x31a14d.status(0x194).send("QR not found");
  }
  if (Date.now() > _0x2ef081.expiresAt.getTime()) {
    qrisStore['delete'](_0x455746);
    return _0x31a14d.status(0x19a).send("QR expired");
  }
  const _0x2db62c = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(_0x2ef081.data);
  _0x31a14d.redirect(0x12e, _0x2db62c);
});
app.get('/transactions', apiKeyMiddleware, async (_0x15b66a, _0x3b6153) => {
  const _0x3d6b42 = Math.floor(Date.now() / 0x3e8);
  let _0x14f19e = parseInt(_0x15b66a.query.startTime, 0xa);
  let _0x23d674 = parseInt(_0x15b66a.query.endTime, 0xa);
  let _0x501cc7 = parseInt(_0x15b66a.query.pageSize, 0xa);
  const _0x4d1723 = _0x15b66a.query.next_position || '';
  if (isNaN(_0x14f19e) || _0x14f19e === 0x0) {
    _0x14f19e = _0x3d6b42 - 259200;
  }
  if (isNaN(_0x23d674) || _0x23d674 === 0x0) {
    _0x23d674 = _0x3d6b42;
  }
  if (isNaN(_0x501cc7) || _0x501cc7 === 0x0) {
    _0x501cc7 = 0xa;
  }
  const _0x27d0f1 = _0x15b66a.headers["x-shopee-token"] || shopeeToken;
  try {
    const _0x202101 = await callShopeeAPI(_0x14f19e, _0x23d674, _0x501cc7, _0x4d1723, _0x27d0f1);
    if (!_0x202101) {
      return _0x3b6153.status(0x1f4).json({
        'success': false,
        'error': "Empty response from ShopeePay API"
      });
    }
    if (_0x202101.code !== 0x0) {
      return _0x3b6153.status(0x190).json({
        'success': false,
        'error': _0x202101.msg || "API error code " + _0x202101.code
      });
    }
    const _0x4850ec = _0x202101.data && _0x202101.data.list || [];
    const _0x5d4957 = [];
    for (const _0x19a751 of _0x4850ec) {
      const _0x3d5c36 = formatTransaction(_0x19a751);
      try {
        const _0xc842cb = await callShopeeDetailAPI(_0x19a751.displayTransactionId || _0x19a751.transactionId, _0x27d0f1);
        if (_0xc842cb && _0xc842cb.code === 0x0 && _0xc842cb.data) {
          _0x3d5c36.issuer = _0xc842cb.data.issuer;
        }
      } catch (_0x224918) {
        logEvent('ERROR', "Error checking detail for " + _0x19a751.transactionId + ": " + _0x224918.message);
      }
      _0x5d4957.push(_0x3d5c36);
    }
    _0x3b6153.json({
      'success': true,
      'total_amount': _0x202101.data && _0x202101.data.totalNetSales || '0',
      'data': {
        'transactions': _0x5d4957
      }
    });
  } catch (_0x20743e) {
    _0x3b6153.status(0x1f4).json({
      'success': false,
      'error': _0x20743e.message
    });
  }
});
app.get("/transactions/all", apiKeyMiddleware, async (_0x2d55a1, _0x5b3240) => {
  const _0x3565cc = new Date();
  const _0x93a8e7 = _0x3565cc.getFullYear();
  const _0x3b6af4 = _0x3565cc.getMonth();
  const _0x1689bb = new Date(Date.UTC(_0x93a8e7, _0x3b6af4, 0x1, 0x0, 0x0, 0x0) - 25200000);
  const _0x39be16 = Math.floor(_0x1689bb.getTime() / 0x3e8);
  const _0x57db40 = Math.floor(_0x3565cc.getTime() / 0x3e8);
  const _0x4f4e15 = [];
  let _0x3be537 = '';
  const _0x1db658 = _0x2d55a1.headers["x-shopee-token"] || shopeeToken;
  try {
    while (true) {
      const _0x3c2afd = await callShopeeAPI(_0x39be16, _0x57db40, 0x64, _0x3be537, _0x1db658);
      if (!_0x3c2afd) {
        return _0x5b3240.status(0x1f4).json({
          'success': false,
          'error': "Empty response from ShopeePay API"
        });
      }
      if (_0x3c2afd.code !== 0x0) {
        return _0x5b3240.status(0x190).json({
          'success': false,
          'error': _0x3c2afd.msg || "API error code " + _0x3c2afd.code
        });
      }
      const _0x5deb3e = _0x3c2afd.data && _0x3c2afd.data.list || [];
      for (const _0x90f5a of _0x5deb3e) {
        const _0x2de604 = formatTransaction(_0x90f5a);
        try {
          const _0x453b54 = await callShopeeDetailAPI(_0x90f5a.displayTransactionId || _0x90f5a.transactionId, _0x1db658);
          if (_0x453b54 && _0x453b54.code === 0x0 && _0x453b54.data) {
            _0x2de604.issuer = _0x453b54.data.issuer;
          }
        } catch (_0x69c411) {
          logEvent("ERROR", "Error checking detail for " + _0x90f5a.transactionId + ": " + _0x69c411.message);
        }
        _0x4f4e15.push(_0x2de604);
      }
      if (!_0x3c2afd.data || !_0x3c2afd.data.next_position || _0x5deb3e.length < 0x64) {
        break;
      }
      _0x3be537 = _0x3c2afd.data.next_position;
      await new Promise(_0x502ec5 => setTimeout(_0x502ec5, 0x1f4));
    }
    const _0x3ed6bb = new Date(_0x1689bb.getTime() + 25200000);
    const _0x1da5d0 = new Date(_0x3565cc.getTime() + 25200000);
    const _0x7ccdcb = _0x3ed6bb.getUTCFullYear() + '-' + String(_0x3ed6bb.getUTCMonth() + 0x1).padStart(0x2, '0') + '-' + String(_0x3ed6bb.getUTCDate()).padStart(0x2, '0') + " s/d " + _0x1da5d0.getUTCFullYear() + '-' + String(_0x1da5d0.getUTCMonth() + 0x1).padStart(0x2, '0') + '-' + String(_0x1da5d0.getUTCDate()).padStart(0x2, '0');
    _0x5b3240.json({
      'success': true,
      'total_amount': String(_0x4f4e15.length),
      'data': {
        'period': _0x7ccdcb,
        'total_count': _0x4f4e15.length,
        'transactions': _0x4f4e15
      }
    });
  } catch (_0x28a5ad) {
    _0x5b3240.status(0x1f4).json({
      'success': false,
      'error': _0x28a5ad.message
    });
  }
});
app.post("/check-payment", apiKeyMiddleware, async (_0x35aa88, _0x24029c) => {
  const {
    amount: _0xe4a9ab,
    startTime: _0x4dfca5
  } = _0x35aa88.body;
  if (!_0xe4a9ab || _0xe4a9ab <= 0x0) {
    return _0x24029c.status(0x190).json({
      'success': false,
      'error': "Provide valid amount (positive integer)"
    });
  }
  const _0x4f5094 = _0x35aa88.headers["x-shopee-token"] || shopeeToken;
  const _0xa0198d = Math.floor(Date.now() / 0x3e8);
  let _0x3624d7 = parseInt(_0x4dfca5, 0xa);
  if (isNaN(_0x3624d7) || _0x3624d7 === 0x0) {
    _0x3624d7 = _0xa0198d - 1800;
  }
  logEvent('INFO', "Memulai pengecekan pembayaran stateless. Nominal: Rp " + _0xe4a9ab + ", Waktu Mulai: " + new Date(_0x3624d7 * 0x3e8).toISOString());
  try {
    const _0x452c42 = await callShopeeAPI(_0x3624d7, _0xa0198d, 0x32, '', _0x4f5094);
    if (!_0x452c42) {
      logEvent("ERROR", "Respons dari ShopeePay API kosong.");
      return _0x24029c.status(0x1f4).json({
        'success': false,
        'error': "Empty response from ShopeePay API"
      });
    }
    if (_0x452c42.code !== 0x0) {
      logEvent("ERROR", "API ShopeePay mengembalikan kode " + _0x452c42.code + ": " + _0x452c42.msg);
      return _0x24029c.status(0x190).json({
        'success': false,
        'error': _0x452c42.msg || "API error code " + _0x452c42.code
      });
    }
    const _0x3f7de7 = _0x452c42.data && _0x452c42.data.list || [];
    const _0x396bc8 = Number(_0xe4a9ab);
    const _0xc023f0 = _0x3f7de7.find(_0x3f6508 => {
      const _0x55fa21 = String(_0x3f6508.amount || '0').replace(/\./g, '').replace(/,/g, '');
      const _0x1bcf54 = parseInt(_0x55fa21, 0xa) || 0x0;
      const _0x539e9d = _0x3f6508.transactionId || _0x3f6508.displayTransactionId;
      return _0x3f6508.status === 0x3 && _0x1bcf54 === _0x396bc8 && _0x3f6508.createTime >= _0x3624d7 && !usedTransactionIds.has(_0x539e9d);
    });
    if (!_0xc023f0) {
      logEvent('INFO', "Pengecekan selesai. Nominal Rp " + _0xe4a9ab + " BELUM ditemukan.");
      return _0x24029c.json({
        'success': true,
        'paid': false
      });
    }
    const _0x185d90 = _0xc023f0.transactionId || _0xc023f0.displayTransactionId;
    usedTransactionIds.set(_0x185d90, _0xc023f0.createTime);
    const _0x5f39df = Math.floor(Date.now() / 0x3e8) - 86400;
    for (const [_0x153a95, _0x4af837] of usedTransactionIds.entries()) {
      if (_0x4af837 < _0x5f39df) {
        usedTransactionIds["delete"](_0x153a95);
      }
    }
    logEvent('INFO', "Pencocokan berhasil! Transaksi ditemukan: " + _0x185d90 + ". Mengambil detail...");
    const _0x478e7a = formatTransaction(_0xc023f0);
    try {
      const _0x1b349c = await callShopeeDetailAPI(_0xc023f0.displayTransactionId || _0xc023f0.transactionId, _0x4f5094);
      if (_0x1b349c && _0x1b349c.code === 0x0 && _0x1b349c.data) {
        _0x478e7a.issuer = _0x1b349c.data.issuer;
      }
    } catch (_0x1f6074) {
      logEvent("WARN", "Gagal mengambil detail transaksi " + _0xc023f0.transactionId + ": " + _0x1f6074.message);
    }
    logEvent('INFO', "Pembayaran terverifikasi lunas via " + (_0x478e7a.issuer || 'ShopeePay/QRIS') + '.');
    _0x24029c.json({
      'success': true,
      'paid': true,
      'transaction': {
        'transactionId': _0xc023f0.transactionId || _0xc023f0.displayTransactionId,
        'amount': _0x478e7a.amount,
        'status': _0x478e7a.status,
        'time': _0x478e7a.time,
        'issuer': _0x478e7a.issuer || "QRIS / ShopeePay"
      }
    });
  } catch (_0x406c66) {
    logEvent("ERROR", "Pengecekan gagal karena exception: " + _0x406c66.message);
    _0x24029c.status(0x1f4).json({
      'success': false,
      'error': _0x406c66.message
    });
  }
});
app.get("/api/logs", apiKeyMiddleware, (_0xce5bc4, _0x4da4a9) => {
  _0x4da4a9.json({
    'success': true,
    'data': {
      'logs': logs
    }
  });
});
app.listen(PORT, () => {
  console.log("ShopeePay API (express) running at http://localhost:" + PORT);
  console.log('Endpoints:');
  console.log("  POST /update-token       - Update ShopeeToken");
  console.log("  GET  /token-status       - Check ShopeeToken Validity status");
  console.log("  POST /create-qris        - Generate Dynamic QRIS from static template");
  console.log("  GET  /qr/:id             - Fetch Dynamic QRIS Image Redirect");
  console.log("  GET  /transactions       - Fetch transactions list");
  console.log("  GET  /transactions/all   - Fetch all transactions of the month");
  if (shopeeToken && apiKey) {
    startTokenChecker();
  } else {
    console.warn("WARNING: SHOPEE_TOKEN and API_KEY must be set in .env to run checks.");
  }
});
const path = require("path");
app.use(express.static(path.join(__dirname, "public")));
app.get('/', (req, res) => {
  res.send('Shoppe API Running');
});

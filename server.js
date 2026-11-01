#!/usr/bin/env node
'use strict';
/**
 * BLF V4 Coordinator — bản Node.js
 *
 * Runtime duy nhất của coordinator. Zero dependency, chỉ dùng module có sẵn
 * của Node.js.
 *
 *     node server.js
 *
 * Xem README.md để biết cách trỏ giayeuem.lua sang đây.
 */

const http = require('node:http');
const { URL } = require('node:url');

// ─────────────────────────── CẤU HÌNH ───────────────────────────

const HOST = process.env.BLF_HOST || '0.0.0.0';
// Pterodactyl/hosting game thường cấp cổng qua SERVER_PORT hoặc PORT.
// BLF_PORT vẫn có độ ưu tiên cao nhất để giữ tương thích cách chạy cũ.
const PORT = parseInt(
  process.env.BLF_PORT || process.env.SERVER_PORT || process.env.PORT || '25232',
  10,
);
const API_KEY = process.env.BLF_API_KEY || '';
const VERBOSE = process.env.BLF_VERBOSE === '1';

const ACCOUNT_TTL = 30.0;       // quá lâu không sync → coi như offline
const MAIN_ASSIGN_TTL = 90.0;   // giữ chỗ group cho main khi nó đang hop server
const ISLAND_TTL = 45.0;        // client heartbeat đảo mỗi 15s
const COMMAND_WALL_TTL = 60.0;  // chặn trên tuyệt đối cho command
const FOLLOW_TARGET_TTL = Math.max(3, parseFloat(process.env.BLF_FOLLOW_TTL || '12'));
const FOLLOW_GC_TTL = Math.max(FOLLOW_TARGET_TTL * 4, 120);
// Khi một Help tìm được Full Moon, dành một cửa sổ ngắn để Help còn lại
// nhận JobId trước khi mở cùng đích cho Main. Không đợi Help teleport xong.
const HELP_FIRST_MAIN_DELAY = Math.max(
  1,
  parseFloat(process.env.BLF_HELP_FIRST_DELAY || '3') || 3,
);
// Full Moon client sync mỗi 0.5s. Yêu cầu heartbeat mới hơn ngưỡng này để
// không mở Main theo JobId của Help đã rời/disconnect giữa cửa sổ ưu tiên.
const HELP_FIRST_ANCHOR_TTL = Math.max(
  1.5,
  parseFloat(process.env.BLF_HELP_ANCHOR_TTL || '2.5') || 2.5,
);
const DEFAULT_LIMIT_MAIN = 4;

// Đặt backlog tường minh để không phụ thuộc mặc định của phiên bản runtime.
const BACKLOG = 512;

// ─────────────────────────── STATE ───────────────────────────
// Node xử lý state trên một event loop nên không cần lock quanh các Map này.

const STATE = {
  accounts: new Map(),    // username -> bản ghi trạng thái
  groups: new Map(),      // groupId  -> {id,name,helpers[],seenAt}
  groupOrder: [],
  mainAssign: new Map(),  // username -> {groupId, assignedAt}
  leader: new Map(),      // groupId  -> username đang tới lượt
  commands: new Map(),    // groupId  -> command (+ _recvAt)
  islands: new Map(),     // username -> {island, recvAt}
  followTargets: new Map(), // leader lowercase -> {leader,placeId,jobId,sessionId,_recvAt}
  joinWaves: new Map(),   // groupId -> lượt hop Help trước, Main sau
  limitMainUp: DEFAULT_LIMIT_MAIN,
  stats: {
    post_v4info: 0, get_ready: 0, post_command: 0,
    post_follow: 0, get_follow: 0,
    cmd_dup_rejected: 0, bad_json: 0, started: Date.now() / 1000,
  },
};

const now = () => Date.now() / 1000;

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...a);
}

// ─────────────────────── TIỆN ÍCH TRUY VẤN ───────────────────────

const acc = (u) => STATE.accounts.get(u);

function isOnline(u, ttl = ACCOUNT_TTL) {
  const a = acc(u);
  return !!a && now() - a._recvAt <= ttl;
}

function groupOfHelper(username) {
  for (const gid of STATE.groupOrder) {
    const g = STATE.groups.get(gid);
    if (g && g.helpers.includes(username)) return gid;
  }
  return '';
}

function activeMains(gid, ttl = MAIN_ASSIGN_TTL) {
  const out = [];
  for (const [u, m] of STATE.mainAssign) {
    if (m.groupId === gid && isOnline(u, ttl)) out.push(u);
  }
  return out;
}

/** Main đang rảnh để làm trial (không phải đi train / mua upgrade). */
function mainIsFree(u) {
  const a = acc(u);
  if (!a) return false;
  return !!a.canTrial && !a.needsTraining && !a.needsPurchase;
}

/**
 * Số Helper của group đang online và ở cùng JobId với Main.
 *
 * Điểm 2: Main đã vào đúng server của cả hai Help -> ưu tiên cao nhất.
 * Điểm 1: Main mới vào cùng một Help -> vẫn ưu tiên hơn Main ở server khác.
 * Điểm 0: Main còn đang hop/chưa tới server của group -> xếp hàng sau.
 */
function mainHelperColocationScore(gid, username) {
  const g = STATE.groups.get(gid);
  const main = acc(username);
  if (!g || !main || !main.jobId || !isOnline(username)) return 0;

  let score = 0;
  for (const helper of g.helpers) {
    const helperAccount = acc(helper);
    if (helperAccount && helperAccount.jobId === main.jobId && isOnline(helper)) score++;
  }
  return score;
}

/** Danh sách Helper đang online và tự báo Full Moon hợp lệ. */
function fullMoonHelpers(gid) {
  const g = STATE.groups.get(gid);
  if (!g) return [];
  return g.helpers.filter((username) => {
    const a = acc(username);
    return !!a && isOnline(username, HELP_FIRST_ANCHOR_TTL)
      && a.fullMoon === true && !!a.jobId;
  });
}

/** Số Helper của group còn heartbeat, dù hiện tại không Full Moon. */
function onlineHelperCount(gid) {
  const g = STATE.groups.get(gid);
  if (!g) return 0;
  return g.helpers.reduce((count, username) => count + (isOnline(username) ? 1 : 0), 0);
}

/**
 * Giữ JobId ổn định trong suốt một lượt hop. Chỉ bỏ lượt cũ khi không còn
 * Helper nào ở Full Moon trên JobId đó, tránh chia nhóm sang hai server.
 */
function resolveJoinWave(gid) {
  const g = STATE.groups.get(gid);
  if (!g) return null;

  const candidates = fullMoonHelpers(gid);
  const current = STATE.joinWaves.get(gid);
  if (current) {
    const stillValid = candidates.some((username) => {
      const a = acc(username);
      return a && a.jobId === current.jobId;
    });
    if (stillValid) return current;
    STATE.joinWaves.delete(gid);
  }

  if (candidates.length === 0) return null;
  const anchorHelper = candidates[0];
  const anchor = acc(anchorHelper);
  const wave = {
    groupId: gid,
    jobId: anchor.jobId,
    placeId: anchor.placeId,
    anchorHelper,
    createdAt: now(),
    helperDispatchAt: 0,
    dispatchedHelpers: new Set([anchorHelper]),
  };
  STATE.joinWaves.set(gid, wave);
  log(`help-first wave group=${gid} anchor=${anchorHelper} job=${anchor.jobId.slice(0, 8)}`);
  return wave;
}

/**
 * Chỉ thị hop dành riêng cho caller:
 * - Help nhận đích ngay.
 * - Main chờ hết cửa sổ ưu tiên, không phụ thuộc Help đã join thành công.
 * - Không có Help Full Moon thì không phát đích cũ từ accounts.
 */
function joinTargetForCaller(gid, username, role) {
  const wave = resolveJoinWave(gid);
  if (!wave) return { allowed: false, phase: 'waiting_helper_full_moon' };

  const caller = acc(username);
  const alreadyThere = !!caller && caller.jobId === wave.jobId;
  if (role === 'helper') {
    if (!wave.dispatchedHelpers.has(username)) {
      wave.dispatchedHelpers.add(username);
      wave.helperDispatchAt = now();
      log(`help-first dispatch group=${gid} helper=${username} job=${wave.jobId.slice(0, 8)}`);
    }
    return {
      allowed: true,
      phase: alreadyThere ? 'helper_anchor' : 'helpers_first',
      placeId: wave.placeId,
      jobId: wave.jobId,
      anchorHelper: wave.anchorHelper,
      waitSeconds: 0,
    };
  }

  const elapsed = now() - wave.createdAt;
  const allowed = alreadyThere || elapsed >= HELP_FIRST_MAIN_DELAY;
  return {
    allowed,
    phase: allowed ? 'mains_released' : 'helpers_first',
    placeId: wave.placeId,
    jobId: wave.jobId,
    anchorHelper: wave.anchorHelper,
    waitSeconds: allowed ? 0 : Math.ceil((HELP_FIRST_MAIN_DELAY - elapsed) * 10) / 10,
  };
}

/**
 * Command còn hiệu lực hay không.
 *
 * created_at/expires_at nằm trên đồng hồ Roblox của client, không so trực
 * tiếp với giờ máy chủ được. Nhưng HIỆU của chúng thì không phụ thuộc đồng
 * hồ, nên lấy độ dài vòng đó cộng vào lúc mình nhận được.
 */
function liveCommand(gid) {
  const c = STATE.commands.get(gid);
  if (!c) return null;
  let dur = Number(c.expires_at || 0) - Number(c.created_at || 0);
  if (!(dur > 0 && dur <= 300)) dur = 16.0;
  if (now() - c._recvAt > Math.min(dur + 5.0, COMMAND_WALL_TTL)) {
    STATE.commands.delete(gid);
    return null;
  }
  return c;
}

/** Chỉ giữ command của Main đang thực sự đứng đầu hàng. */
function commandForLeader(gid, leader) {
  const c = liveCommand(gid);
  if (!c) return null;
  const commandMain = String(c.main_username || '');
  if (!leader || commandMain !== leader || !mainIsFree(commandMain)) {
    STATE.commands.delete(gid);
    log(`clear stale V3 command group=${gid} oldMain=${commandMain || '-'}`);
    return null;
  }
  return c;
}

/**
 * Xếp main trong group, phần tử [0] là người tới lượt (helper sẽ phục vụ).
 *
 * Ưu tiên:
 *   1. Nếu đang có command sống  -> khoá cứng vào main đã tạo command
 *      (tránh đổi lượt giữa chừng làm helper bắn nhầm chủ).
 *   2. Main rảnh đang ở cùng server với nhiều Helper hơn được lên trước.
 *      Main còn ở server khác/chờ hop phải xếp sau Main đã tới nơi.
 *   3. Giữ leader cũ nếu nó vẫn thuộc cùng mức ưu tiên (chống nhấp nháy).
 *   4. Còn lại: ai vào group trước thì được ưu tiên.
 *
 * Cả (1) và (2) chỉ giữ khi main đó CÒN RẢNH. Ngay khi nó báo
 * needsTraining/needsPurchase nghĩa là trial đã xong -> nhả lượt cho main
 * kế tiếp, không cần chờ command hết hạn.
 */
function sortedMains(gid) {
  const mains = activeMains(gid);
  if (mains.length === 0) {
    STATE.leader.delete(gid);
    return [];
  }

  mains.sort((x, y) => {
    const fx = mainIsFree(x) ? 0 : 1;
    const fy = mainIsFree(y) ? 0 : 1;
    if (fx !== fy) return fx - fy;
    const sx = mainHelperColocationScore(gid, x);
    const sy = mainHelperColocationScore(gid, y);
    if (sx !== sy) return sy - sx;
    const ax = STATE.mainAssign.get(x).assignedAt;
    const ay = STATE.mainAssign.get(y).assignedAt;
    if (ax !== ay) return ax - ay;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const cmd = liveCommand(gid);
  const cmdMain = cmd ? cmd.main_username : null;
  let pinned = null;
  if (cmdMain && mains.includes(cmdMain) && mainIsFree(cmdMain)) {
    pinned = cmdMain;
  } else {
    const cur = STATE.leader.get(gid);
    if (cur && mains.includes(cur) && mainIsFree(cur)) {
      const best = mains[0];
      const samePriority = best
        && mainIsFree(best) === mainIsFree(cur)
        && mainHelperColocationScore(gid, best) === mainHelperColocationScore(gid, cur);
      if (samePriority) pinned = cur;
    }
  }
  if (pinned) {
    mains.splice(mains.indexOf(pinned), 1);
    mains.unshift(pinned);
  }

  STATE.leader.set(gid, mains[0]);
  return mains;
}

/**
 * Chọn group tốt nhất cho Main.
 *
 * Ưu tiên lần lượt: group có Help Full Moon, Main đã ở chung JobId
 * với Help, group có nhiều Help online, rồi mới tới group ít Main.
 */
function bestMainGroup(username) {
  if (STATE.groupOrder.length === 0) return '';

  const limit = Math.max(1, Math.min(10, STATE.limitMainUp || DEFAULT_LIMIT_MAIN));
  const load = (gid) => activeMains(gid).filter((u) => u !== username).length;
  const candidates = STATE.groupOrder.filter((gid) => load(gid) < limit);
  const pool = candidates.length ? candidates : [...STATE.groupOrder];

  pool.sort((a, b) => {
    const fmA = fullMoonHelpers(a).length;
    const fmB = fullMoonHelpers(b).length;
    if (fmA !== fmB) return fmB - fmA;

    const colocA = mainHelperColocationScore(a, username);
    const colocB = mainHelperColocationScore(b, username);
    if (colocA !== colocB) return colocB - colocA;

    const onlineA = onlineHelperCount(a);
    const onlineB = onlineHelperCount(b);
    if (onlineA !== onlineB) return onlineB - onlineA;

    const loadA = load(a);
    const loadB = load(b);
    if (loadA !== loadB) return loadA - loadB;
    return STATE.groupOrder.indexOf(a) - STATE.groupOrder.indexOf(b);
  });
  return pool[0] || '';
}

/**
 * Gán Main có tính dính, nhưng không để group cũ không có Full Moon
 * giữ mãi một Main trial-ready khi group khác đang có Help Full Moon.
 */
function assignMainGroup(username) {
  const cur = STATE.mainAssign.get(username);
  const best = bestMainGroup(username);
  if (!best) return '';

  if (cur && STATE.groups.has(cur.groupId)) {
    const currentGroup = cur.groupId;
    if (currentGroup === best) return currentGroup;

    const currentHasFullMoon = fullMoonHelpers(currentGroup).length > 0;
    const bestHasFullMoon = fullMoonHelpers(best).length > 0;
    const command = liveCommand(currentGroup);

    // Không đổi group giữa một command/trial đang hoạt động, hoặc khi
    // Main còn phải train/mua gear. Các trường hợp khác giữ tính dính.
    if (command || !mainIsFree(username) || currentHasFullMoon || !bestHasFullMoon) {
      return currentGroup;
    }

    STATE.leader.delete(currentGroup);
    STATE.mainAssign.set(username, { groupId: best, assignedAt: now() });
    log(`reassign main ${username.padEnd(20)} ${currentGroup} -> ${best} (Full Moon helpers)`);
    return best;
  }

  STATE.mainAssign.set(username, { groupId: best, assignedAt: now() });
  log(`assign main ${username.padEnd(20)} -> group ${best}`);
  return best;
}

function gc() {
  const t = now();
  for (const [u, a] of STATE.accounts) if (t - a._recvAt > 600) STATE.accounts.delete(u);
  for (const u of [...STATE.mainAssign.keys()]) {
    if (!isOnline(u, MAIN_ASSIGN_TTL)) STATE.mainAssign.delete(u);
  }
  for (const [u, i] of STATE.islands) if (t - i.recvAt > ISLAND_TTL) STATE.islands.delete(u);
  for (const [u, f] of STATE.followTargets) {
    if (t - f._recvAt > FOLLOW_GC_TTL) STATE.followTargets.delete(u);
  }
  for (const [g, c] of STATE.commands) {
    if (t - c._recvAt > COMMAND_WALL_TTL) STATE.commands.delete(g);
  }
  for (const [gid, wave] of STATE.joinWaves) {
    const group = STATE.groups.get(gid);
    const hasLiveAnchor = group && group.helpers.some((username) => {
      const a = acc(username);
      return a && isOnline(username, HELP_FIRST_ANCHOR_TTL)
        && a.fullMoon === true && a.jobId === wave.jobId;
    });
    if (!hasLiveAnchor) STATE.joinWaves.delete(gid);
  }
}

// ─────────────────────── HANDLER TỪNG ENDPOINT ───────────────────────

/**
 * Client gửi toàn bộ trạng thái mỗi 0.5s (Full Moon) / 2s (thường).
 * Trả về: group được gán, trạng thái đồng đội, và lịch bắn V3 nếu có.
 */
function hPostV4Info(body) {
  STATE.stats.post_v4info++;

  const username = String(body.username || '').trim();
  if (!username) return [400, { error: 'missing username' }];
  const role = String(body.role || 'none');

  // 1) Đăng ký định nghĩa group (client chỉ gửi khi chưa có group)
  if (Array.isArray(body.groups)) {
    for (const g of body.groups) {
      if (!g || typeof g !== 'object') continue;
      const gid = String(g.id || g.name || '').trim();
      if (!gid) continue;
      const helpers = (g.helpers || []).map((h) => String(h).trim()).filter(Boolean);
      if (!STATE.groups.has(gid)) {
        STATE.groupOrder.push(gid);
        log(`group mới: ${gid} (helpers=${JSON.stringify(helpers)})`);
        if (helpers.length !== 2) {
          log(`  ! CẢNH BÁO: group '${gid}' có ${helpers.length} helper. Client Lua `
            + 'bắt buộc đúng 1 main + 2 helper, nếu không V3 sẽ không bao giờ bắn.');
        }
      }
      STATE.groups.set(gid, {
        id: gid, name: String(g.name || gid), helpers, seenAt: now(),
      });
    }
  }

  if (body.limitMainUp) {
    const v = parseInt(body.limitMainUp, 10);
    if (Number.isFinite(v)) STATE.limitMainUp = Math.max(1, Math.min(10, v));
  }

  // 2) Lưu trạng thái account
  STATE.accounts.set(username, {
    username,
    role,
    jobId: String(body.jobId || ''),
    placeId: String(body.placeId || ''),
    race: String(body.race || ''),
    fullMoon: body.fullMoon === true,
    alive: body.alive === true,
    ready: body.ready === true,
    canTrial: body.canTrial === true,
    needsTraining: body.needsTraining === true,
    needsPurchase: body.needsPurchase === true,
    complete: body.complete === true,
    transformed: body.transformed === true,
    timerVisible: body.timerVisible === true,
    energy: body.energy || 0,
    fragments: body.fragments || 0,
    doorDistance: body.doorDistance,
    firedRound: String(body.firedRound || ''),
    // updatedAt = Workspace:GetServerTimeNow() phía client. PHẢI trả lại
    // nguyên xi, vì client so sánh nó với đồng hồ Roblox của chính nó.
    updatedAt: body.updatedAt || 0,
    _recvAt: now(), // giờ máy chủ, dùng cho freshness + GC
  });

  // 3) Xác định group
  let gid;
  if (role === 'helper') gid = groupOfHelper(username) || String(body.groupId || '');
  else if (role === 'main') gid = assignMainGroup(username);
  else gid = String(body.groupId || '');

  const resp = { ok: true, serverTime: Math.floor(now()) };

  if (!gid || !STATE.groups.has(gid)) {
    // Chưa có group -> không trả field "group", client sẽ tiếp tục gửi kèm
    // định nghĩa groups ở lần sync sau.
    resp.accounts = {};
    resp.command = null;
    return [200, resp];
  }

  const g = STATE.groups.get(gid);
  const mains = sortedMains(gid);
  resp.group = { id: gid, name: g.name, helpers: [...g.helpers], mains };
  const leader = mains[0] || '';

  // Client mới dùng field này thay vì tự quét accounts, nên Main không thể
  // nhìn thấy tín hiệu Full Moon sớm hơn cửa sổ ưu tiên của Help.
  resp.joinTarget = joinTargetForCaller(gid, username, role);

  // 4) Trạng thái đồng đội — client dùng để dò ai đang ở server Full Moon
  const members = (mains.length ? [mains[0]] : []).concat(g.helpers);
  const out = {};
  for (const name of members) {
    const a = acc(name);
    if (!a) continue;
    out[name] = {
      jobId: a.jobId, fullMoon: a.fullMoon, updatedAt: a.updatedAt,
      ready: a.ready, race: a.race, alive: a.alive, doorDistance: a.doorDistance,
    };
  }
  resp.accounts = out;

  // 5) Lịch bắn V3
  const cmd = commandForLeader(gid, leader);
  resp.command = cmd ? stripPrivate(cmd) : null;
  return [200, resp];
}

function stripPrivate(o) {
  const r = {};
  for (const k of Object.keys(o)) if (!k.startsWith('_')) r[k] = o[k];
  return r;
}

/**
 * Main hỏi: 3 thành viên đã đứng đúng cửa tộc, cùng server, khác tộc chưa?
 *
 * Client mới gửi cả username + jobId để phân biệt nhiều Main cùng server.
 * Nếu username vắng mặt vẫn giữ đường tương thích cho client cũ.
 */
function hGetReady(gid, q) {
  STATE.stats.get_ready++;

  const jobId = q.get('jobId') || '';
  let freshness = parseFloat(q.get('freshness') || '2.0');
  if (!Number.isFinite(freshness)) freshness = 2.0;
  const requireDiff = (q.get('requireDiffRaces') || 'true').toLowerCase() !== 'false';

  const g = STATE.groups.get(gid);
  if (!g) return [200, { readyCount: 0, allReady: false, records: [], reason: 'no_group' }];

  const mains = sortedMains(gid);
  const leader = mains[0] || '';
  const requestedUsername = String(q.get('username') || '').trim();
  if (requestedUsername && requestedUsername !== leader) {
    return [200, {
      readyCount: 0, allReady: false, records: [], reason: 'not_leader', leader,
    }];
  }

  const callers = mains.filter((m) => acc(m) && acc(m).jobId === jobId);
  let caller = requestedUsername || callers[0];
  if (!caller || !acc(caller) || acc(caller).jobId !== jobId) {
    return [200, {
      readyCount: 0, allReady: false, records: [], reason: 'waiting', leader,
    }];
  }

  // Nếu đang có command sống thì chủ command mới là người được phục vụ
  const cmd = commandForLeader(gid, leader);
  if (cmd && callers.includes(cmd.main_username)) caller = cmd.main_username;

  const members = [caller, ...g.helpers];
  if (new Set(members).size !== 3) {
    return [200, { readyCount: 0, allReady: false, records: [], reason: 'need_3_members' }];
  }

  const t = now();
  const records = [];
  const races = [];
  let readyCount = 0;

  for (const name of members) {
    const a = acc(name);
    if (!a) {
      records.push({ username: name, present: false, reason: 'never_synced' });
      continue;
    }
    const age = t - a._recvAt;
    const sameServer = a.jobId === jobId;
    const fresh = age <= freshness;
    const ok = !!(a.ready && a.alive && sameServer && fresh);
    records.push({
      username: name, present: true, ready: ok, race: a.race, jobId: a.jobId,
      sameServer, ageSec: Math.round(age * 100) / 100, fresh,
      doorDistance: a.doorDistance,
    });
    if (ok) { readyCount++; races.push(a.race); }
  }

  if (readyCount < 3) return [200, { readyCount, allReady: false, records, reason: 'waiting' }];
  if (requireDiff && new Set(races).size !== 3) {
    return [200, { readyCount, allReady: false, records, reason: 'duplicate_race' }];
  }
  return [200, { readyCount, allReady: true, records, reason: 'ready' }];
}

/**
 * Main đặt lịch bắn. Trả 409 nếu group đã có command còn hiệu lực.
 *
 * Vì sao 409 quan trọng: client poll mỗi 0.1s nhưng chỉ nhận lại command qua
 * sync 0.5s, nên nó sẽ tạo 3-5 round trùng trong khoảng trống đó và bắn
 * ActivateAbility nhiều lần. apiPost() coi mọi mã != 200 là thất bại -> 409
 * khiến client bỏ qua round thừa, chỉ còn đúng 1 round.
 */
function hPostCommand(gid, body) {
  STATE.stats.post_command++;
  if (!body || typeof body !== 'object' || !body.round_id) {
    return [400, { error: 'invalid command' }];
  }

  const g = STATE.groups.get(gid);
  if (!g) return [404, { error: 'no_group' }];
  const mains = sortedMains(gid);
  const leader = mains[0] || '';
  const commandMain = String(body.main_username || '');
  if (!leader || commandMain !== leader) {
    return [409, { error: 'not_leader', leader }];
  }
  const leaderAccount = acc(leader);
  if (!leaderAccount || String(body.job_id || '') !== leaderAccount.jobId) {
    return [409, { error: 'leader_job_mismatch', leader }];
  }

  const existing = commandForLeader(gid, leader);
  if (existing) {
    if (existing.round_id === body.round_id) return [200, { ok: true, duplicate: true }];
    const created = Number(body.created_at || 0);
    const expires = Number(existing.expires_at || 0);
    if (created && expires && expires > created) {
      STATE.stats.cmd_dup_rejected++;
      return [409, { error: 'round_in_progress', round_id: existing.round_id }];
    }
  }

  // Thành viên do API đóng dấu, không tin mảng members do client tự gửi.
  const cmd = { ...body, members: [leader, ...g.helpers], _recvAt: now() };
  STATE.commands.set(gid, cmd);
  if (cmd.main_username) STATE.leader.set(gid, cmd.main_username);

  log(`V3 round ${String(cmd.round_id).padEnd(28)} group=${gid.padEnd(12)} `
    + `main=${String(cmd.main_username).padEnd(18)} members=${JSON.stringify(cmd.members)}`);
  return [200, { ok: true }];
}

/** { "Tên đảo": {count, users[]} } — đúng format client mong đợi. */
function hGetIsland() {
  const t = now();
  const out = {};
  for (const [u, i] of STATE.islands) {
    if (t - i.recvAt > ISLAND_TTL) continue;
    if (!out[i.island]) out[i.island] = { count: 0, users: [] };
    out[i.island].count++;
    out[i.island].users.push(u);
  }
  return [200, out];
}

function hPostIsland(body) {
  const username = String(body.username || '').trim();
  const island = String(body.island || '').trim();
  if (!username || !island) return [400, { error: 'missing username/island' }];
  STATE.islands.set(username, { island, recvAt: now() });
  return [200, { ok: true }];
}

// ─────────────────────── FOLLOW SERVER API V1 ───────────────────────

function normalizeLeader(value) {
  const leader = String(value || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(leader)) return null;
  return { leader, key: leader.toLowerCase() };
}

/** Acc mốc heartbeat PlaceId + JobId. Tách hoàn toàn khỏi state V4/group. */
function hPostFollow(body) {
  STATE.stats.post_follow++;
  const identity = normalizeLeader(body.leader);
  const placeId = String(body.placeId || '').trim();
  const jobId = String(body.jobId || '').trim();
  const sessionId = String(body.sessionId || '').slice(0, 96);
  const universeId = String(body.universeId || '').trim();
  const privateServerId = String(body.privateServerId || '').trim().slice(0, 128);
  const privateServerOwnerId = String(body.privateServerOwnerId || '').trim().slice(0, 32);

  if (!identity) return [400, { ok: false, error: 'invalid_leader' }];
  const previous = STATE.followTargets.get(identity.key);

  // Leader báo trước khi Roblox rời server: follower phải dừng, không đuổi JobId cũ.
  if (body.state === 'leaving') {
    if (!previous) {
      return [200, { ok: true, accepted: true, transitioning: true, revision: 1 }];
    }
    if (sessionId && previous.sessionId && sessionId !== previous.sessionId) {
      return [200, {
        ok: true, accepted: false, reason: 'stale_session', revision: previous.revision,
      }];
    }
    previous.transitioning = true;
    previous.revision = (previous.revision || 0) + 1;
    previous._recvAt = now();
    return [200, {
      ok: true, accepted: true, transitioning: true, revision: previous.revision,
    }];
  }

  if (!/^\d{3,20}$/.test(placeId)) {
    return [400, { ok: false, error: 'invalid_place_id' }];
  }
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(jobId)) {
    return [400, { ok: false, error: 'invalid_job_id' }];
  }
  if (universeId && !/^\d{3,20}$/.test(universeId)) {
    return [400, { ok: false, error: 'invalid_universe_id' }];
  }

  const changed = !previous || previous.placeId !== placeId || previous.jobId !== jobId;
  const revision = changed ? ((previous && previous.revision) || 0) + 1
    : (previous.revision || 1);
  const record = {
    leader: identity.leader,
    placeId,
    jobId,
    universeId,
    privateServerId,
    privateServerOwnerId,
    sessionId,
    revision,
    transitioning: false,
    _recvAt: now(),
  };
  STATE.followTargets.set(identity.key, record);

  if (changed) {
    log(`follow target ${identity.leader.padEnd(20)} -> place=${placeId} job=${jobId.slice(0, 8)} rev=${revision}`);
  }
  return [200, {
    ok: true,
    accepted: true,
    revision,
    expiresIn: FOLLOW_TARGET_TTL,
    serverTime: Math.floor(now()),
  }];
}

/** Acc theo đọc server mới nhất của acc mốc. Offline/stale vẫn trả 200 rõ lý do. */
function hGetFollow(leaderValue) {
  STATE.stats.get_follow++;
  const identity = normalizeLeader(leaderValue);
  if (!identity) return [400, { ok: false, error: 'invalid_leader' }];

  const record = STATE.followTargets.get(identity.key);
  if (!record) {
    return [200, {
      ok: true,
      online: false,
      reason: 'leader_not_reporting',
      leader: identity.leader,
      serverTime: Math.floor(now()),
    }];
  }

  const ageSec = Math.max(0, now() - record._recvAt);
  if (ageSec > FOLLOW_TARGET_TTL) {
    return [200, {
      ok: true,
      online: false,
      reason: 'leader_stale',
      leader: record.leader,
      ageSec: Math.round(ageSec * 10) / 10,
      revision: record.revision,
      serverTime: Math.floor(now()),
    }];
  }

  if (record.transitioning === true) {
    return [200, {
      ok: true,
      online: false,
      reason: 'leader_transitioning',
      leader: record.leader,
      ageSec: Math.round(ageSec * 10) / 10,
      revision: record.revision,
      serverTime: Math.floor(now()),
    }];
  }

  return [200, {
    ok: true,
    online: true,
    leader: record.leader,
    placeId: record.placeId,
    jobId: record.jobId,
    universeId: record.universeId,
    isReserved: record.privateServerId !== '',
    privateServerOwnerId: record.privateServerOwnerId,
    revision: record.revision,
    ageSec: Math.round(ageSec * 10) / 10,
    expiresIn: Math.max(0, Math.round((FOLLOW_TARGET_TTL - ageSec) * 10) / 10),
    serverTime: Math.floor(now()),
  }];
}

/**
 * FM feed tự dựng, thay cho 103.77.241.31:1901.
 *
 * Nguồn dữ liệu là chính dàn acc của bạn: acc nào báo fullMoon=true thì jobId
 * đó được coi là server Full Moon. Chỉ thấy được server mà đội mình đã vào —
 * không quét toàn bộ Roblox như API gốc. Xem README phần hạn chế.
 */
function hGetMoon() {
  const t = now();
  const seen = new Map();
  for (const a of STATE.accounts.values()) {
    if (!a.jobId || t - a._recvAt > 120 || !a.fullMoon) continue;
    const e = seen.get(a.jobId) || { JobId: a.jobId, IsNight: true, n: 0 };
    e.n++;
    seen.set(a.jobId, e);
  }
  const data = [...seen.values()].map((v) => ({
    JobId: v.JobId, IsNight: true, Players: `${v.n}/12`,
  }));
  return [200, { data }];
}

function hDebug() {
  const t = now();
  const accounts = {};
  for (const [u, a] of STATE.accounts) {
    accounts[u] = { ...a, ageSec: Math.round((t - a._recvAt) * 10) / 10 };
  }
  const commands = {};
  for (const [k, v] of STATE.commands) commands[k] = stripPrivate(v);
  const followTargets = {};
  for (const [k, v] of STATE.followTargets) {
    followTargets[k] = {
      leader: v.leader,
      placeId: v.placeId,
      jobId: v.jobId,
      universeId: v.universeId,
      isReserved: v.privateServerId !== '',
      revision: v.revision,
      transitioning: v.transitioning === true,
      ageSec: Math.round((t - v._recvAt) * 10) / 10,
    };
  }
  return [200, {
    uptimeSec: Math.floor(t - STATE.stats.started),
    stats: STATE.stats,
    limitMainUp: STATE.limitMainUp,
    groups: Object.fromEntries(STATE.groups),
    groupOrder: STATE.groupOrder,
    leader: Object.fromEntries(STATE.leader),
    mainAssign: Object.fromEntries(STATE.mainAssign),
    commands,
    islands: Object.fromEntries(STATE.islands),
    followTargets,
    accounts,
  }];
}

// ─────────────────────────── DASHBOARD ───────────────────────────

const DASH_CSS = `
body{background:#14101a;color:#f0d5e0;font:13px/1.5 Consolas,monospace;margin:24px}
h1{color:#ff69b4;font-size:18px;margin:0 0 4px}
.sub{color:#7a6b75;margin-bottom:18px}
table{border-collapse:collapse;margin-bottom:22px;width:100%}
th{text-align:left;color:#ff8fc4;border-bottom:1px solid #3a2a35;padding:5px 10px;font-weight:400}
td{padding:4px 10px;border-bottom:1px solid #241c28}
.on{color:#5fe08a}.off{color:#6b5560}.warn{color:#ffcf5a}.fm{color:#ff69b4;font-weight:700}
.g{color:#8fd4ff}.lead{color:#ffd166}
`;

function hDashboard() {
  const t = now();
  const rows = [];
  for (const gid of STATE.groupOrder) {
    const g = STATE.groups.get(gid);
    const mains = sortedMains(gid);
    const cmd = liveCommand(gid);
    for (const name of [...mains, ...g.helpers]) {
      const a = acc(name);
      const isLead = mains.length > 0 && name === mains[0];
      if (!a) {
        rows.push(`<tr><td class=g>${gid}</td><td>${name}</td>`
          + '<td class=off colspan=9>chưa sync bao giờ</td></tr>');
        continue;
      }
      const age = t - a._recvAt;
      const online = age <= ACCOUNT_TTL;
      const v4 = a.complete ? 'COMPLETE' : a.canTrial ? 'trial'
        : a.needsPurchase ? 'buy' : a.needsTraining ? 'train' : '?';
      rows.push(
        `<tr><td class=g>${gid}</td>`
        + `<td class='${isLead ? 'lead' : ''}'>${name}${isLead ? ' ★' : ''}</td>`
        + `<td>${a.role}</td><td>${a.race || '-'}</td>`
        + `<td class='${online ? 'on' : 'off'}'>${Math.round(age * 10) / 10}s</td>`
        + `<td class='${a.fullMoon ? 'fm' : 'off'}'>${a.fullMoon ? 'FULL MOON' : '-'}</td>`
        + `<td class='${a.ready ? 'on' : 'off'}'>${a.ready ? 'READY' : '-'}</td>`
        + `<td>${a.doorDistance}</td><td>${(a.jobId || '-').slice(0, 8)}</td>`
        + `<td>${v4}</td><td>${a.fragments}</td></tr>`);
    }
    if (cmd) {
      rows.push(`<tr><td colspan=11 class=warn>&nbsp;&nbsp;↳ round <b>${cmd.round_id}</b>`
        + ` · main=${cmd.main_username} · fire_at=${cmd.fire_at}</tr>`);
    }
  }

  const isl = hGetIsland()[1];
  const islRows = Object.keys(isl).sort().map((k) =>
    `<tr><td>${k}</td><td>${isl[k].count}</td><td>${isl[k].users.join(', ')}</td></tr>`).join('');

  const followRows = [...STATE.followTargets.values()].map((f) => {
    const age = t - f._recvAt;
    const online = age <= FOLLOW_TARGET_TTL;
    return `<tr><td>${f.leader}</td>`
      + `<td class='${online ? 'on' : 'off'}'>${online ? 'ONLINE' : 'STALE'}</td>`
      + `<td>${Math.round(age * 10) / 10}s</td>`
      + `<td>${f.placeId}</td><td>${f.jobId.slice(0, 8)}</td><td>${f.revision}</td></tr>`;
  }).join('');

  const s = STATE.stats;
  return `<!doctype html><meta charset=utf-8><title>BLF V4 Coordinator</title>
<meta http-equiv=refresh content=2><style>${DASH_CSS}</style>
<h1>BLF V4 Coordinator <span class=sub>(node)</span></h1>
<div class=sub>uptime ${Math.floor(t - s.started)}s · ${s.post_v4info} sync · ${s.get_ready} ready · ${s.post_command} round (${s.cmd_dup_rejected} trùng bị chặn) · limitMainUp=${STATE.limitMainUp}</div>
<table><tr><th>follow leader<th>trạng thái<th>heartbeat<th>place<th>job<th>revision</tr>${followRows || '<tr><td colspan=6 class=off>chưa có acc mốc follow nào kết nối</td></tr>'}</table>
<table><tr><th>group<th>acc<th>role<th>tộc<th>sync<th>moon<th>ready<th>cửa<th>job<th>v4<th>frag</tr>${rows.join('') || '<tr><td colspan=11 class=off>chưa có acc nào kết nối</td></tr>'}</table>
<table><tr><th>đảo training<th>số acc<th>ai</tr>${islRows || '<tr><td colspan=3 class=off>-</td></tr>'}</table>
`;
}

// ─────────────────────────── HTTP LAYER ───────────────────────────

function send(res, code, payload, ctype = 'application/json') {
  const raw = Buffer.from(
    ctype === 'application/json' ? JSON.stringify(payload) : payload, 'utf8');
  res.writeHead(code, {
    'Content-Type': `${ctype}; charset=utf-8`,
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

function authOk(req) {
  if (!API_KEY) return true;
  return req.headers['x-api-key'] === API_KEY;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { error: 'bad url' });
  }
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (VERBOSE) log(req.method, path);

  try {
    if (req.method === 'GET') {
      if (path === '/') {
        gc();
        return send(res, 200, hDashboard(), 'text/html');
      }
      if (!authOk(req)) return send(res, 401, { error: 'unauthorized' });
      gc();
      if (path === '/v4info/island') return send(res, ...hGetIsland());
      if (path === '/v4info/debug') return send(res, ...hDebug());
      if (path === '/server/api/moon') return send(res, ...hGetMoon());
      if (path === '/health') {
        return send(res, 200, {
          ok: true,
          service: 'blf-v4-coordinator',
          version: '1.3.0',
          mainScheduler: 'full_moon_group_rebalance_v1',
          mainGroupRebalance: 'full_moon_v1',
          helpFirstJoin: 'v1',
          helpFirstDelay: HELP_FIRST_MAIN_DELAY,
          helpAnchorTtl: HELP_FIRST_ANCHOR_TTL,
          followApi: 'v1',
          followTtl: FOLLOW_TARGET_TTL,
        });
      }
      if (path.startsWith('/follow/v1/target/')) {
        const leader = decodeURIComponent(path.slice('/follow/v1/target/'.length));
        return send(res, ...hGetFollow(leader));
      }
      if (path.startsWith('/v4info/ready/')) {
        const gid = decodeURIComponent(path.slice('/v4info/ready/'.length));
        return send(res, ...hGetReady(gid, u.searchParams));
      }
      return send(res, 404, { error: 'not found', path });
    }

    if (req.method === 'POST') {
      if (!authOk(req)) return send(res, 401, { error: 'unauthorized' });
      const raw = await readBody(req);
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (e) {
          STATE.stats.bad_json++;
          // Client Lua tự nối chuỗi JSON không escape -> tên group chứa dấu "
          // hoặc \ sẽ làm hỏng body. In ra để dễ truy nguyên.
          log(`JSON hỏng (${e.message}): ${raw.slice(0, 400)}`);
          return send(res, 400, { error: 'invalid json' });
        }
      }
      gc();
      if (path === '/v4info') return send(res, ...hPostV4Info(body));
      if (path === '/follow/v1/report') return send(res, ...hPostFollow(body));
      if (path === '/admin/reset') {
        // Xoá sạch state mà không cần restart. Hữu ích khi đổi Mode1 hoặc
        // khi một group bị kẹt leader.
        for (const k of ['accounts', 'groups', 'mainAssign', 'leader', 'commands', 'islands', 'followTargets', 'joinWaves']) {
          STATE[k].clear();
        }
        STATE.groupOrder.length = 0;
        STATE.limitMainUp = DEFAULT_LIMIT_MAIN;
        log('state đã được reset qua /admin/reset');
        return send(res, 200, { ok: true, reset: true });
      }
      if (path === '/v4info/island') return send(res, ...hPostIsland(body));
      if (path.startsWith('/v4info/command/')) {
        const gid = decodeURIComponent(path.slice('/v4info/command/'.length));
        return send(res, ...hPostCommand(gid, body));
      }
      return send(res, 404, { error: 'not found', path });
    }

    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    log('lỗi handler:', e && e.stack ? e.stack : e);
    try { send(res, 500, { error: 'internal' }); } catch { /* client đã ngắt */ }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`KHÔNG bind được ${HOST}:${PORT} — cổng đang bị chiếm.`);
    log(`Còn server cũ đang chạy? Windows: netstat -ano | findstr :${PORT}`);
    process.exit(1);
  }
  log('lỗi server:', e);
  process.exit(1);
});

server.listen(PORT, HOST, BACKLOG, () => {
  log(`BLF V4 Coordinator (node ${process.version}) đang chạy tại http://${HOST}:${PORT}`);
  log(`Dashboard: http://127.0.0.1:${PORT}/   |  Debug: /v4info/debug`);
  log(API_KEY
    ? 'Auth: BẬT (header X-API-Key) — nhớ patch client Lua'
    : 'Auth: TẮT — chỉ chạy trong LAN/VPN, hoặc set BLF_API_KEY');
});

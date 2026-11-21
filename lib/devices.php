<?php
/**
 * devices.php — 登录设备管理(设置 → 账户 → 登录设备)。
 *
 * 现有能力只有「新设备登录邮件提醒」与「全站强制下线」;这里补上「看得到、踢得掉单个设备」。
 *
 * 做法:
 *   - 会话令牌(JWT)里多带一个 sid(这次登录的 id),由 tc_issue_token 写入。
 *   - 用户记录上维护 sessions:{ sid => {time, ip, ua, last} },只存最近 20 条、按最近活跃排序。
 *   - tc_auth_user 校验令牌时核对 sid:已被「退出该设备」删掉的 sid 一律视为失效
 *     (签出来的令牌仍然合法,但服务端不再认它 —— 踢下线必须靠服务端名单,不能只靠前端删令牌)。
 *   - 老令牌没有 sid:放行(不能因为升级把所有人踢下线),但不出现在设备列表里;
 *     下次重新登录就会带上 sid。
 *
 * 为什么不把 sessions 放进 settings:它是每个用户自己的数据,跟着 users 行走,
 * 后台「用户管理」与演示快照自然一并覆盖。
 */

define('TC_SESSIONS_MAX', 20);

// 从 UA 里取一个可读的设备名。不追求精确 —— 列表里主要靠 IP/时间/浏览器名让人认出来。
function tc_device_label($ua) {
    $ua = (string) $ua;
    if (trim($ua) === '') return '未知设备';
    $os = '未知系统';
    $browser = '未知浏览器';
    if (preg_match('/iPhone|iPad|iPod/i', $ua)) $os = 'iOS';
    elseif (preg_match('/Android/i', $ua)) $os = 'Android';
    elseif (preg_match('/Windows/i', $ua)) $os = 'Windows';
    elseif (preg_match('/Mac OS X|Macintosh/i', $ua)) $os = 'macOS';
    elseif (preg_match('/Linux/i', $ua)) $os = 'Linux';
    if (preg_match('/MicroMessenger/i', $ua)) $browser = '微信';
    elseif (preg_match('/Edg\//i', $ua)) $browser = 'Edge';
    elseif (preg_match('/OPR\/|Opera/i', $ua)) $browser = 'Opera';
    elseif (preg_match('/Firefox\//i', $ua)) $browser = 'Firefox';
    elseif (preg_match('/Chrome\//i', $ua)) $browser = 'Chrome';
    elseif (preg_match('/Safari\//i', $ua)) $browser = 'Safari';
    return $browser . ' · ' . $os;
}

function tc_device_ua() {
    $ua = isset($_SERVER['HTTP_USER_AGENT']) ? (string) $_SERVER['HTTP_USER_AGENT'] : '';
    if (function_exists('mb_substr')) $ua = mb_substr($ua, 0, 300, 'UTF-8');
    else $ua = substr($ua, 0, 300);
    return $ua;
}

// 登记一次登录。返回 sid(写进令牌)。
// 「可信设备」按浏览器指纹继承:同一台机器换会话(退出再登录)依然是可信的,
// 用户只需对每台机器点过一次「这是常用设备」。设备指纹沿用新设备提醒邮件那套 UA 哈希。
function tc_device_register(&$user, $sid = '') {
    if ($sid === '') $sid = tc_uid(16);
    $now = tc_now();
    $list = (isset($user['sessions']) && is_array($user['sessions'])) ? $user['sessions'] : array();
    $fp = tc_login_fingerprint();
    $trusted = false;
    if ($fp !== '') {
        foreach ($list as $row) {
            if (!is_array($row) || empty($row['trusted'])) continue;
            if ((string) (isset($row['fp']) ? $row['fp'] : '') === $fp) { $trusted = true; break; }
        }
    }
    $list[$sid] = array(
        'time' => $now,
        'last' => $now,
        'ip' => tc_client_ip(),
        'ua' => tc_device_ua(),
        'fp' => $fp,
        'trusted' => $trusted,
    );
    // 超出上限时丢掉最久未活跃的(语义:只保留最近 20 次登录,老设备需要重新登录)
    if (count($list) > TC_SESSIONS_MAX) {
        uasort($list, function ($a, $b) { return (int) $b['last'] - (int) $a['last']; });
        $list = array_slice($list, 0, TC_SESSIONS_MAX, true);
    }
    $user['sessions'] = $list;
    return $sid;
}

// 登录成功后的统一收尾:登记设备 + 签发令牌。所有发正式会话令牌的地方都走这里,
// 否则那一种登录方式用出来的设备就不会出现在列表里、也踢不掉。
function tc_login_issue($user, $settings) {
    $sid = tc_device_register($user);
    return tc_issue_token($user, $settings, $sid);
}

// 令牌里的 sid 是否还在这台账号的设备名单里。老令牌(无 sid)视为有效(升级不踢人)。
function tc_device_session_ok($user, $payload) {
    if (!isset($payload['sid']) || (string) $payload['sid'] === '') return true;
    $list = (isset($user['sessions']) && is_array($user['sessions'])) ? $user['sessions'] : array();
    return isset($list[(string) $payload['sid']]);
}

// 顺手更新「最近活跃」:按 10 分钟节流(全站每秒几十次验令牌,每次都写库会把写锁打满)。
// 只改传入的用户对象 —— 调用方带回写事务里它就落库了(见 core.php 的 tc_auth_user)。
function tc_device_touch(&$user, $payload) {
    if (!isset($payload['sid']) || (string) $payload['sid'] === '') return false;
    $sid = (string) $payload['sid'];
    if (!isset($user['sessions'][$sid]) || !is_array($user['sessions'][$sid])) return false;
    if ((int) $user['sessions'][$sid]['last'] > tc_now() - 600000) return false;
    $user['sessions'][$sid]['last'] = tc_now();
    return true;
}

// 对外的设备列表。current 标记让前端把「退出其它全部设备」与「退出本设备」分开。
function tc_devices_public($user, $payload) {
    $list = (isset($user['sessions']) && is_array($user['sessions'])) ? $user['sessions'] : array();
    $cur = isset($payload['sid']) ? (string) $payload['sid'] : '';
    $out = array();
    foreach ($list as $sid => $row) {
        if (!is_array($row)) continue;
        $out[] = array(
            'id' => (string) $sid,
            'label' => tc_device_label(isset($row['ua']) ? $row['ua'] : ''),
            'customName' => isset($row['customName']) ? (string) $row['customName'] : '',
            'ip' => isset($row['ip']) ? (string) $row['ip'] : '',
            'ua' => isset($row['ua']) ? (string) $row['ua'] : '',
            'createdAt' => (int) (isset($row['time']) ? $row['time'] : 0),
            'lastActiveAt' => (int) (isset($row['last']) ? $row['last'] : 0),
            'current' => $cur !== '' && $cur === (string) $sid,
            'trusted' => !empty($row['trusted']),
        );
    }
    usort($out, function ($a, $b) { return $b['lastActiveAt'] - $a['lastActiveAt']; });
    return $out;
}

// 这次登录来自可信设备吗:令牌里的 sid 在名单上且标为 trusted。
// 老令牌没有 sid 时退回按 UA 指纹找(升级前登录的设备不会被当成新设备再提醒一次)。
function tc_device_is_trusted($user, $payload) {
    $list = (isset($user['sessions']) && is_array($user['sessions'])) ? $user['sessions'] : array();
    $sid = isset($payload['sid']) ? (string) $payload['sid'] : '';
    if ($sid !== '' && isset($list[$sid]) && is_array($list[$sid])) return !empty($list[$sid]['trusted']);
    $fp = tc_login_fingerprint();
    if ($fp === '') return false;
    foreach ($list as $row) {
        if (is_array($row) && !empty($row['trusted']) && (string) (isset($row['fp']) ? $row['fp'] : '') === $fp) return true;
    }
    return false;
}

// ============ 接口 ============

// GET /api/me/devices
function tc_api_me_devices() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $payload = tc_jwt_verify(tc_bearer());
        tc_json(200, array(
            'devices' => tc_devices_public($user, $payload ? $payload : array()),
            'limit' => TC_SESSIONS_MAX,
        ));
    });
}

// DELETE /api/me/devices/{sid}:退出某个设备。踢的是「当前这个」时等同退出登录。
function tc_api_me_device_revoke($sid) {
    $sid = substr(trim((string) $sid), 0, 64);
    if ($sid === '') tc_fail(400, '缺少设备标识');
    $isCurrent = false;
    tc_with_db(true, function (&$db) use ($sid, &$isCurrent) {
        $user = tc_require_auth($db);
        $payload = tc_jwt_verify(tc_bearer());
        $cur = $payload && isset($payload['sid']) ? (string) $payload['sid'] : '';
        foreach ($db['users'] as &$u) {
            if ((string) $u['id'] !== (string) $user['id']) continue;
            if (!isset($u['sessions']) || !is_array($u['sessions']) || !isset($u['sessions'][$sid])) {
                tc_fail(404, '该设备已下线');
            }
            unset($u['sessions'][$sid]);
            $isCurrent = ($cur !== '' && $cur === $sid);
            break;
        }
        unset($u);
        tc_log_auth_event('auth', $user['name'], '退出设备登录', $user['id']);
    });
    tc_json(200, array('ok' => true, 'current' => $isCurrent));
}

// POST /api/me/devices/{sid}/trust  {trusted: true|false}
// 把某台设备(按浏览器指纹,覆盖该指纹下的所有会话)标为常用设备 / 取消。
// 标可信后这份指纹上的新登录不再发「新设备登录」提醒邮件。
function tc_api_me_device_trust($sid) {
    $sid = substr(trim((string) $sid), 0, 64);
    if ($sid === '') tc_fail(400, '缺少设备标识');
    $b = tc_read_json_body(8192);
    $on = !empty($b['trusted']);
    $fp = '';
    tc_with_db(true, function (&$db) use ($sid, $on, &$fp) {
        $user = tc_require_auth($db);
        foreach ($db['users'] as &$u) {
            if ((string) $u['id'] !== (string) $user['id']) continue;
            if (!isset($u['sessions'][$sid]) || !is_array($u['sessions'][$sid])) tc_fail(404, '该设备已下线');
            $fp = (string) (isset($u['sessions'][$sid]['fp']) ? $u['sessions'][$sid]['fp'] : '');
            // 指纹相同 = 同一台机器:整台机器一起改,免得「这台可信、那台不可信」
            foreach ($u['sessions'] as $k => $row) {
                if (!is_array($row)) continue;
                if ((string) $k === $sid || ($fp !== '' && (string) (isset($row['fp']) ? $row['fp'] : '') === $fp)) {
                    $u['sessions'][$k]['trusted'] = $on;
                }
            }
            break;
        }
        unset($u);
        tc_log_auth_event('auth', $user['name'], $on ? '标记常用设备' : '取消常用设备', $user['id']);
    });
    tc_json(200, array('ok' => true, 'trusted' => $on));
}

// POST /api/me/devices/{sid}/label  {label: '我的笔记本'}
// 设备备注名:按指纹整台生效(同一台机器的多个会话共用一个名字,与「常用」同一口径)。
// 留空 = 清除备注,回退到按 UA 推导的名称。UA 厂商字符串(Chrome · Windows)对多设备
// 用户几乎无法区分,备注名才是让人认出「这是哪台机器」的抓手。
function tc_api_me_device_label($sid) {
    $sid = substr(trim((string) $sid), 0, 64);
    if ($sid === '') tc_fail(400, '缺少设备标识');
    $b = tc_read_json_body(8192);
    if (!isset($b['label']) || !is_string($b['label'])) tc_fail(400, '缺少备注内容');
    $label = trim((string) $b['label']);
    if (function_exists('mb_substr')) $label = mb_substr($label, 0, 40, 'UTF-8');
    else $label = substr($label, 0, 40);
    tc_with_db(true, function (&$db) use ($sid, $label) {
        $user = tc_require_auth($db);
        foreach ($db['users'] as &$u) {
            if ((string) $u['id'] !== (string) $user['id']) continue;
            if (!isset($u['sessions'][$sid]) || !is_array($u['sessions'][$sid])) tc_fail(404, '该设备已下线');
            $fp = (string) (isset($u['sessions'][$sid]['fp']) ? $u['sessions'][$sid]['fp'] : '');
            foreach ($u['sessions'] as $k => $row) {
                if (!is_array($row)) continue;
                if ((string) $k === $sid || ($fp !== '' && (string) (isset($row['fp']) ? $row['fp'] : '') === $fp)) {
                    if ($label === '') unset($u['sessions'][$k]['customName']);
                    else $u['sessions'][$k]['customName'] = $label;
                }
            }
            break;
        }
        unset($u);
        tc_log_auth_event('auth', $user['name'], $label === '' ? '清除设备备注' : '设置设备备注', $user['id']);
    });
    tc_json(200, array('ok' => true, 'label' => $label));
}

// DELETE /api/me/devices:退出除本机外的所有设备(保留当前 sid,当前会话不受影响)
function tc_api_me_devices_revoke_others() {
    $removed = 0;
    tc_with_db(true, function (&$db) use (&$removed) {
        $user = tc_require_auth($db);
        $payload = tc_jwt_verify(tc_bearer());
        $cur = $payload && isset($payload['sid']) ? (string) $payload['sid'] : '';
        foreach ($db['users'] as &$u) {
            if ((string) $u['id'] !== (string) $user['id']) continue;
            $keep = array();
            foreach ((isset($u['sessions']) && is_array($u['sessions']) ? $u['sessions'] : array()) as $sid => $row) {
                if ((string) $sid === $cur) { $keep[$sid] = $row; continue; }
                $removed++;
            }
            $u['sessions'] = $keep;
            break;
        }
        unset($u);
        if ($removed > 0) tc_log_auth_event('auth', $user['name'], '退出其它设备（' . $removed . ' 个）', $user['id']);
    });
    tc_json(200, array('ok' => true, 'removed' => $removed));
}

// POST /api/me/devices/revoke-all:全部设备下线(含本机),用于「怀疑账号被盗」。
// 等价于把 sessions 清空并递增 tv:所有已签发的令牌立即失效(wp 里的修改密码也走 tv)。
function tc_api_me_devices_revoke_all() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        foreach ($db['users'] as &$u) {
            if ((string) $u['id'] !== (string) $user['id']) continue;
            $u['sessions'] = array();
            $u['tv'] = (isset($u['tv']) ? (int) $u['tv'] : 0) + 1;
            break;
        }
        unset($u);
        tc_log_auth_event('auth', $user['name'], '强制全部设备下线', $user['id']);
    });
    tc_json(200, array('ok' => true));
}
